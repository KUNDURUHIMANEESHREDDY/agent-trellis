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
const MAX_SSE_EVENT_BYTES = 256 * 1024;
const TOOL_CALL_TIMEOUT_MS = 60_000;

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

function makeEventRecorder(
  graph: AgentGraph,
  serverId: string,
  toolName: string,
  executionId: string
) {
  let started = false;
  let terminal = false;
  const recordEvent = (eventType: RuntimeEventType, errorCode?: string) => {
    if (terminal || (eventType === "CALL_STARTED" && started) || (eventType !== "CALL_STARTED" && !started)) return false;
    const result = graph.recordRuntimeEvent({
      eventId: "gw_" + randomUUID(),
      executionId,
      serverId,
      toolName,
      eventType,
      observedAt: new Date().toISOString(),
      ...(errorCode ? { errorCode } : {})
    }, "gateway_observed");
    if (result.ok) {
      if (eventType === "CALL_STARTED") started = true;
      else terminal = true;
    }
    return Boolean(result.ok);
  };
  return { recordEvent, isTerminal: () => terminal };
}

type ResponseClassification =
  | { eventType: "CALL_SUCCEEDED" | "CALL_FAILED"; errorCode?: string }
  | { eventType: "CALL_OUTCOME_UNKNOWN"; errorCode: string };

function classifyJsonRpcResponse(value: unknown, requestId: unknown): ResponseClassification {
  const items = Array.isArray(value) ? value : [value];
  const response = items.map(record).find((item) =>
    (typeof item.id === "string" || typeof item.id === "number") && item.id === requestId
  );
  if (!response) return { eventType: "CALL_OUTCOME_UNKNOWN", errorCode: "UNCORRELATED_RESPONSE" };
  if (response.error !== undefined) return { eventType: "CALL_FAILED", errorCode: "JSONRPC_ERROR" };
  const result = record(response.result);
  if (result.isError === true) return { eventType: "CALL_FAILED", errorCode: "TOOL_RESULT_ERROR" };
  if (response.result !== undefined) return { eventType: "CALL_SUCCEEDED" };
  return { eventType: "CALL_OUTCOME_UNKNOWN", errorCode: "RESPONSE_WITHOUT_RESULT" };
}

function classifyJsonText(body: string, requestId: unknown): ResponseClassification {
  try {
    return classifyJsonRpcResponse(JSON.parse(body), requestId);
  } catch {
    const streamMessages: unknown[] = [];
    for (const line of body.split(/\r?\n/)) {
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (!data || data === "[DONE]") continue;
      try {
        streamMessages.push(JSON.parse(data));
      } catch {
        // Ignore non-JSON SSE metadata lines; the call becomes unknown if no correlated message is found.
      }
    }
    if (streamMessages.length > 0) return classifyJsonRpcResponse(streamMessages, requestId);
    return { eventType: "CALL_OUTCOME_UNKNOWN", errorCode: "UNPARSEABLE_RESPONSE" };
  }
}

async function forwardResponseBody(
  upstream: globalThis.Response,
  downstream: Response,
  capture: boolean
): Promise<{ capturedText?: string; tooLarge: boolean }> {
  if (!upstream.body) {
    downstream.end();
    return { ...(capture ? { capturedText: "" } : {}), tooLarge: false };
  }
  const reader = upstream.body.getReader();
  const captured: Uint8Array[] = [];
  let capturedBytes = 0;
  let tooLarge = false;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      const chunk = item.value;
      if (capture && !tooLarge) {
        if (capturedBytes + chunk.byteLength <= MAX_CAPTURE_BYTES) {
          captured.push(chunk);
          capturedBytes += chunk.byteLength;
        } else {
          tooLarge = true;
          captured.length = 0;
        }
      }
      if (!downstream.destroyed && !downstream.write(Buffer.from(chunk))) {
        await new Promise<void>((resolve) => downstream.once("drain", resolve));
      }
    }
    if (!downstream.writableEnded && !downstream.destroyed) downstream.end();
  } catch (error) {
    reader.cancel().catch(() => {});
    throw error;
  }
  if (!capture || tooLarge) return { tooLarge };
  return {
    capturedText: Buffer.concat(captured.map((part) => Buffer.from(part))).toString("utf8"),
    tooLarge: false
  };
}

export interface RuntimeGatewayDependencies {
  resolve: (serverId: string) => ResolvedMcpServerConfig | null;
}

