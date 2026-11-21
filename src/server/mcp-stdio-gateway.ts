import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import type { ResolvedMcpServerConfig } from "./discovery";
import { resolveMcpServerConfig } from "./discovery";

const TOOL_CALL_TIMEOUT_MS = 60_000;
const MAX_PROTOCOL_MESSAGE_BYTES = 256 * 1024;
const IGNORED_DIRECTORY_NAMES = new Set([".git", "node_modules", ".venv", ".next", ".cache", "dist", "build", ".data"]);

type RpcRequest = { id: string | number; toolName: string };
type PendingCall = RpcRequest & { executionId: string; startedAt: number; timer: NodeJS.Timeout };

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function rpcIdKey(id: string | number): string {
  return typeof id + ":" + String(id);
}

function parseToolCalls(value: unknown): RpcRequest[] {
  const messages = Array.isArray(value) ? value : [value];
  return messages.flatMap((item) => {
    const message = asRecord(item);
    const params = asRecord(message.params);
    if (message.method !== "tools/call" ||
        typeof params.name !== "string" ||
        (typeof message.id !== "string" && typeof message.id !== "number")) return [];
    return [{ id: message.id, toolName: params.name.slice(0, 200) }];
  });
}

function classifyResponse(message: Record<string, unknown>): { eventType: "CALL_SUCCEEDED" | "CALL_FAILED" | "CALL_OUTCOME_UNKNOWN"; errorCode?: string } {
  if (message.error !== undefined) return { eventType: "CALL_FAILED", errorCode: "JSONRPC_ERROR" };
  const result = asRecord(message.result);
  if (result.isError === true) return { eventType: "CALL_FAILED", errorCode: "TOOL_RESULT_ERROR" };
  if (message.result !== undefined) return { eventType: "CALL_SUCCEEDED" };
  return { eventType: "CALL_OUTCOME_UNKNOWN", errorCode: "RESPONSE_WITHOUT_RESULT" };
}

