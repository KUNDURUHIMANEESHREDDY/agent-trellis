import fs from "node:fs";
import path from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";

type JsonRecord = Record<string, unknown>;

export type MCPTransport = "stdio" | "http" | "sse" | "unknown";

export interface DiscoveredMcpServer {
  id: string;
  hostId: string;
  hostName: string;
  source: string;
  configPath: string;
  configScope: string;
  name: string;
  transport: MCPTransport;
  command?: string;
  endpoint?: string;
  argumentCount: number;
  environmentKeys: string[];
  headerNames: string[];
  credentialHints: boolean;
  hostSource?: string;
  exposureScore?: number;
  exposureLevel?: string;
}

export interface MCPDiscoveryDiagnostic {
  source: string;
  configPath: string;
  message: string;
}

export interface MCPDiscoveryResult {
  scannedConfigPaths: string[];
  servers: DiscoveredMcpServer[];
  diagnostics: MCPDiscoveryDiagnostic[];
}

export interface MCPDiscoveryOptions {
  homeDir?: string;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  workspaceRoots?: string[];
}

interface ConfigCandidate {
  source: string;
  hostName: string;
  configPath: string;
  kind?: "claude-code";
  identity?: string;
}

const MAX_CONFIG_BYTES = 1024 * 1024;

function asRecord(value: unknown): JsonRecord | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  return value as JsonRecord;
}

function stableId(prefix: string, parts: string[]): string {
  const digest = createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, 20);
  return prefix + "-" + digest;
}

function sanitizeEndpoint(value: unknown): string | undefined {
  if (typeof value !== "string" || value.trim().length === 0) return undefined;
  try {
    const url = new URL(value);
    if (!["http:", "https:", "unix:", "pipe:"].includes(url.protocol.toLowerCase())) return undefined;
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    if (url.protocol === "http:" || url.protocol === "https:") return url.origin + url.pathname;
    return url.protocol + "//" + url.host + url.pathname;
  } catch {
    return undefined;
  }
}

function transportFor(config: JsonRecord): MCPTransport {
  const type = typeof config.type === "string" ? config.type.toLowerCase() : "";
  if (type === "stdio" || type === "sse") return type;
  if (type === "http" || type === "streamable-http" || type === "streamablehttp") return "http";
  if (typeof config.command === "string" && config.command.length > 0) return "stdio";
  if (typeof config.url === "string" && config.url.length > 0) return "http";
  return "unknown";
}

function keysOf(value: unknown): string[] {
  return Object.keys(asRecord(value) ?? {}).sort((a, b) => a.localeCompare(b));
}

function addServerDefinitions(
  definitions: unknown,
  candidate: ConfigCandidate,
  scope: string,
  servers: DiscoveredMcpServer[],
  diagnostics: MCPDiscoveryDiagnostic[]
): void {
  const entries = asRecord(definitions);
  if (!entries) return;

  for (const [name, rawConfig] of Object.entries(entries)) {
    const config = asRecord(rawConfig);
    if (!config) {
      diagnostics.push({
        source: candidate.source,
        configPath: candidate.configPath,
        message: "Skipped server '" + name + "' because its configuration is not an object."
      });
      continue;
    }

    const identity = candidate.identity ?? candidate.configPath;
    const hostId = stableId("mcp-host", [candidate.source, identity, scope]);
    const id = stableId("mcp-discovered", [candidate.source, identity, scope, name]);
    const environmentKeys = keysOf(config.env);
    const headerNames = keysOf(config.headers);
    const command = typeof config.command === "string" ? config.command : undefined;
    const endpoint = sanitizeEndpoint(config.url);
    const credentialHints =
      headerNames.length > 0 ||
      environmentKeys.some((key) => /token|secret|password|api[_-]?key|auth/i.test(key));

    servers.push({
      id,
      hostId,
      hostName: candidate.hostName,
      source: candidate.source,
      configPath: candidate.configPath,
      configScope: scope,
      name,
      transport: transportFor(config),
      ...(command ? { command } : {}),
      ...(endpoint ? { endpoint } : {}),
      argumentCount: Array.isArray(config.args) ? config.args.length : 0,
      environmentKeys,
      headerNames,
      credentialHints
    });
  }
}