function authorizedTarget(
  request: Request,
  response: Response,
  graph: AgentGraph,
  dependencies: RuntimeGatewayDependencies,
  transport: "http" | "sse"
): ResolvedMcpServerConfig | null {
  const serverIdParam = request.params.serverId;
  const serverId = Array.isArray(serverIdParam) ? (serverIdParam[0] ?? "") : serverIdParam;
  const configuredToken = process.env.AGENT_TRELLIS_RUNTIME_TOKEN;
  if (!configuredToken) {
    response.status(503).json({ error: "Runtime gateway is disabled until AGENT_TRELLIS_RUNTIME_TOKEN is configured." });
    return null;
  }
  if (!runtimeTokenMatches(request.header("x-agent-trellis-token") ?? "", configuredToken)) {
    response.status(401).json({ error: "Invalid runtime gateway token." });
    return null;
  }
  const discovered = graph.getDiscoveredMcpServers().find((server) => server.id === serverId);
  if (!discovered) {
    response.status(404).json({ error: "Discovered MCP server not found. Run MCP discovery again." });
    return null;
  }
  if (discovered.transport !== transport) {
    response.status(400).json({
      error: transport === "http"
        ? "This route requires a Streamable HTTP MCP server."
        : "This route requires a legacy SSE MCP server."
    });
    return null;
  }
  const target = dependencies.resolve(serverId);
  if (!target || target.server.endpoint !== discovered.endpoint || target.server.transport !== discovered.transport) {
    response.status(409).json({ error: "The MCP configuration changed after discovery. Run discovery again." });
    return null;
  }
  try {
    requestUrl(target);
  } catch {
    response.status(409).json({ error: "The configured MCP endpoint is invalid or changed after discovery." });
    return null;
  }
  return target;
}

export async function handleStreamableHttpGateway(
  request: Request,
  response: Response,
  graph: AgentGraph,
  dependencies: RuntimeGatewayDependencies
): Promise<void> {
  const target = authorizedTarget(request, response, graph, dependencies, "http");
  if (!target) return;
  if (!["POST", "GET", "DELETE"].includes(request.method)) {
    response.status(405).json({ error: "Only POST, GET and DELETE MCP transport requests are supported." });
    return;
  }

  const jsonRpc = record(request.body);
  const params = record(jsonRpc.params);
  const isToolCall = request.method === "POST" &&
    jsonRpc.method === "tools/call" &&
    typeof params.name === "string" &&
    (typeof jsonRpc.id === "string" || typeof jsonRpc.id === "number");
  const startedAt = Date.now();
  const recorder = isToolCall
    ? makeEventRecorder(graph, target.server.id, String(params.name).slice(0, 200), "gw_" + randomUUID())
    : undefined;
  if (recorder && !recorder.recordEvent("CALL_STARTED")) {
    response.status(409).json({ error: "The gateway could not persist a start event for this MCP tool call." });
    return;
  }

  const controller = new AbortController();
  let clientDisconnected = false;
  const onClose = () => {
    if (!response.writableEnded) {
      clientDisconnected = true;
      controller.abort();
    }
  };
  response.once("close", onClose);
  const timeout = recorder
    ? setTimeout(() => controller.abort(new Error("MCP tool call timed out.")), TOOL_CALL_TIMEOUT_MS)
    : undefined;

  try {
    const url = requestUrl(target);
    const headers = upstreamHeaders(target.config, request);
    const body = request.method === "POST" && request.body !== undefined
      ? JSON.stringify(request.body)
      : undefined;
    const upstream = await fetch(url, {
      method: request.method,
      headers,
      ...(body !== undefined ? { body } : {}),
      redirect: "manual",
      signal: controller.signal
    });

    response.status(upstream.status);
    for (const name of RESPONSE_HEADERS) {
      const value = upstream.headers.get(name);
      if (value !== null) response.setHeader(name, value);
    }
    const cookies = (upstream.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie?.();
    if (cookies?.length) response.setHeader("set-cookie", cookies);

    if (!recorder) {
      await forwardResponseBody(upstream, response, false);
      return;
    }
    if (upstream.status < 200 || upstream.status >= 300) {
      await forwardResponseBody(upstream, response, false);
      recorder.recordEvent("CALL_FAILED", "HTTP_" + upstream.status);
      return;
    }

    const forwarded = await forwardResponseBody(upstream, response, true);
    if (forwarded.tooLarge) {
      recorder.recordEvent("CALL_OUTCOME_UNKNOWN", "RESPONSE_TOO_LARGE");
    } else {
      const classification = classifyJsonText(forwarded.capturedText ?? "", jsonRpc.id);
      recorder.recordEvent(classification.eventType, classification.errorCode);
    }
  } catch (error) {
    if (recorder && !recorder.isTerminal()) {
      if (clientDisconnected) recorder.recordEvent("CALL_OUTCOME_UNKNOWN", "CLIENT_DISCONNECTED");
      else if (controller.signal.aborted) recorder.recordEvent("CALL_OUTCOME_UNKNOWN", "UPSTREAM_TIMEOUT_OR_ABORT");
      else recorder.recordEvent("CALL_OUTCOME_UNKNOWN", "UPSTREAM_OR_STREAM_FAILURE");
    }
    if (!response.headersSent && !response.destroyed) {
      response.status(502).json({ error: "The configured MCP server could not complete this request." });
    } else if (!response.writableEnded && !response.destroyed) {
      response.end();
    }
  } finally {
    if (timeout) clearTimeout(timeout);
    response.off("close", onClose);
  }
}

interface PendingSseCall {
  requestId: string | number;
  timer: NodeJS.Timeout;
  recorder: ReturnType<typeof makeEventRecorder>;
}

interface LegacySseSession {
  id: string;
  serverId: string;
  upstreamUrl: URL;
  target: ResolvedMcpServerConfig;
  abort: AbortController;
  response: Response;
  messageUrl?: URL;
  pending: Map<string, PendingSseCall>;
  closed: boolean;
}

const legacySseSessions = new Map<string, LegacySseSession>();

function rpcIdKey(id: string | number): string {
  return typeof id + ":" + String(id);
}

function completeSseCall(
  session: LegacySseSession,
  key: string,
  eventType: RuntimeEventType,
  errorCode?: string
): void {
  const pending = session.pending.get(key);
  if (!pending) return;
  clearTimeout(pending.timer);
  session.pending.delete(key);
  pending.recorder.recordEvent(eventType, errorCode);
}

function completeAllSseCalls(session: LegacySseSession, errorCode: string): void {
  for (const key of [...session.pending.keys()]) {
    completeSseCall(session, key, "CALL_OUTCOME_UNKNOWN", errorCode);
  }
}

function parseSseBlock(block: string): { event: string; data: string } {
  let event = "message";
  const data: string[] = [];
  for (const line of block.split(/\r?\n/)) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
  }
  return { event, data: data.join("\n") };
}

