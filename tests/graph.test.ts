import { describe, expect, it } from "vitest";
import { AgentGraph } from "../src/server/graph";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

describe("AgentGraph", () => {
  it("seeds a connected Relate graph and computes tool impact", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-trellis-"));
    const graph = new AgentGraph(path.join(dir, "graph"));
    await graph.initialize();

    const overview = graph.getOverview();
    expect(overview.agents).toBe(3);
    expect(overview.mcpServers).toBe(3);
    expect(overview.tools).toBe(6);
    expect(overview.evidence).toBe(4);

    const impact = graph.getImpact("tool-fetch");
    expect(impact?.affectedAgents.map((agent: any) => agent.id).sort()).toEqual(["agent-research", "agent-support"]);
    expect(impact?.controls).toHaveLength(1);

    const simulation = graph.simulateCompromise("tool-fetch");
    expect(simulation?.affectedAgents).toHaveLength(2);
    expect(graph.getOverview().highRiskTools).toBe(3);
    expect(graph.getOverview().failedFindings).toBe(2);

    graph.reset();
    expect(graph.getOverview().failedFindings).toBe(1);
    graph.checkpoint();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("returns no impact for an unknown tool", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-trellis-"));
    const graph = new AgentGraph(path.join(dir, "graph"));
    await graph.initialize();
    expect(graph.getImpact("missing-tool")).toBeNull();
    graph.checkpoint();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
