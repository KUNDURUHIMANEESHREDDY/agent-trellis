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
});