function handleLegacySseMessage(session: LegacySseSession, block: string): string {
  const parsed = parseSseBlock(block);
  if (parsed.event === "message" && Buffer.byteLength(block, "utf8") > MAX_SSE_EVENT_BYTES) {
    completeAllSseCalls(session, "RESPONSE_TOO_LARGE");
    return block + "\n\n";
  }
  if (parsed.event === "endpoint") {
    try {
      const messageUrl = new URL(parsed.data, session.upstreamUrl);
      if (messageUrl.origin !== session.upstreamUrl.origin || messageUrl.username || messageUrl.password) {
        completeAllSseCalls(session, "SSE_MESSAGE_ENDPOINT_REJECTED");
        return "event: error\ndata: Invalid upstream MCP message endpoint\n\n";
      }
      session.messageUrl = messageUrl;
      const rewritten = "/api/runtime/mcp/" + encodeURIComponent(session.serverId) +
        "/messages/" + encodeURIComponent(session.id);
      return block.replace(/(^|\r?\n)data:[^\r\n]*/m, "$1data: " + rewritten) + "\n\n";
    } catch {
      completeAllSseCalls(session, "SSE_MESSAGE_ENDPOINT_INVALID");
      return "event: error\ndata: Invalid upstream MCP message endpoint\n\n";
    }
  }

  if (parsed.event === "message" && parsed.data.trim()) {
    try {
      const value: unknown = JSON.parse(parsed.data);
      const items = Array.isArray(value) ? value : [value];
      let matched = 0;
      let uncorrelated = 0;
      for (const item of items) {
        const message = record(item);
        if (typeof message.id !== "string" && typeof message.id !== "number") continue;
        const key = rpcIdKey(message.id);
        if (!session.pending.has(key)) {
          uncorrelated += 1;
          continue;
        }
        const classification = classifyJsonRpcResponse(message, message.id);
        completeSseCall(session, key, classification.eventType, classification.errorCode);
        matched += 1;
      }
      if ((matched === 0 || uncorrelated > 0) && session.pending.size > 0) {
        completeAllSseCalls(session, "UNCORRELATED_RESPONSE");
      }
    } catch {
      completeAllSseCalls(session, "UNPARSEABLE_RESPONSE");
    }
  }
  return block + "\n\n";
}

