import path from "node:path";
import {
  Client,
  SSEClientTransport,
  StreamableHTTPClientTransport
} from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import type { DiscoveredMcpServer } from "./discovery";

type JsonRecord = Record<string, unknown>;
type CapabilityName = "tools" | "resources" | "prompts";

export interface MCPToolSnapshot {
  name: string;
  description?: string;
  inputSchema: unknown;
  outputSchema?: unknown;
  annotations?: unknown;
}

export interface MCPInspectionComparison {
  capability: CapabilityName;
  declared: boolean;
  observed: boolean | null;
  status: "consistent" | "missing" | "unexpected" | "not_checked";
}

export interface MCPInspectionOutcome {
  serverId: string;
  serverName: string;
  inspectedAt: string;
  success: boolean;
  transport: string;
  protocolEra?: "modern" | "legacy";
  protocolVersion?: string;
  serverInfo?: { name?: string; version?: string };
  instructions?: string;
  declaredCapabilities: string[];
  observedCapabilities: string[];
  capabilityComparisons: MCPInspectionComparison[];
  tools: MCPToolSnapshot[];
  errorSummary?: string;
}

export interface MCPInspectionTarget {
  server: DiscoveredMcpServer;
  config: JsonRecord;
}

const CONNECT_TIMEOUT_MS = 15_000;
const REQUEST_TIMEOUT_MS = 12_000;
const MAX_TOOLS = 500;
const MAX_SCHEMA_BYTES = 128 * 1024;
const MAX_DESCRIPTION_LENGTH = 4_000;

function asRecord(value: unknown): JsonRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return {};
  return value as JsonRecord;
}

function shortText(value: unknown, maxLength = MAX_DESCRIPTION_LENGTH): string | undefined {
  return typeof value === "string" && value.length > 0 ? value.slice(0, maxLength) : undefined;
}

function byteLength(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value), "utf8");
  } catch {
    return Number.MAX_SAFE_INTEGER;
  }
}

function boundedJson(value: unknown): unknown {
  if (byteLength(value) <= MAX_SCHEMA_BYTES) return value ?? {};
  return { $truncated: true, originalBytes: byteLength(value), reason: "schema exceeds storage limit" };
}

function expandEnvironment(value: string): string {
  return value.replace(/\$\{(?:env:)?([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_match, key: string, fallback?: string) => {
    const resolved = process.env[key];
    if (resolved !== undefined) return resolved;
    if (fallback !== undefined) return fallback;
    throw new Error("Required environment variable is unavailable.");
  });
}

function stringMap(value: unknown, label: string): Record<string, string> {
  const values = asRecord(value);
  const result: Record<string, string> = {};
  for (const [key, raw] of Object.entries(values)) {
    if (typeof raw !== "string") throw new Error("Invalid " + label + " configuration.");
    const expanded = expandEnvironment(raw);
    if (/[\r\n]/.test(expanded)) throw new Error("Invalid " + label + " value.");
    result[key] = expanded;
  }
  return result;
}

function inheritedEnvironment(): Record<string, string> {
  const allowed = process.platform === "win32"
    ? [
        "APPDATA", "COMSPEC", "HOMEDRIVE", "HOMEPATH", "LOCALAPPDATA", "PATH",
        "PATHEXT", "PROGRAMDATA", "PROGRAMFILES", "PROGRAMFILES(X86)",
        "PROGRAMW6432", "SYSTEMDRIVE", "SYSTEMROOT", "TEMP", "TMP", "USERPROFILE", "WINDIR"
      ]
    : ["HOME", "LOGNAME", "PATH", "SHELL", "TERM", "TMPDIR", "USER"];
  const result: Record<string, string> = {};
  for (const key of allowed) {
    const value = process.env[key];
    if (value !== undefined) result[key] = value;
  }
  return result;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error("Invalid MCP configuration: " + label + " is required.");
  }
  return value;
}

function buildTransport(target: MCPInspectionTarget) {
  const { server, config } = target;

  if (server.transport === "stdio") {
    const command = requiredString(config.command, "stdio command");
    const args = config.args ?? [];
    if (!Array.isArray(args) || args.some((item) => typeof item !== "string")) {
      throw new Error("Invalid MCP configuration: stdio args must be strings.");
    }
    const cwd = typeof config.cwd === "string" && config.cwd.trim().length > 0
      ? path.resolve(path.dirname(server.configPath), config.cwd)
      : undefined;
    return new StdioClientTransport({
      command,
      args: args as string[],
      env: { ...inheritedEnvironment(), ...stringMap(config.env, "stdio environment") },
      stderr: "ignore",
      ...(cwd ? { cwd } : {})
    });
  }

  if (server.transport !== "http" && server.transport !== "sse") {
    throw new Error("Unsupported MCP transport.");
  }

  const rawUrl = requiredString(config.url, "server URL");
  const url = new URL(rawUrl);
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("MCP endpoint must use HTTP or HTTPS.");
  if (url.username || url.password) throw new Error("MCP endpoint URLs must not embed credentials.");

  const headers = stringMap(config.headers, "HTTP header");
  const reserved = new Set([
    "host", "content-length", "connection", "transfer-encoding",
    "mcp-session-id", "mcp-protocol-version", "mcp-method", "mcp-name"
  ]);
  if (Object.keys(headers).some((name) => reserved.has(name.toLowerCase()))) {
    throw new Error("MCP configuration attempts to override a protocol-managed header.");
  }

  const requestInit: RequestInit = { headers, redirect: "error" };
  if (server.transport === "sse") {
    return new SSEClientTransport(url, {
      requestInit,
      redirectPolicy: "same-origin"
    });
  }
  return new StreamableHTTPClientTransport(url, {
    requestInit,
    redirectPolicy: "same-origin"
  });
}

async function withTimeout<T>(promise: Promise<T>, label: string, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(label + " timed out.")), timeoutMs);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function methodNotAvailable(error: unknown): boolean {
  const record = asRecord(error);
  const code = record.code;
  return code === -32601 ||
    code === "METHOD_NOT_FOUND" ||
    code === "CAPABILITY_NOT_SUPPORTED" ||
    (typeof code === "string" && /METHOD_NOT_FOUND|CAPABILITY_NOT_SUPPORTED/i.test(code));
}

