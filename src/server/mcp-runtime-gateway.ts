import { randomUUID, timingSafeEqual } from "node:crypto";
import type { Request, Response } from "express";
import type { AgentGraph } from "./graph";
import type { ResolvedMcpServerConfig } from "./discovery";
import type { RuntimeEventType } from "./runtime-security";

const REQUEST_HEADERS = [
  "accept", "content-type", "mcp-session-id", "mcp-protocol-version",
  "last-event-id", "if-none-match"
];
const RESPONSE_HEADERS = [
  "content-type", "mcp-session-id", "mcp-protocol-version", "cache-control",
  "last-event-id", "retry-after", "etag", "vary"
];
const MAX_CAPTURE_BYTES = 256 * 1024;

export function runtimeTokenMatches(supplied: string, configured: string): boolean {
  const left = Buffer.from(configured);
  const right = Buffer.from(supplied);
  return left.length === right.length && timingSafeEqual(left, right);
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function expandEnvironment(value: string): string {
  return value.replace(/\$\{(?:env:)?([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_match, name: string, fallback?: string) => {
    const configured = process.env[name];
    if (configured !== undefined) return configured;
    if (fallback !== undefined) return fallback;
    throw new Error("A required upstream environment value is unavailable.");
  });
}

function upstreamHeaders(config: Record<string, unknown>, request: Request): Headers {
  const result = new Headers();
  const configured = record(config.headers);
  for (const [name, raw] of Object.entries(configured)) {
    if (typeof raw !== "string" || /^(?:host|content-length|connection|transfer-encoding|mcp-session-id|mcp-protocol-version|x-agent-trellis-token)$/i.test(name)) {
      throw new Error("The upstream MCP header configuration is invalid.");
    }
    result.set(name, expandEnvironment(raw));
  }
  for (const name of REQUEST_HEADERS) {
    const value = request.header(name);
    if (value !== undefined) result.set(name, value);
  }
  return result;
}

function requestUrl(target: ResolvedMcpServerConfig): URL {
  const raw = target.config.url;
  if (typeof raw !== "string") throw new Error("The configured MCP endpoint is unavailable.");
  const url = new URL(raw);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw new Error("The configured MCP endpoint is not a valid HTTP endpoint.");
  }
  const sanitized = url.origin + url.pathname;
  if (sanitized !== target.server.endpoint) {
    throw new Error("The MCP endpoint changed after discovery. Rediscover before routing traffic.");
  }
  return url;
}

function sameId(left: unknown, right: unknown): boolean {
  return (typeof left === "string" || typeof left === "number") && left === right;
}

function classifyResponse(body: string, requestId: unknown): { eventType: RuntimeEventType; errorCode?: string } | undefined {
  const candidates = [body.trim()];
  if (body.includes("data:")) {
    for (const line of body.split(/\r?\n/)) {
      if (line.startsWith("data:")) candidates.push(line.slice(5).trim());
    }
  }
  for (const candidate of candidates) {
    if (!candidate || candidate === "[DONE]") continue;
    try {
      const parsed: unknown = JSON.parse(candidate);
      const responses = Array.isArray(parsed) ? parsed : [parsed];
      const response = responses.map(record).find((item) => sameId(item.id, requestId));
      if (!response) continue;
      if (response.error !== undefined) return { eventType: "CALL_FAILED", errorCode: "JSONRPC_ERROR" };
      const result = record(response.result);
      if (result.isError === true) return { eventType: "CALL_FAILED", errorCode: "TOOL_RESULT_ERROR" };
      if (response.result !== undefined) return { eventType: "CALL_SUCCEEDED" };
    } catch {
      // Streaming or non-JSON output is deliberately left unclassified.
    }
  }
  return undefined;
}

async function readStreamAndForward(response: globalThis.Response, client: Response): Promise<string | undefined> {
  if (!response.body) {
    client.end();
    return "";
  }
  const reader = response.body.getReader();
  const captured: Uint8Array[] = [];
  let capturedBytes = 0;
  let overflow = false;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      const chunk = item.value;
      if (!overflow && capturedBytes + chunk.byteLength <= MAX_CAPTURE_BYTES) {
        captured.push(chunk);
        capturedBytes += chunk.byteLength;
      } else {
        overflow = true;
      }
      if (!client.write(Buffer.from(chunk))) {
        await new Promise<void>((resolve) => client.once("drain", resolve));
      }
    }
    client.end();
  } catch (error) {
    reader.cancel().catch(() => {});
    throw error;
  }
  if (overflow) return undefined;
  const joined = Buffer.concat(captured.map((part) => Buffer.from(part)));
  return joined.toString("utf8");
}

export interface RuntimeGatewayDependencies {
  resolve: (serverId: string) => ResolvedMcpServerConfig | null;
}
/**
 * Proxies configured Streamable HTTP MCP traffic. The gateway independently observes
 * the protocol request and correlated response, but cannot verify downstream
 * side effects performed by the remote MCP implementation.
 */