async function writeSseBlock(response: Response, block: string): Promise<void> {
  if (response.destroyed || response.writableEnded) return;
  if (!response.write(block)) {
    await new Promise<void>((resolve) => response.once("drain", resolve));
  }
}

export async function handleLegacySseGateway(
  request: Request,
  response: Response,
  graph: AgentGraph,
  dependencies: RuntimeGatewayDependencies
): Promise<void> {
  if (request.method !== "GET") {
    response.status(405).json({ error: "Legacy SSE MCP sessions must be opened with GET." });
    return;
  }
  const target = authorizedTarget(request, response, graph, dependencies, "sse");
  if (!target) return;

  const upstreamUrl = requestUrl(target);
  const headers = upstreamHeaders(target.config, request);
  headers.set("accept", "text/event-stream");
  const abort = new AbortController();
  let upstream: globalThis.Response;
  try {
    upstream = await fetch(upstreamUrl, { method: "GET", headers, redirect: "manual", signal: abort.signal });
  } catch {
    response.status(502).json({ error: "The legacy MCP SSE endpoint could not be reached." });
    return;
  }
  if (!upstream.ok || !upstream.body) {
    response.status(upstream.status || 502).json({ error: "The legacy MCP SSE endpoint did not open a stream." });
    return;
  }
  const contentType = upstream.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("text/event-stream")) {
    await upstream.body.cancel().catch(() => {});
    response.status(502).json({ error: "The legacy MCP server did not return an event stream." });
    return;
  }

  const session: LegacySseSession = {
    id: randomUUID(),
    serverId: target.server.id,
    upstreamUrl,
    target,
    abort,
    response,
    pending: new Map(),
    closed: false
  };
  legacySseSessions.set(session.id, session);
  response.status(200);
  response.setHeader("content-type", "text/event-stream; charset=utf-8");
  response.setHeader("cache-control", "no-cache, no-transform");
  response.setHeader("connection", "keep-alive");

  const onClose = () => {
    if (!response.writableEnded) {
      session.closed = true;
      abort.abort();
      completeAllSseCalls(session, "SSE_CLIENT_DISCONNECTED");
    }
  };
  response.once("close", onClose);

  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      buffer += decoder.decode(next.value, { stream: true });
      let boundary = buffer.search(/\r?\n\r?\n/);
      while (boundary >= 0) {
        const separator = buffer.slice(boundary).match(/^\r?\n\r?\n/)?.[0] ?? "\n\n";
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + separator.length);
        await writeSseBlock(response, handleLegacySseMessage(session, block));
        boundary = buffer.search(/\r?\n\r?\n/);
      }
      if (Buffer.byteLength(buffer, "utf8") > MAX_SSE_EVENT_BYTES) {
        const eventLine = buffer.split(/\r?\n/).find((line) => line.startsWith("event:"));
        const hasDataLine = buffer.split(/\r?\n/).some((line) => line.startsWith("data:"));
        const isMessageEvent = eventLine
          ? eventLine.slice(6).trim() === "message"
          : hasDataLine;
        if (isMessageEvent) {
          completeAllSseCalls(session, "RESPONSE_TOO_LARGE");
          await writeSseBlock(response, buffer);
          buffer = "";
          session.closed = true;
          abort.abort();
          break;
        }
        await writeSseBlock(response, buffer);
        buffer = "";
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) await writeSseBlock(response, handleLegacySseMessage(session, buffer));
    if (!session.closed) completeAllSseCalls(session, "SSE_STREAM_CLOSED");
  } catch {
    completeAllSseCalls(session, session.closed ? "SSE_CLIENT_DISCONNECTED" : "SSE_STREAM_FAILED");
  } finally {
    session.closed = true;
    abort.abort();
    reader.cancel().catch(() => {});
    legacySseSessions.delete(session.id);
    response.off("close", onClose);
    if (!response.writableEnded && !response.destroyed) response.end();
  }
}

