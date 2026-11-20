import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { AgentGraph } from "../src/server/graph";
import { createApp } from "../src/server/api";
import { discoverMcpConfigurations } from "../src/server/discovery";

describe("Capability intelligence API", () => {
  const previousWorkspaceRoots = process.env.AGENT_TRELLIS_WORKSPACES;
  afterEach(() => {
    if (previousWorkspaceRoots === undefined) delete process.env.AGENT_TRELLIS_WORKSPACES;
    else process.env.AGENT_TRELLIS_WORKSPACES = previousWorkspaceRoots;
  });

  it("analyzes inspected tools and manages explicit agent-to-server associations", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-trellis-cap-api-"));
    const workspace = path.join(root, "workspace");
    fs.mkdirSync(workspace, { recursive: true });
    const configPath = path.join(workspace, ".mcp.json");
    fs.writeFileSync(configPath, JSON.stringify({
      mcpServers: { sample: { type: "http", url: "https://example.test/mcp" } }
    }), "utf8");
    process.env.AGENT_TRELLIS_WORKSPACES = workspace;

    const discovery = discoverMcpConfigurations({ workspaceRoots: [process.cwd(), workspace] });
    const server = discovery.servers.find((item) => item.name === "sample");
    expect(server).toBeDefined();
    const graph = new AgentGraph(path.join(root, "graph"));
    await graph.initialize();
    graph.syncMcpDiscovery(discovery);
    graph.recordMcpInspection({
      serverId: server!.id,
      serverName: server!.name,
      inspectedAt: "2026-11-20T14:00:00.000Z",
      success: true,
      transport: "http",
      protocolEra: "legacy",
      protocolVersion: "2025-11-25",
      declaredCapabilities: ["tools"],
      observedCapabilities: ["tools"],
      capabilityComparisons: [
        { capability: "tools", declared: true, observed: true, status: "consistent" },
        { capability: "resources", declared: false, observed: null, status: "not_checked" },
        { capability: "prompts", declared: false, observed: null, status: "not_checked" }
      ],
      tools: [{
        name: "read_file",
        description: "Read a file from the workspace.",
        inputSchema: { type: "object", properties: { file_path: { type: "string" } } }
      }]
    });
    const app = createApp(graph);

    try {
      const analysis = await request(app)
        .post("/api/capabilities/analyze")
        .send({ serverId: server!.id })
        .expect(200);
      expect(analysis.body.analyzedTools).toBe(1);
      expect(analysis.body.findings[0].capabilities.map((item: any) => item.key)).toContain("filesystem_read");

      await request(app)
        .post("/api/agents/agent-support/mcp-servers/" + server!.id)
        .send({})
        .expect(201);
      const linked = await request(app).get("/api/capabilities/intelligence").expect(200);
      expect(linked.body.servers[0].agents.map((agent: any) => agent.id)).toContain("agent-support");

      await request(app)
        .delete("/api/agents/agent-support/mcp-servers/" + server!.id)
        .expect(200);
      const unlinked = await request(app).get("/api/capabilities/intelligence").expect(200);
      expect(unlinked.body.servers[0].agents).toHaveLength(0);

      await request(app)
        .post("/api/agents/agent-missing/mcp-servers/" + server!.id)
        .send({})
        .expect(404);
    } finally {
      graph.checkpoint();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
