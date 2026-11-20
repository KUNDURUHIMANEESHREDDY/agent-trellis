import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { AgentGraph } from "../src/server/graph";
import { createApp } from "../src/server/api";
import { discoverMcpConfigurations } from "../src/server/discovery";

describe("MCP inspection approval API", () => {
  const previousWorkspaceRoots = process.env.AGENT_TRELLIS_WORKSPACES;

  afterEach(() => {
    if (previousWorkspaceRoots === undefined) delete process.env.AGENT_TRELLIS_WORKSPACES;
    else process.env.AGENT_TRELLIS_WORKSPACES = previousWorkspaceRoots;
  });

  it("shows a redacted stdio execution preview and refuses to launch without explicit approval", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-trellis-inspection-api-"));
    const workspace = path.join(root, "workspace");
    const databasePath = path.join(root, "graph");
    fs.mkdirSync(workspace, { recursive: true });

    const configPath = path.join(workspace, ".mcp.json");
    fs.writeFileSync(configPath, JSON.stringify({
      mcpServers: {
        protectedServer: {
          command: "node",
          args: [
            "--token", "top-secret-token",
            "--api-key=inline-secret",
            "https://user:pass@example.test/mcp?api_key=query-secret"
          ],
          cwd: ".",
          env: { API_TOKEN: "environment-secret" }
        }
      }
    }), "utf8");

    process.env.AGENT_TRELLIS_WORKSPACES = workspace;
    const discovery = discoverMcpConfigurations({ workspaceRoots: [process.cwd(), workspace] });
    const server = discovery.servers.find((item) => item.name === "protectedServer");
    expect(server).toBeDefined();
    expect(server?.transport).toBe("stdio");

    const graph = new AgentGraph(databasePath);
    await graph.initialize();
    graph.syncMcpDiscovery(discovery);
    const app = createApp(graph);

    try {
      const preview = await request(app)
        .get("/api/inspection/mcp/" + server!.id + "/approval-preview")
        .expect(200);

      expect(preview.body.command).toBe("node");
      expect(preview.body.cwd).toBe(workspace);
      expect(preview.body.args).toEqual([
        "--token",
        "[REDACTED]",
        "--api-key=[REDACTED]",
        "https://[REDACTED]@example.test/mcp?api_key=[REDACTED]"
      ]);
      expect(preview.body.environmentKeys).toEqual(["API_TOKEN"]);
      const serializedPreview = JSON.stringify(preview.body);
      for (const secret of ["top-secret-token", "inline-secret", "query-secret", "environment-secret", "user:pass"]) {
        expect(serializedPreview).not.toContain(secret);
      }

      await request(app)
        .post("/api/inspection/mcp/" + server!.id)
        .send({ approveStdio: false })
        .expect(428);
      expect(graph.getMcpInspections()).toHaveLength(0);
    } finally {
      graph.checkpoint();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
