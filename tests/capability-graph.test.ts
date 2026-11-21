import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AgentGraph } from "../src/server/graph";

describe("AgentGraph capability intelligence", () => {
  let temporaryDirectories: string[] = [];
  afterEach(() => {
    for (const directory of temporaryDirectories) fs.rmSync(directory, { recursive: true, force: true });
    temporaryDirectories = [];
  });

  it("persists schema-derived capabilities, evidence, exposure and explicit agent links", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-trellis-capability-"));
    temporaryDirectories.push(dir);
    const graph = new AgentGraph(path.join(dir, "graph"));
    await graph.initialize();
    const configPath = path.join(dir, ".mcp.json");
    const server = {
      id: "mcp-capability-server",
      hostId: "mcp-capability-host",
      hostName: "Test MCP",
      source: "workspace-mcp",
      configPath,
      configScope: "configured",
      name: "capability-test",
      transport: "http" as const,
      endpoint: "https://example.test/mcp",
      argumentCount: 0,
      environmentKeys: [],
      headerNames: [],
      credentialHints: false
    };
    graph.syncMcpDiscovery({ scannedConfigPaths: [configPath], servers: [server], diagnostics: [] });
    graph.recordMcpInspection({
      serverId: server.id,
      serverName: server.name,
      inspectedAt: "2026-11-20T13:00:00.000Z",
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
      tools: [
        {
          name: "delete_database_record",
          description: "Delete a record from the database.",
          inputSchema: { type: "object", properties: { record_id: { type: "string" }, table: { type: "string" } } },
          annotations: { readOnlyHint: true, destructiveHint: false }
        },
        {
          name: "read_file",
          description: "Read a file from the workspace.",
          inputSchema: { type: "object", properties: { file_path: { type: "string" } } }
        }
      ]
    });

    const analysis = graph.analyzeMcpCapabilities(server.id);
    expect(analysis.analyzedTools).toBe(2);
    expect(analysis.summary.criticalTools).toBe(1);
    const intelligence = graph.getCapabilityIntelligence();
    expect(intelligence.summary.analyzedTools).toBe(2);
    expect(intelligence.servers[0].tools).toHaveLength(2);
    expect(intelligence.servers[0].exposureScore).toBeGreaterThan(0);

    const graphData = graph.getGraph();
    expect(graphData.nodes.some((node) => node.labels.includes("Capability") && node.properties.inferenceKey === "database_write")).toBe(true);
    expect(graphData.edges.some((edge) => edge.type === "REQUIRES")).toBe(true);
    expect(graphData.nodes.some((node) => node.labels.includes("Evidence") && node.properties.kind === "MCP_CAPABILITY_ANALYSIS")).toBe(true);

    const association = graph.associateAgentWithMcpServer("agent-support", server.id);
    expect(association.ok).toBe(true);
    const afterAssociation = graph.getCapabilityIntelligence();
    expect(afterAssociation.servers[0].agents.map((agent: any) => agent.id)).toContain("agent-support");
    const agent = graph.getAgents().find((item: any) => item.id === "agent-support") as Record<string, unknown>;
    expect(Number(agent.mcpExposureScore)).toBeGreaterThan(0);

    graph.removeAgentMcpAssociation("agent-support", server.id);
    expect(graph.getCapabilityIntelligence().servers[0].agents).toHaveLength(0);
    expect(graph.getImpact("mcp-tool-not-a-tool")).toBeNull();
    graph.checkpoint();
  });

  it("records schema drift only after a baseline and refreshes capability analysis", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-trellis-drift-"));
    temporaryDirectories.push(dir);
    const graph = new AgentGraph(path.join(dir, "graph"));
    await graph.initialize();
    const configPath = path.join(dir, ".mcp.json");
    const server = {
      id: "mcp-drift-server",
      hostId: "mcp-drift-host",
      hostName: "Drift test host",
      source: "test",
      configPath,
      configScope: "workspace",
      name: "drift-test",
      transport: "http" as const,
      endpoint: "https://drift.example.test/mcp",
      argumentCount: 0,
      environmentKeys: [],
      headerNames: [],
      credentialHints: false
    };
    graph.syncMcpDiscovery({ scannedConfigPaths: [configPath], servers: [server], diagnostics: [] });
    const inspection = (inspectedAt: string, tools: Array<Record<string, unknown>>, success = true) => graph.recordMcpInspection({
      serverId: server.id,
      serverName: server.name,
      inspectedAt,
      success,
      transport: "http",
      declaredCapabilities: ["tools"],
      observedCapabilities: success ? ["tools"] : [],
      capabilityComparisons: [
        { capability: "tools", declared: true, observed: success, status: success ? "consistent" : "missing" },
        { capability: "resources", declared: false, observed: null, status: "not_checked" },
        { capability: "prompts", declared: false, observed: null, status: "not_checked" }
      ],
      tools: tools as any
    });

    inspection("2026-11-20T13:00:00.000Z", [{
      name: "read_file",
      description: "Read a file.",
      inputSchema: { type: "object", properties: { path: { type: "string" } } }
    }]);
    expect(graph.getRuntimeMonitoring().drift.total).toBe(0);

    inspection("2026-11-20T13:01:00.000Z", [{
      name: "read_file",
      description: "Read a file and return metadata.",
      inputSchema: { type: "object", properties: { path: { type: "string" }, recursive: { type: "boolean" } } }
    }, {
      name: "write_file",
      description: "Write a file.",
      inputSchema: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } } }
    }]);
    const monitoring = graph.getRuntimeMonitoring();
    expect(monitoring.drift.total).toBe(1);
    expect(monitoring.drift.events[0].changeCount).toBe(2);
    expect(graph.getCapabilityIntelligence().summary.tools).toBe(2);

    inspection("2026-11-20T13:02:00.000Z", [{
      name: "read_file",
      description: "Read a file and return metadata.",
      inputSchema: { type: "object", properties: { path: { type: "string" }, recursive: { type: "boolean" } } }
    }, {
      name: "write_file",
      description: "Write a file.",
      inputSchema: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } } }
    }]);
    expect(graph.getRuntimeMonitoring().drift.total).toBe(1);

    inspection("2026-11-20T13:03:00.000Z", [], false);
    expect(graph.getCapabilityIntelligence().summary.tools).toBe(2);
    expect(graph.getRuntimeMonitoring().drift.total).toBe(1);
    graph.checkpoint();
  });
});