function readConfig(
  candidate: ConfigCandidate,
  scannedConfigPaths: string[],
  diagnostics: MCPDiscoveryDiagnostic[]
): JsonRecord | null {
  try {
    const stat = fs.statSync(candidate.configPath);
    if (!stat.isFile()) return null;
    if (stat.size > MAX_CONFIG_BYTES) {
      diagnostics.push({
        source: candidate.source,
        configPath: candidate.configPath,
        message: "Skipped configuration larger than the 1 MiB scan limit."
      });
      return null;
    }
    const text = fs.readFileSync(candidate.configPath, "utf8").replace(/^\uFEFF/, "");
    const parsed: unknown = JSON.parse(text);
    const record = asRecord(parsed);
    if (!record) {
      diagnostics.push({
        source: candidate.source,
        configPath: candidate.configPath,
        message: "Skipped configuration because its JSON root is not an object."
      });
      return null;
    }
    scannedConfigPaths.push(path.resolve(candidate.configPath));
    return record;
  } catch (error) {
    const code = asRecord(error)?.code;
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    diagnostics.push({
      source: candidate.source,
      configPath: candidate.configPath,
      message: "Could not read configuration; check its permissions and JSON syntax."
    });
    return null;
  }
}

export function discoverMcpConfigurations(options: MCPDiscoveryOptions = {}): MCPDiscoveryResult {
  const homeDir = path.resolve(options.homeDir ?? homedir());
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const workspaceRoots = [...new Set((options.workspaceRoots ?? [process.cwd()]).map((root) => path.resolve(root)))];
  const candidates: ConfigCandidate[] = [];

  if (platform === "win32") {
    const appData = env.APPDATA ?? path.join(homeDir, "AppData", "Roaming");
    candidates.push({
      source: "claude-desktop",
      hostName: "Claude Desktop",
      configPath: path.join(appData, "Claude", "claude_desktop_config.json")
    });
  } else if (platform === "darwin") {
    candidates.push({
      source: "claude-desktop",
      hostName: "Claude Desktop",
      configPath: path.join(homeDir, "Library", "Application Support", "Claude", "claude_desktop_config.json")
    });
  } else {
    const xdgConfigHome = env.XDG_CONFIG_HOME ?? path.join(homeDir, ".config");
    candidates.push({
      source: "claude-desktop",
      hostName: "Claude Desktop",
      configPath: path.join(xdgConfigHome, "Claude", "claude_desktop_config.json")
    });
  }

  const claudeConfigDir = env.CLAUDE_CONFIG_DIR ? path.resolve(env.CLAUDE_CONFIG_DIR) : homeDir;
  candidates.push({
    source: "claude-code",
    hostName: "Claude Code",
    configPath: path.join(claudeConfigDir, ".claude.json"),
    kind: "claude-code"
  });
  candidates.push({
    source: "copilot-cli",
    hostName: "GitHub Copilot CLI",
    configPath: path.join(env.COPILOT_HOME ? path.resolve(env.COPILOT_HOME) : path.join(homeDir, ".copilot"), "mcp-config.json")
  });
  candidates.push({
    source: "cursor-global",
    hostName: "Cursor (global)",
    configPath: path.join(homeDir, ".cursor", "mcp.json")
  });
  candidates.push({
    source: "windsurf-global",
    hostName: "Windsurf",
    configPath: path.join(homeDir, ".codeium", "windsurf", "mcp_config.json")
  });

  for (const workspaceRoot of workspaceRoots) {
    candidates.push({
      source: "workspace-mcp",
      hostName: "Workspace MCP configuration (" + path.basename(workspaceRoot) + ")",
      configPath: path.join(workspaceRoot, ".mcp.json")
    });
    candidates.push({
      source: "cursor-workspace",
      hostName: "Cursor workspace (" + path.basename(workspaceRoot) + ")",
      configPath: path.join(workspaceRoot, ".cursor", "mcp.json")
    });
  }

  const scannedConfigPaths: string[] = [];
  const servers: DiscoveredMcpServer[] = [];
  const diagnostics: MCPDiscoveryDiagnostic[] = [];
  const visited = new Set<string>();

  for (const candidate of candidates) {
    const resolvedPath = path.resolve(candidate.configPath);
    if (visited.has(resolvedPath)) continue;
    visited.add(resolvedPath);
    const config = readConfig(candidate, scannedConfigPaths, diagnostics);
    if (!config) continue;

    if (candidate.kind === "claude-code") {
      addServerDefinitions(config.mcpServers, {
        ...candidate,
        source: "claude-code-user",
        hostName: "Claude Code (user)"
      }, "user", servers, diagnostics);

      const projects = asRecord(config.projects);
      if (projects) {
        for (const workspaceRoot of workspaceRoots) {
          const projectEntry = Object.entries(projects).find(([projectPath]) => {
            try {
              return path.resolve(projectPath) === workspaceRoot;
            } catch {
              return false;
            }
          });
          const projectConfig = asRecord(projectEntry?.[1]);
          if (!projectConfig) continue;
          addServerDefinitions(projectConfig.mcpServers, {
            ...candidate,
            source: "claude-code-local",
            hostName: "Claude Code (local: " + path.basename(workspaceRoot) + ")",
            identity: workspaceRoot
          }, "local", servers, diagnostics);
        }
      }
      continue;
    }

    addServerDefinitions(config.mcpServers, candidate, "configured", servers, diagnostics);
  }

  return {
    scannedConfigPaths: [...new Set(scannedConfigPaths)],
    servers,
    diagnostics
  };
}


