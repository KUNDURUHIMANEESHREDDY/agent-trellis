import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentGraph } from "../src/server/graph";
import { MCPContinuousMonitor } from "../src/server/monitor";
import type { MCPDiscoveryResult } from "../src/server/discovery";
import type { MCPInspectionOutcome, MCPInspectionTarget } from "../src/server/mcp-inspector";

describe("continuous MCP monitor", () => {
  let root = "";
  afterEach(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
    root = "";
  });

  it("periodically inspects HTTP/SSE servers and skips stdio unless explicitly enabled", async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-trellis-monitor-"));
    const graph = new AgentGraph(path.join(root, "graph"));
    await graph.initialize();
    const server = (id: string, transport: "http" | "stdio") => ({
      id,
      hostId: id + "-host",
      hostName: "Monitor test host",
      source: "test",
      configPath: path.join(root, id + ".json"),
      configScope: "workspace",
      name: id,
      transport,
      ...(transport === "http" ? { endpoint: "https://monitor.example.test/mcp" } : { command: "node" }),
      argumentCount: 0,
      environmentKeys: [],
      headerNames: [],
      credentialHints: false
    });
    const discovered: MCPDiscoveryResult = {
      scannedConfigPaths: [path.join(root, "http.json"), path.join(root, "stdio.json")],
      servers: [server("http-server", "http"), server("stdio-server", "stdio")],
      diagnostics: []
    };
    const target = {
      server: discovered.servers[0] as any,
      config: { url: "https://monitor.example.test/mcp" }
    } as MCPInspectionTarget;
    const inspect = vi.fn(async (): Promise<MCPInspectionOutcome> => ({
      serverId: "http-server",
      serverName: "http-server",
      inspectedAt: "2026-11-20T12:00:00.000Z",
      success: true,
      transport: "http",
      declaredCapabilities: ["tools"],
      observedCapabilities: ["tools"],
      capabilityComparisons: [
        { capability: "tools", declared: true, observed: true, status: "consistent" },
        { capability: "resources", declared: false, observed: null, status: "not_checked" },
        { capability: "prompts", declared: false, observed: null, status: "not_checked" }
      ],
      tools: [{ name: "read_status", inputSchema: { type: "object", properties: {} } }]
    }));
    const monitor = new MCPContinuousMonitor(graph, {
      intervalMs: 0,
      workspaceRoots: [root],
      dependencies: {
        discover: () => discovered,
        resolve: (serverId) => serverId === "http-server" ? target : null,
        inspect
      },
      now: () => new Date("2026-11-20T12:00:00.000Z")
    });

    const result = await monitor.runOnce();
    expect(result.discoveredServers).toBe(2);
    expect(result.inspectedServers).toBe(1);
    expect(result.failedServers).toBe(0);
    expect(result.skippedStdioServers).toBe(1);
    expect(inspect).toHaveBeenCalledTimes(1);
    expect(graph.getMonitorStatus()).toMatchObject({
      lastInspectedServers: 1,
      lastSkippedStdioServers: 1,
      lastRunResult: "COMPLETED"
    });
    expect(graph.getRuntimeMonitoring().monitorRuns.total).toBe(1);
    expect(monitor.getStatus().enabled).toBe(false);
    graph.checkpoint();
  });

  it("uses a single in-flight cycle and can be started and stopped", async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-trellis-monitor-lock-"));
    const graph = new AgentGraph(path.join(root, "graph"));
    await graph.initialize();
    const server = {
      id: "http-lock-server",
      hostId: "http-lock-host",
      hostName: "Lock test host",
      source: "test",
      configPath: path.join(root, "http.json"),
      configScope: "workspace",
      name: "http-lock-server",
      transport: "http" as const,
      endpoint: "https://lock.example.test/mcp",
      argumentCount: 0,
      environmentKeys: [],
      headerNames: [],
      credentialHints: false
    };
    const discovered: MCPDiscoveryResult = {
      scannedConfigPaths: [server.configPath],
      servers: [server],
      diagnostics: []
    };
    const target = { server, config: { url: server.endpoint } } as MCPInspectionTarget;
    let resolveInspect: ((value: MCPInspectionOutcome) => void) | undefined;
    const monitor = new MCPContinuousMonitor(graph, {
      intervalMs: 30_000,
      workspaceRoots: [root],
      dependencies: {
        discover: () => discovered,
        resolve: () => target,
        inspect: () => new Promise<MCPInspectionOutcome>((resolve) => {
          resolveInspect = resolve;
        })
      }
    });
    monitor.start();
    const busy = await monitor.runOnce();
    expect(busy.busy).toBe(true);
    expect(monitor.acquireServer(server.id)).toBe(false);
    monitor.stop();
    resolveInspect?.({
      serverId: server.id, serverName: server.name, inspectedAt: new Date().toISOString(),
      success: true, transport: "http", declaredCapabilities: ["tools"], observedCapabilities: ["tools"],
      capabilityComparisons: [
        { capability: "tools", declared: true, observed: true, status: "consistent" },
        { capability: "resources", declared: false, observed: null, status: "not_checked" },
        { capability: "prompts", declared: false, observed: null, status: "not_checked" }
      ],
      tools: []
    });
    await Promise.resolve();
    expect(monitor.acquireServer(server.id)).toBe(true);
    monitor.releaseServer(server.id);
  });
});
