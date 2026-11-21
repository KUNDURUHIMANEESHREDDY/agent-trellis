import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/server/api";
import { AgentGraph } from "../src/server/graph";
import { MCPContinuousMonitor } from "../src/server/monitor";
import { discoverMcpConfigurations } from "../src/server/discovery";

describe("continuous monitor API", () => {
  let root = "";
  const previousWorkspaceRoots = process.env.AGENT_TRELLIS_WORKSPACES;
  afterEach(() => {
    if (previousWorkspaceRoots === undefined) delete process.env.AGENT_TRELLIS_WORKSPACES;
    else process.env.AGENT_TRELLIS_WORKSPACES = previousWorkspaceRoots;
    if (root) fs.rmSync(root, { recursive: true, force: true });
    root = "";
  });

  it("exposes monitor configuration, persisted last run and manual scans", async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-trellis-monitor-api-"));
    const graph = new AgentGraph(path.join(root, "graph"));
    await graph.initialize();
    const monitor = new MCPContinuousMonitor(graph, {
      intervalMs: 0,
      workspaceRoots: [root],
      dependencies: {
        discover: () => ({ scannedConfigPaths: [], servers: [], diagnostics: [] }),
        resolve: () => null,
        inspect: async () => { throw new Error("No servers should be inspected"); }
      }
    });
    const configPath = path.join(root, ".mcp.json");
    fs.writeFileSync(configPath, JSON.stringify({
      mcpServers: {
        lockedServer: { type: "http", url: "https://locked.example.test/mcp" }
      }
    }), "utf8");
    process.env.AGENT_TRELLIS_WORKSPACES = root;
    const discovery = discoverMcpConfigurations({ workspaceRoots: [process.cwd(), root] });
    const server = discovery.servers.find((item) => item.name === "lockedServer");
    expect(server).toBeDefined();
    graph.syncMcpDiscovery(discovery);
    const app = createApp(graph, monitor);
    expect(monitor.acquireServer(server!.id)).toBe(true);
    await request(app).post("/api/inspection/mcp/" + server!.id).send({}).expect(409);
    monitor.releaseServer(server!.id);
    await request(app).get("/api/monitor/status").expect(200).then((res) => {
      expect(res.body.configuration).toMatchObject({ enabled: false, intervalMs: 0, includeStdio: false });
      expect(res.body.lastPersistedRun).toBeNull();
    });
    const run = await request(app).post("/api/monitor/run").expect(202);
    expect(run.body.discoveredServers).toBe(0);
    await request(app).get("/api/runtime/monitoring").expect(200).then((res) => {
      expect(res.body.monitorRuns.total).toBe(1);
      expect(res.body.monitorStatus.enabled).toBe(false);
    });
    graph.checkpoint();
  });
});
