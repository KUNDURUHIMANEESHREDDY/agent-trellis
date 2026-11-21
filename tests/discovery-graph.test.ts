import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AgentGraph } from "../src/server/graph";
import type { MCPDiscoveryResult } from "../src/server/discovery";

describe("AgentGraph MCP discovery ingestion", () => {
  it("persists discovered hosts and prunes definitions only for successfully scanned files", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-trellis-mcp-graph-"));
    const graph = new AgentGraph(path.join(dir, "graph"));
    await graph.initialize();

    const configPath = path.join(dir, "cursor", "mcp.json");
    const server = {
      id: "mcp-discovered-server-one",
      hostId: "mcp-host-cursor",
      hostName: "Cursor (global)",
      source: "cursor-global",
      configPath,
      configScope: "configured",
      name: "filesystem",
      transport: "stdio" as const,
      command: "npx",
      argumentCount: 2,
      environmentKeys: ["ROOT"],
      headerNames: [],
      credentialHints: false
    };
    const firstScan: MCPDiscoveryResult = {
      scannedConfigPaths: [configPath],
      servers: [server],
      diagnostics: []
    };

    graph.syncMcpDiscovery(firstScan);
    expect(graph.getOverview().discoveredMcpServers).toBe(1);
    expect(graph.getDiscoveredMcpServers()).toHaveLength(1);
    expect(graph.getGraph().nodes.some((node) => node.labels.includes("MCPHost"))).toBe(true);

    graph.syncMcpDiscovery({
      scannedConfigPaths: [configPath],
      servers: [],
      diagnostics: []
    });
    expect(graph.getDiscoveredMcpServers()).toHaveLength(0);
    expect(graph.getOverview().discoveredMcpServers).toBe(0);

    graph.checkpoint();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("records inspection evidence and retains the last known tool snapshot after a failed reconnect", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-trellis-inspection-"));
    const graph = new AgentGraph(path.join(dir, "graph"));
    await graph.initialize();
    const configPath = path.join(dir, "mcp.json");
    const server = {
      id: "mcp-inspection-server",
      hostId: "mcp-inspection-host",
      hostName: "Test MCP",
      source: "workspace-mcp",
      configPath,
      configScope: "configured",
      name: "test-server",
      transport: "http" as const,
      endpoint: "https://example.test/mcp",
      argumentCount: 0,
      environmentKeys: [],
      headerNames: [],
      credentialHints: false
    };
    graph.syncMcpDiscovery({
      scannedConfigPaths: [configPath],
      servers: [server],
      diagnostics: []
    });

    const inspectedAt = "2026-11-20T12:00:00.000Z";
    const successful = {
      serverId: server.id,
      serverName: server.name,
      inspectedAt,
      success: true,
      transport: "http",
      protocolEra: "legacy" as const,
      protocolVersion: "2025-11-25",
      declaredCapabilities: ["tools"],
      observedCapabilities: ["tools"],
      capabilityComparisons: [
        { capability: "tools" as const, declared: true, observed: true, status: "consistent" as const },
        { capability: "resources" as const, declared: false, observed: null, status: "not_checked" as const },
        { capability: "prompts" as const, declared: false, observed: null, status: "not_checked" as const }
      ],
      tools: [{ name: "read_status", inputSchema: { type: "object", properties: {} } }]
    };
    graph.recordMcpInspection(successful);
    const toolId = graph.getGraph().nodes.find(
      (node) => node.labels.includes("Tool") && node.properties.mcpServerId === server.id
    )?.id;
    expect(toolId).toBeTruthy();

    const failed = {
      ...successful,
      inspectedAt: "2026-11-20T12:01:00.000Z",
      success: false,
      protocolEra: undefined,
      protocolVersion: undefined,
      declaredCapabilities: [],
      observedCapabilities: [],
      capabilityComparisons: [],
      tools: [],
      errorSummary: "ConnectionError"
    };
    const evidence = graph.recordMcpInspection(failed);
    expect(evidence?.result).toBe("FAIL");

    const afterFailure = graph.getGraph();
    expect(afterFailure.nodes.some((node) => node.id === toolId)).toBe(true);
    expect(graph.getMcpInspections()).toHaveLength(1);
    expect(graph.getMcpInspections()[0].errorSummary).toBe("ConnectionError");
    expect(graph.getOverview().evidence).toBe(7); // Inspection plus automatic capability-analysis evidence.

    graph.checkpoint();
    fs.rmSync(dir, { recursive: true, force: true });
  });

});