export async function handleMcpRuntimeGateway(
  request: Request,
  response: Response,
  graph: AgentGraph,
  dependencies: RuntimeGatewayDependencies
): Promise<void> {
  const serverIdParam = request.params.serverId;
  const serverId = Array.isArray(serverIdParam) ? (serverIdParam[0] ?? "") : serverIdParam;
  if (!serverId) {
    response.status(400).json({ error: "An MCP server ID is required." });
    return;
  }
  const configuredToken = process.env.AGENT_TRELLIS_RUNTIME_TOKEN;
  if (!configuredToken) {
    response.status(503).json({ error: "Runtime gateway is disabled until AGENT_TRELLIS_RUNTIME_TOKEN is configured." });
    return;
  }
  if (!runtimeTokenMatches(request.header("x-agent-trellis-token") ?? "", configuredToken)) {
    response.status(401).json({ error: "Invalid runtime gateway token." });
    return;
  }

  const discovered = graph.getDiscoveredMcpServers().find((server) => server.id === serverId);
  if (!discovered) {
    response.status(404).json({ error: "Discovered MCP server not found. Run MCP discovery again." });
    return;
  }
  if (discovered.transport !== "http") {
    response.status(400).json({ error: "The runtime gateway supports Streamable HTTP MCP servers only. Legacy SSE and stdio are not proxied." });
    return;
  }

  const target = dependencies.resolve(serverId);
  if (!target || target.server.endpoint !== discovered.endpoint || target.server.transport !== discovered.transport) {
    response.status(409).json({ error: "The MCP configuration changed after discovery. Run discovery again." });
    return;
  }

  let url: URL;
  let headers: Headers;
  try {
    url = requestUrl(target);
    headers = upstreamHeaders(target.config, request);
  } catch (error) {
    response.status(409).json({ error: error instanceof Error ? error.message : "Invalid upstream MCP configuration." });
    return;
  }

  const allowedMethods = new Set(["POST", "GET", "DELETE"]);
  if (!allowedMethods.has(request.method)) {
    response.status(405).json({ error: "Only POST, GET and DELETE MCP transport requests are supported." });
    return;
  }
  const jsonRpc = record(request.body);
  const params = record(jsonRpc.params);
  const isToolCall = request.method === "POST" &&
    jsonRpc.method === "tools/call" &&
    typeof params.name === "string" &&
    (typeof jsonRpc.id === "string" || typeof jsonRpc.id === "number");
  const executionId = isToolCall ? "gw_" + randomUUID() : undefined;
  const startedAt = Date.now();
  const toolName = isToolCall ? String(params.name).slice(0, 200) : undefined;
  const requestId = isToolCall ? jsonRpc.id : undefined;
  const event = (eventType: RuntimeEventType, durationMs?: number, errorCode?: string) => {
    if (!executionId || !toolName) return;
    graph.recordRuntimeEvent({
      eventId: "gw_" + randomUUID(),
      executionId,
      serverId,
      toolName,
      eventType,
      observedAt: new Date().toISOString(),
      ...(durationMs !== undefined ? { durationMs } : {}),
      ...(errorCode ? { errorCode } : {})
    }, "gateway_observed");
  };

  if (isToolCall) event("CALL_STARTED");
  let upstream: globalThis.Response;
  try {
    let body: string | undefined;
    if (request.method === "POST" && request.body !== undefined) body = JSON.stringify(request.body);
    upstream = await fetch(url, {
      method: request.method,
      headers,
      ...(body !== undefined ? { body } : {}),
      redirect: "manual"
    });
  } catch {
    if (isToolCall) event("CALL_FAILED", Date.now() - startedAt, "UPSTREAM_UNREACHABLE");
    response.status(502).json({ error: "The configured MCP server could not be reached." });
    return;
  }

  response.status(upstream.status);
  for (const name of RESPONSE_HEADERS) {
    const value = upstream.headers.get(name);
    if (value !== null) response.setHeader(name, value);
  }
  const cookies = (upstream.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie?.();
  if (cookies?.length) response.setHeader("set-cookie", cookies);
  try {
    const captured = await readStreamAndForward(upstream, response);
    if (isToolCall) {
      if (upstream.status < 200 || upstream.status >= 300) {
        event("CALL_FAILED", Date.now() - startedAt, "HTTP_" + upstream.status);
      } else if (captured !== undefined) {
        const outcome = classifyResponse(captured, requestId);
        if (outcome) event(outcome.eventType, Date.now() - startedAt, outcome.errorCode);
      }
    }
  } catch {
    if (isToolCall) event("CALL_FAILED", Date.now() - startedAt, "UPSTREAM_STREAM_FAILED");
    if (!response.headersSent) response.status(502).json({ error: "The MCP upstream stream failed." });
    else response.destroy();
  }
}
