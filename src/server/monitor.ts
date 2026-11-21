import {
  discoverMcpConfigurations,
  resolveMcpServerConfig,
  type MCPDiscoveryOptions,
  type MCPDiscoveryResult
} from "./discovery";
import { inspectMcpServer, type MCPInspectionOutcome, type MCPInspectionTarget } from "./mcp-inspector";
import type { AgentGraph } from "./graph";

export interface MCPMonitorRunResult {
  startedAt: string;
  completedAt: string;
  discoveredServers: number;
  inspectedServers: number;
  failedServers: number;
  skippedStdioServers: number;
  skippedUnsupportedServers: number;
  skippedBusyServers: number;
  errors: number;
  busy?: boolean;
}

export interface MCPMonitorStatus {
  enabled: boolean;
  intervalMs: number;
  includeStdio: boolean;
  running: boolean;
  lastRun?: MCPMonitorRunResult;
}

export interface MCPMonitorDependencies {
  discover: (options?: MCPDiscoveryOptions) => MCPDiscoveryResult;
  resolve: (serverId: string, options?: MCPDiscoveryOptions) => MCPInspectionTarget | null;
  inspect: (target: MCPInspectionTarget) => Promise<MCPInspectionOutcome>;
}

export interface MCPMonitorOptions {
  intervalMs?: number;
  includeStdio?: boolean;
  workspaceRoots?: string[];
  dependencies?: Partial<MCPMonitorDependencies>;
  now?: () => Date;
}

function configuredInterval(): number {
  const raw = process.env.AGENT_TRELLIS_MONITOR_INTERVAL_MS;
  if (raw === undefined || raw.trim() === "") return 5 * 60 * 1000;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 24 * 60 * 60 * 1000) {
    throw new Error("AGENT_TRELLIS_MONITOR_INTERVAL_MS must be 0 or an integer up to 86400000.");
  }
  return parsed;
}

function configuredWorkspaceRoots(): string[] {
  const configured = (process.env.AGENT_TRELLIS_WORKSPACES ?? "")
    .split(process.platform === "win32" ? ";" : ":")
    .map((value) => value.trim())
    .filter(Boolean);
  return [process.cwd(), ...configured];
}

export class MCPContinuousMonitor {
  private readonly graph: AgentGraph;
  private readonly intervalMs: number;
  private readonly includeStdio: boolean;
  private readonly workspaceRoots: string[];
  private readonly dependencies: MCPMonitorDependencies;
  private readonly now: () => Date;
  private timer?: NodeJS.Timeout;
  private running = false;
  private readonly activeServerInspections = new Set<string>();
  private lastRun?: MCPMonitorRunResult;

  constructor(graph: AgentGraph, options: MCPMonitorOptions = {}) {
    this.graph = graph;
    this.intervalMs = options.intervalMs ?? configuredInterval();
    this.includeStdio = options.includeStdio ?? process.env.AGENT_TRELLIS_MONITOR_STDIO === "true";
    this.workspaceRoots = options.workspaceRoots ?? configuredWorkspaceRoots();
    this.now = options.now ?? (() => new Date());
    this.dependencies = {
      discover: options.dependencies?.discover ?? discoverMcpConfigurations,
      resolve: options.dependencies?.resolve ?? resolveMcpServerConfig,
      inspect: options.dependencies?.inspect ?? inspectMcpServer
    };
    if (!Number.isInteger(this.intervalMs) || this.intervalMs < 0 || this.intervalMs > 24 * 60 * 60 * 1000) {
      throw new Error("Monitor interval must be an integer between 0 and 86400000 milliseconds.");
    }
  }

  acquireServer(serverId: string): boolean {
    if (this.activeServerInspections.has(serverId)) return false;
    this.activeServerInspections.add(serverId);
    return true;
  }

  releaseServer(serverId: string): void {
    this.activeServerInspections.delete(serverId);
  }

  getStatus(): MCPMonitorStatus {
    return {
      enabled: this.intervalMs > 0,
      intervalMs: this.intervalMs,
      includeStdio: this.includeStdio,
      running: this.running,
      ...(this.lastRun ? { lastRun: this.lastRun } : {})
    };
  }

  start(): void {
    if (this.intervalMs === 0 || this.timer) return;
    void this.runOnce();
    this.timer = setInterval(() => { void this.runOnce(); }, this.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async runOnce(): Promise<MCPMonitorRunResult> {
    if (this.running) {
      const timestamp = this.now().toISOString();
      return {
        startedAt: timestamp,
        completedAt: timestamp,
        discoveredServers: 0,
        inspectedServers: 0,
        failedServers: 0,
        skippedStdioServers: 0,
        skippedUnsupportedServers: 0,
        skippedBusyServers: 0,
        errors: 0,
        busy: true
      };
    }

    this.running = true;
    const startedAt = this.now().toISOString();
    const summary: MCPMonitorRunResult = {
      startedAt,
      completedAt: startedAt,
      discoveredServers: 0,
      inspectedServers: 0,
      failedServers: 0,
      skippedStdioServers: 0,
      skippedUnsupportedServers: 0,
      skippedBusyServers: 0,
      errors: 0
    };

    try {
      const discovery = this.dependencies.discover({ workspaceRoots: this.workspaceRoots });
      this.graph.syncMcpDiscovery(discovery);
      summary.discoveredServers = discovery.servers.length;

      for (const server of discovery.servers) {
        if (server.transport === "stdio" && !this.includeStdio) {
          summary.skippedStdioServers += 1;
          continue;
        }
        if (server.transport !== "stdio" && server.transport !== "http" && server.transport !== "sse") {
          summary.skippedUnsupportedServers += 1;
          continue;
        }

        if (!this.acquireServer(server.id)) {
          summary.skippedBusyServers += 1;
          continue;
        }
        try {
          const target = this.dependencies.resolve(server.id, { workspaceRoots: this.workspaceRoots });
          if (!target) {
            summary.failedServers += 1;
            continue;
          }
          const outcome = await this.dependencies.inspect(target);
          const recorded = this.graph.recordMcpInspection(outcome);
          if (!recorded) {
            summary.failedServers += 1;
            continue;
          }
          summary.inspectedServers += 1;
          if (!outcome.success) summary.failedServers += 1;
        } catch {
          summary.failedServers += 1;
          summary.errors += 1;
        } finally {
          this.releaseServer(server.id);
        }
      }
    } catch {
      summary.errors += 1;
    } finally {
      summary.completedAt = this.now().toISOString();
      try { this.graph.recordMonitorRun(summary); } catch { summary.errors += 1; }
      this.lastRun = { ...summary };
      this.running = false;
    }

    return summary;
  }
}

export function monitorIntervalFromEnvironment(): number {
  return configuredInterval();
}