function expandEnvironment(value: string): string {
  return value.replace(/\$\{(?:env:)?([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_match, name: string, fallback?: string) => {
    const configured = process.env[name];
    if (configured !== undefined) return configured;
    if (fallback !== undefined) return fallback;
    throw new Error("A required stdio MCP environment value is unavailable.");
  });
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

function childConfiguration(target: ResolvedMcpServerConfig) {
  if (target.server.transport !== "stdio") throw new Error("The selected MCP server is not a stdio server.");
  if (typeof target.config.command !== "string" || !target.config.command.trim()) {
    throw new Error("The stdio MCP command is missing.");
  }
  const rawArgs = target.config.args ?? [];
  if (!Array.isArray(rawArgs) || rawArgs.some((item) => typeof item !== "string")) {
    throw new Error("The stdio MCP arguments are invalid.");
  }
  const rawEnv = asRecord(target.config.env);
  if (Object.values(rawEnv).some((item) => typeof item !== "string")) {
    throw new Error("The stdio MCP environment is invalid.");
  }
  const cwd = typeof target.config.cwd === "string" && target.config.cwd.trim()
    ? path.resolve(path.dirname(target.server.configPath), target.config.cwd)
    : path.dirname(target.server.configPath);
  return {
    command: expandEnvironment(target.config.command),
    args: (rawArgs as string[]).map(expandEnvironment),
    cwd,
    env: {
      ...inheritedEnvironment(),
      ...Object.fromEntries(Object.entries(rawEnv)
        .filter(([key]) => !/^AGENT_TRELLIS_RUNTIME_/i.test(key) &&
          key.toUpperCase() !== "AGENT_TRELLIS_API_URL" &&
          key.toUpperCase() !== "AGENT_TRELLIS_WORKSPACES")
        .map(([key, value]) => [key, expandEnvironment(value as string)]))
    }
  };
}

interface FilesystemObservation {
  eventCount: number;
  correlation: "single_active_call" | "multiple_active_calls" | "no_active_call" | "ambiguous";
  executionId?: string;
  toolName?: string;
  observedAt: string;
}

export interface FilesystemObserver {
  ready: Promise<void>;
  stop(): Promise<void>;
}

export function startHostFilesystemObserver(
  roots: string[],
  activeCalls: () => Array<{ executionId: string; toolName: string }>,
  onObservation: (observation: FilesystemObservation) => void | Promise<void>,
  options: { debounceMs?: number; maxDirectories?: number } = {}
): FilesystemObserver {
  const watchers: fs.FSWatcher[] = [];
  const visited = new Set<string>();
  const debounceMs = options.debounceMs ?? 250;
  const maxDirectories = options.maxDirectories ?? 1500;
  let stopped = false;
  let pendingEvents = 0;
  let sawMultiple = false;
  let sawNoActiveCall = false;
  const activeIds = new Map<string, { executionId: string; toolName: string }>();
  let flushTimer: NodeJS.Timeout | undefined;
  let reporting = Promise.resolve();
  let stopPromise: Promise<void> | undefined;

  const flush = (force = false): Promise<void> => {
    flushTimer = undefined;
    if (pendingEvents === 0 || (stopped && !force)) return reporting;
    const calls = [...activeIds.values()];
    const correlation = sawMultiple || calls.length > 1
      ? "multiple_active_calls"
      : sawNoActiveCall && calls.length > 0 ? "ambiguous"
      : calls.length === 1 ? "single_active_call" : "no_active_call";
    const observation: FilesystemObservation = {
      eventCount: pendingEvents,
      correlation,
      observedAt: new Date().toISOString(),
      ...(correlation === "single_active_call" ? calls[0] : {})
    };
    pendingEvents = 0;
    sawMultiple = false;
    sawNoActiveCall = false;
    activeIds.clear();
    reporting = reporting.then(() => onObservation(observation)).catch(() => {});
    return reporting;
  };

  const noteChange = (eventType: string, filename: string | Buffer | null) => {
    if (stopped) return;
    const name = filename?.toString() ?? "";
    if (name.split(/[\\/]/).some((part) => IGNORED_DIRECTORY_NAMES.has(part))) return;
    pendingEvents += 1;
    const calls = activeCalls();
    if (calls.length === 0) sawNoActiveCall = true;
    if (calls.length > 1) sawMultiple = true;
    for (const call of calls) activeIds.set(call.executionId, call);
    if (!flushTimer) flushTimer = setTimeout(() => { void flush().catch(() => {}); }, debounceMs);
    void eventType;
  };

  const watchTree = async (root: string, depth = 0): Promise<void> => {
    if (stopped || depth > 16 || visited.size >= maxDirectories) return;
    let resolved: string;
    try {
      const linkInfo = await fs.promises.lstat(root);
      if (linkInfo.isSymbolicLink() || !linkInfo.isDirectory()) return;
      resolved = await fs.promises.realpath(root);
      const stat = await fs.promises.stat(resolved);
      if (!stat.isDirectory() || visited.has(resolved)) return;
    } catch {
      return;
    }
    visited.add(resolved);
    try {
      const watcher = fs.watch(resolved, (eventType, filename) => {
        noteChange(eventType, filename);
        if (eventType === "rename" && filename) {
          const createdPath = path.resolve(resolved, filename.toString());
          if (path.dirname(createdPath) === resolved) {
            setTimeout(() => { void watchTree(createdPath, depth + 1); }, 150);
          }
        }
      });
      watcher.on("error", () => watcher.close());
      watchers.push(watcher);
    } catch {
      return;
    }

    let entries: fs.Dirent[] = [];
    try {
      entries = await fs.promises.readdir(resolved, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory() && !entry.isSymbolicLink() && !IGNORED_DIRECTORY_NAMES.has(entry.name)) {
        await watchTree(path.join(resolved, entry.name), depth + 1);
      }
      if (stopped || visited.size >= maxDirectories) break;
    }
  };

  const ready = Promise.all([...new Set(roots.map((value) => path.resolve(value)))].map((root) => watchTree(root))).then(() => undefined);
  return {
    ready,
    stop() {
      if (stopPromise) return stopPromise;
      stopped = true;
      if (flushTimer) clearTimeout(flushTimer);
      flushTimer = undefined;
      for (const watcher of watchers) watcher.close();
      watchers.length = 0;
      stopPromise = flush(true);
      return stopPromise;
    }
  };
}

export interface StdioRuntimeGatewayOptions {
  target: ResolvedMcpServerConfig;
  apiUrl: string;
  gatewayToken: string;
  observerToken?: string;
  watchFilesystem?: boolean;
  watchPaths?: string[];
  input?: Readable;
  output?: Writable;
  errorOutput?: Writable;
  spawnProcess?: typeof spawn;
  callTimeoutMs?: number;
}

export async function runStdioRuntimeGateway(options: StdioRuntimeGatewayOptions): Promise<void> {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const errorOutput = options.errorOutput ?? process.stderr;
  const spawnProcess = options.spawnProcess ?? spawn;
  const apiUrl = options.apiUrl.replace(/\/+$/, "");
  const configured = childConfiguration(options.target);
  const child = spawnProcess(configured.command, configured.args, {
    cwd: configured.cwd,
    env: configured.env,
    stdio: ["pipe", "pipe", "ignore"],
    windowsHide: true,
    shell: false
  });
  if (!child.stdin || !child.stdout) throw new Error("The stdio MCP process did not expose pipe streams.");
  const childStdin = child.stdin;
  const childStdout = child.stdout;

  const pending = new Map<string, PendingCall>();
  let childClosed = false;
  let processingInput = Promise.resolve();
  let shutdownPromise: Promise<void> = Promise.resolve();
  const timeoutMs = options.callTimeoutMs ?? TOOL_CALL_TIMEOUT_MS;

  const postJson = async (url: string, tokenHeader: string, token: string, body: unknown): Promise<void> => {
    const response = await fetch(apiUrl + url, {
      method: "POST",
      headers: { "content-type": "application/json", [tokenHeader]: token },
      body: JSON.stringify(body)
    });
    if (!response.ok) throw new Error("AgentTrellis rejected a runtime observation (" + response.status + ").");
  };

  const reportGatewayEvent = async (call: PendingCall, eventType: string, errorCode?: string) => {
    await postJson("/api/runtime/gateway-events", "x-agent-trellis-gateway-token", options.gatewayToken, {
      eventId: "stdio-gw_" + randomUUID(),
      executionId: call.executionId,
      serverId: options.target.server.id,
      toolName: call.toolName,
      eventType,
      observedAt: new Date().toISOString(),
      durationMs: Math.min(3_600_000, Math.max(0, Date.now() - call.startedAt)),
      ...(errorCode ? { errorCode } : {})
    });
  };

  const reportFilesystemObservation = async (observation: FilesystemObservation) => {
    if (!options.observerToken) return;
    await postJson("/api/runtime/independent-observations", "x-agent-trellis-observer-token", options.observerToken, {
      observationId: "fs_" + randomUUID(),
      serverId: options.target.server.id,
      effect: "filesystem_write",
      observer: "host-filesystem-watcher",
      observedAt: observation.observedAt,
      eventCount: observation.eventCount,
      correlation: observation.correlation,
      ...(observation.executionId ? { executionId: observation.executionId } : {}),
      ...(observation.toolName ? { toolName: observation.toolName } : {})
    });
  };

  const activeCalls = () => [...pending.values()].map((call) => ({
    executionId: call.executionId,
    toolName: call.toolName
  }));

  const filesystemRoots = options.watchFilesystem
    ? [...new Set([configured.cwd, ...(options.watchPaths ?? [])].map((root) => path.resolve(root)))]
    : [];
  const filesystemObserver = options.watchFilesystem && options.observerToken
    ? startHostFilesystemObserver(filesystemRoots, activeCalls, (observation) => {
        return reportFilesystemObservation(observation).catch((error) => {
          errorOutput.write("AgentTrellis filesystem observer: " + (error instanceof Error ? error.message : "report failed") + "\n");
        });
      })
    : undefined;
  await filesystemObserver?.ready;

  const finishCall = async (key: string, eventType: "CALL_SUCCEEDED" | "CALL_FAILED" | "CALL_OUTCOME_UNKNOWN", errorCode?: string) => {
    const call = pending.get(key);
    if (!call) return;
    clearTimeout(call.timer);
    pending.delete(key);
    try {
      await reportGatewayEvent(call, eventType, errorCode);
    } catch (error) {
      errorOutput.write("AgentTrellis stdio telemetry: " + (error instanceof Error ? error.message : "report failed") + "\n");
    }
  };

  const inputLines = createInterface({ input, crlfDelay: Infinity });
  const outputLines = createInterface({ input: childStdout, crlfDelay: Infinity });

  inputLines.on("line", (line) => {
    processingInput = processingInput.then(async () => {
      if (childClosed) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        childStdin.write(line + "\n");
        return;
      }
      const calls = parseToolCalls(parsed);
      for (const request of calls) {
        const key = rpcIdKey(request.id);
        const previous = pending.get(key);
        if (previous) await finishCall(key, "CALL_OUTCOME_UNKNOWN", "JSONRPC_ID_REUSED");
        const call = {
          ...request,
          executionId: "stdio_" + randomUUID(),
          startedAt: Date.now(),
          timer: setTimeout(() => {
            void finishCall(key, "CALL_OUTCOME_UNKNOWN", "STDIO_RESPONSE_TIMEOUT");
          }, timeoutMs)
        };
        pending.set(key, call);
        try {
          await reportGatewayEvent(call, "CALL_STARTED");
        } catch (error) {
          clearTimeout(call.timer);
          pending.delete(key);
          errorOutput.write("AgentTrellis stdio gateway could not record CALL_STARTED; tool invocation was not forwarded.\n");
          throw error;
        }
      }
      if (!childStdin.write(line + "\n")) {
        await new Promise<void>((resolve) => childStdin.once("drain", resolve));
      }
    }).catch((error) => {
      errorOutput.write("AgentTrellis stdio gateway: " + (error instanceof Error ? error.message : "request forwarding failed") + "\n");
    });
  });

  outputLines.on("line", (line) => {
    if (Buffer.byteLength(line, "utf8") > MAX_PROTOCOL_MESSAGE_BYTES) {
      const completions = [...pending.keys()].map((key) =>
        finishCall(key, "CALL_OUTCOME_UNKNOWN", "RESPONSE_TOO_LARGE")
      );
      void Promise.all(completions).finally(() => output.write(line + "\n"));
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      const completions = [...pending.keys()].map((key) =>
        finishCall(key, "CALL_OUTCOME_UNKNOWN", "UNPARSEABLE_RESPONSE")
      );
      void Promise.all(completions).finally(() => output.write(line + "\n"));
      return;
    }
    const messages = Array.isArray(parsed) ? parsed : [parsed];
    const responses = messages.map(asRecord).filter((message) =>
      (typeof message.id === "string" || typeof message.id === "number") &&
      typeof message.method !== "string"
    );
    const pendingKeys = new Set(pending.keys());
    const hasUncorrelatedResponse = responses.some((message) =>
      !pendingKeys.has(rpcIdKey(message.id as string | number))
    );
    const completions = responses.map((message) => {
      const key = rpcIdKey(message.id as string | number);
      if (!pendingKeys.has(key)) return Promise.resolve();
      const classification = classifyResponse(message);
      return finishCall(key, classification.eventType, classification.errorCode);
    });
    if (responses.length > 0 && hasUncorrelatedResponse && pending.size > 0) {
      completions.push(...[...pending.keys()].map((key) =>
        finishCall(key, "CALL_OUTCOME_UNKNOWN", "UNCORRELATED_RESPONSE")
      ));
    }
    void Promise.all(completions).finally(() => output.write(line + "\n"));
  });

  inputLines.on("close", () => {
    childStdin.end();
  });
  child.on("error", (error) => {
    errorOutput.write("AgentTrellis stdio upstream process error: " + error.message + "\n");
  });
  child.on("close", () => {
    childClosed = true;
    shutdownPromise = (async () => {
      await Promise.all([...pending.keys()].map((key) =>
        finishCall(key, "CALL_OUTCOME_UNKNOWN", "MCP_PROCESS_EXITED")
      ));
      await filesystemObserver?.stop();
      if (!output.destroyed) output.end();
    })();
  });

  await new Promise<void>((resolve) => {
    child.once("close", () => resolve());
    input.once("close", () => {
      if (childClosed) resolve();
    });
  });
  await processingInput.catch(() => {});
  await shutdownPromise;
  await filesystemObserver?.stop();
}

function cliServerId(argv: string[]): string {
  const index = argv.indexOf("--server-id");
  const value = index >= 0 ? argv[index + 1] : undefined;
  if (!value || !/^[A-Za-z0-9._:-]{1,200}$/.test(value)) {
    throw new Error("Usage: mcp-stdio-gateway --server-id <discovered-server-id>");
  }
  return value;
}

async function main(): Promise<void> {
  if (process.env.AGENT_TRELLIS_RUNTIME_STDIO !== "true") {
    throw new Error("Local stdio proxy execution is disabled. Set AGENT_TRELLIS_RUNTIME_STDIO=true to opt in.");
  }
  const gatewayToken = process.env.AGENT_TRELLIS_RUNTIME_GATEWAY_TOKEN;
  if (!gatewayToken) throw new Error("AGENT_TRELLIS_RUNTIME_GATEWAY_TOKEN is required.");
  const serverId = cliServerId(process.argv.slice(2));
  const roots = (process.env.AGENT_TRELLIS_WORKSPACES ?? "").split(path.delimiter).filter(Boolean);
  const target = resolveMcpServerConfig(serverId, { workspaceRoots: [process.cwd(), ...roots] });
  if (!target) throw new Error("The discovered stdio MCP configuration could not be resolved.");
  if (target.server.transport !== "stdio") throw new Error("The discovered MCP server is not stdio.");
  const observerToken = process.env.AGENT_TRELLIS_RUNTIME_OBSERVER_TOKEN;
  const watchFilesystem = process.env.AGENT_TRELLIS_RUNTIME_OBSERVE_FILESYSTEM === "true";
  if (watchFilesystem && !observerToken) throw new Error("AGENT_TRELLIS_RUNTIME_OBSERVER_TOKEN is required for filesystem observation.");
  const watchPaths = (process.env.AGENT_TRELLIS_RUNTIME_WATCH_PATHS ?? "").split(path.delimiter).filter(Boolean);
  await runStdioRuntimeGateway({
    target,
    apiUrl: process.env.AGENT_TRELLIS_API_URL ?? "http://127.0.0.1:" + (process.env.PORT ?? "8787"),
    gatewayToken,
    observerToken,
    watchFilesystem,
    watchPaths
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    process.stderr.write("AgentTrellis stdio gateway failed: " + (error instanceof Error ? error.message : "unknown error") + "\n");
    process.exitCode = 1;
  });
}