export interface ResolvedMcpServerConfig {
  server: DiscoveredMcpServer;
  config: JsonRecord;
}

function readRawConfig(configPath: string): JsonRecord | null {
  try {
    const stat = fs.statSync(configPath);
    if (!stat.isFile() || stat.size > MAX_CONFIG_BYTES) return null;
    const parsed: unknown = JSON.parse(fs.readFileSync(configPath, "utf8").replace(/^\uFEFF/, ""));
    return asRecord(parsed);
  } catch {
    return null;
  }
}

/** Re-resolve a server from its current config; runtime secrets never enter the graph. */
export function resolveMcpServerConfig(
  discoveredId: string,
  options: MCPDiscoveryOptions = {}
): ResolvedMcpServerConfig | null {
  const discovered = discoverMcpConfigurations(options).servers.find((server) => server.id === discoveredId);
  if (!discovered) return null;

  const root = readRawConfig(discovered.configPath);
  if (!root) return null;

  if (discovered.source === "claude-code-local") {
    const projects = asRecord(root.projects);
    if (!projects) return null;
    for (const [projectPath, rawProject] of Object.entries(projects)) {
      const project = asRecord(rawProject);
      const definitions = asRecord(project?.mcpServers);
      const config = asRecord(definitions?.[discovered.name]);
      if (!config) continue;
      const expectedId = stableId("mcp-discovered", [
        "claude-code-local",
        path.resolve(projectPath),
        "local",
        discovered.name
      ]);
      if (expectedId === discovered.id) return { server: discovered, config };
    }
    return null;
  }

  const definitions = asRecord(root.mcpServers);
  const config = asRecord(definitions?.[discovered.name]);
  if (!config) return null;
  const scope = discovered.source === "claude-code-user" ? "user" : "configured";
  const expectedId = stableId("mcp-discovered", [
    discovered.source,
    discovered.configPath,
    scope,
    discovered.name
  ]);
  return expectedId === discovered.id ? { server: discovered, config } : null;
}