export async function handleLegacySseMessageGateway(
  request: Request,
  response: Response,
  graph: AgentGraph,
  dependencies: RuntimeGatewayDependencies
): Promise<void> {
  const configuredToken = process.env.AGENT_TRELLIS_RUNTIME_TOKEN;
  if (!configuredToken) {
    response.status(503).json({ error: "Runtime gateway is disabled until AGENT_TRELLIS_RUNTIME_TOKEN is configured." });
    return;
  }
  if (!runtimeTokenMatches(request.header("x-agent-trellis-token") ?? "", configuredToken)) {
    response.status(401).json({ error: "Invalid runtime gateway token." });
    return;
  }
  const sessionIdParam = request.params.sessionId;
  const sessionId = Array.isArray(sessionIdParam) ? sessionIdParam[0] : sessionIdParam;
  const session = legacySseSessions.get(sessionId ?? "");
  if (!session || session.closed || session.serverId !== request.params.serverId || !session.messageUrl) {
    response.status(404).json({ error: "Legacy MCP SSE session is missing or closed. Reconnect to the SSE endpoint." });
    return;
  }
  if (request.method !== "POST") {
    response.status(405).json({ error: "Legacy MCP message endpoints accept POST only." });
    return;
  }

  const message = record(request.body);
  const params = record(message.params);
  const isToolCall = message.method === "tools/call" &&
    typeof params.name === "string" &&
    (typeof message.id === "string" || typeof message.id === "number");
  const key = isToolCall ? rpcIdKey(message.id as string | number) : undefined;
  if (key && session.pending.has(key)) {
    response.status(409).json({ error: "A tool call with this JSON-RPC ID is already pending." });
    return;
  }
  let pending: PendingSseCall | undefined;
  if (key) {
    const recorder = makeEventRecorder(graph, session.serverId, String(params.name).slice(0, 200), "gw_" + randomUUID());
    if (!recorder.recordEvent("CALL_STARTED")) {
      response.status(409).json({ error: "The gateway could not persist a start event for this MCP tool call." });
      return;
    }
    const timer = setTimeout(() => {
      completeSseCall(session, key, "CALL_OUTCOME_UNKNOWN", "SSE_RESPONSE_TIMEOUT");
    }, TOOL_CALL_TIMEOUT_MS);
    pending = { requestId: message.id as string | number, timer, recorder };
    session.pending.set(key, pending);
  }

  try {
    const headers = upstreamHeaders(session.target.config, request);
    const upstream = await fetch(session.messageUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(request.body),
      redirect: "manual",
      signal: session.abort.signal
    });
    response.status(upstream.status);
    for (const name of RESPONSE_HEADERS) {
      const value = upstream.headers.get(name);
      if (value !== null) response.setHeader(name, value);
    }
    const forwarded = await forwardResponseBody(upstream, response, Boolean(pending));
    if (pending && key && forwarded.tooLarge) {
      completeSseCall(session, key, "CALL_OUTCOME_UNKNOWN", "RESPONSE_TOO_LARGE");
    } else if (pending && key && (upstream.status < 200 || upstream.status >= 300)) {
      completeSseCall(session, key, "CALL_FAILED", "HTTP_" + upstream.status);
    } else if (pending && key && forwarded.capturedText) {
      const classification = classifyJsonText(forwarded.capturedText, pending.requestId);
      if (classification.eventType !== "CALL_OUTCOME_UNKNOWN" || classification.errorCode !== "UNPARSEABLE_RESPONSE") {
        completeSseCall(session, key, classification.eventType, classification.errorCode);
      }
    }
  } catch {
    if (pending && key) completeSseCall(session, key, "CALL_OUTCOME_UNKNOWN", "SSE_MESSAGE_POST_FAILED");
    if (!response.headersSent) response.status(502).json({ error: "The legacy MCP message endpoint could not be reached." });
    else if (!response.writableEnded && !response.destroyed) response.end();
  }
}

export async function handleMcpRuntimeGateway(
  request: Request,
  response: Response,
  graph: AgentGraph,
  dependencies: RuntimeGatewayDependencies
): Promise<void> {
  const serverIdParam = request.params.serverId;
  const serverId = Array.isArray(serverIdParam) ? serverIdParam[0] : serverIdParam;
  const discovered = graph.getDiscoveredMcpServers().find((server) => server.id === serverId);
  if (discovered?.transport === "sse") {
    await handleLegacySseGateway(request, response, graph, dependencies);
    return;
  }
  await handleStreamableHttpGateway(request, response, graph, dependencies);
}