function compareCapability(
  capability: CapabilityName,
  declared: boolean,
  observed: boolean | null
): MCPInspectionComparison {
  if (observed === null) return { capability, declared, observed, status: "not_checked" };
  if (declared && observed) return { capability, declared, observed, status: "consistent" };
  if (declared && !observed) return { capability, declared, observed, status: "missing" };
  if (!declared && observed) return { capability, declared, observed, status: "unexpected" };
  return { capability, declared, observed, status: "consistent" };
}

function errorSummary(error: unknown): string {
  const code = asRecord(error).code;
  if (typeof code === "number" || typeof code === "string") return "MCP error " + String(code).slice(0, 48);
  if (error instanceof Error && error.name && error.name !== "Error") return error.name.slice(0, 80);
  return "ConnectionError";
}

/**
 * Connects, negotiates current server/discover or legacy initialize, reads
 * declared catalogues and stores bounded metadata. No tools are invoked.
 */
export async function inspectMcpServer(target: MCPInspectionTarget): Promise<MCPInspectionOutcome> {
  const outcome: MCPInspectionOutcome = {
    serverId: target.server.id,
    serverName: target.server.name,
    inspectedAt: new Date().toISOString(),
    success: false,
    transport: target.server.transport,
    declaredCapabilities: [],
    observedCapabilities: [],
    capabilityComparisons: [],
    tools: []
  };
  const client = new Client(
    { name: "agent-trellis", version: "0.1.0" },
    { versionNegotiation: { mode: "auto", probe: { timeoutMs: 6_000 } } }
  );

  try {
    const transport = buildTransport(target);
    await withTimeout(client.connect(transport), "MCP protocol negotiation", CONNECT_TIMEOUT_MS);

    const capabilities = asRecord(client.getServerCapabilities());
    const declared = new Set(Object.keys(capabilities));
    const observed = new Set<CapabilityName>();
    outcome.declaredCapabilities = [...declared].sort() as string[];
    outcome.protocolEra = client.getProtocolEra();
    outcome.protocolVersion = client.getNegotiatedProtocolVersion();
    const info = client.getServerVersion();
    if (info) {
      outcome.serverInfo = {
        ...(shortText(info.name, 200) ? { name: shortText(info.name, 200) } : {}),
        ...(shortText(info.version, 100) ? { version: shortText(info.version, 100) } : {})
      };
    }
    outcome.instructions = shortText(client.getInstructions(), 2_000);

    const toolsDeclared = declared.has("tools");
    const resourcesDeclared = declared.has("resources");
    const promptsDeclared = declared.has("prompts");
    let toolsObserved: boolean | null = null;
    let resourcesObserved: boolean | null = null;
    let promptsObserved: boolean | null = null;

    if (toolsDeclared) {
      try {
        const result = await withTimeout(client.listTools(), "MCP tools/list", REQUEST_TIMEOUT_MS);
        if (!Array.isArray(result.tools) || result.tools.length > MAX_TOOLS) {
          throw new Error("Invalid or oversized tools/list response.");
        }
        toolsObserved = true;
        observed.add("tools");
        outcome.tools = result.tools.map((tool) => ({
          name: requiredString(tool.name, "tool name"),
          ...(shortText(tool.description) ? { description: shortText(tool.description) } : {}),
          inputSchema: boundedJson(tool.inputSchema),
          ...(tool.outputSchema ? { outputSchema: boundedJson(tool.outputSchema) } : {}),
          ...(tool.annotations ? { annotations: boundedJson(tool.annotations) } : {})
        }));
      } catch (error) {
        if (methodNotAvailable(error)) toolsObserved = false;
        else throw error;
      }
    }

    if (resourcesDeclared) {
      try {
        await withTimeout(client.listResources(), "MCP resources/list", REQUEST_TIMEOUT_MS);
        resourcesObserved = true;
        observed.add("resources");
      } catch (error) {
        if (methodNotAvailable(error)) resourcesObserved = false;
        else throw error;
      }
    }

    if (promptsDeclared) {
      try {
        await withTimeout(client.listPrompts(), "MCP prompts/list", REQUEST_TIMEOUT_MS);
        promptsObserved = true;
        observed.add("prompts");
      } catch (error) {
        if (methodNotAvailable(error)) promptsObserved = false;
        else throw error;
      }
    }

    outcome.observedCapabilities = [...observed].sort();
    outcome.capabilityComparisons = [
      compareCapability("tools", toolsDeclared, toolsObserved),
      compareCapability("resources", resourcesDeclared, resourcesObserved),
      compareCapability("prompts", promptsDeclared, promptsObserved)
    ];
    outcome.success = true;
  } catch (error) {
    outcome.errorSummary = errorSummary(error);
    outcome.success = false;
  } finally {
    await client.close().catch(() => {});
  }

  return outcome;
}
