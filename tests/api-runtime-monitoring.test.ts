import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/server/api";
import { AgentGraph } from "../src/server/graph";

describe("runtime telemetry API", () => {
  const previousToken = process.env.AGENT_TRELLIS_RUNTIME_TOKEN;

  afterEach(() => {
    if (previousToken === undefined) delete process.env.AGENT_TRELLIS_RUNTIME_TOKEN;
    else process.env.AGENT_TRELLIS_RUNTIME_TOKEN = previousToken;
  });

  it("requires a token and persists only normalized, idempotent runtime evidence", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-trellis-runtime-"));
    const graph = new AgentGraph(path.join(root, "graph"));
    await graph.initialize();
    const server = {
      id: "mcp-runtime-test",
      hostId: "mcp-runtime-host",
      hostName: "Runtime test host",
      source: "test",
      configPath: path.join(root, ".mcp.json"),
      configScope: "workspace",
      name: "runtime-test",
      transport: "http" as const,
      endpoint: "https://runtime.example.test/mcp",
      argumentCount: 0,
      environmentKeys: [],
      headerNames: [],
      credentialHints: false
    };
    graph.syncMcpDiscovery({ scannedConfigPaths: [server.configPath], servers: [server], diagnostics: [] });
    graph.recordMcpInspection({
      serverId: server.id,
      serverName: server.name,
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
      tools: [{
        name: "write_file",
        description: "Write a file to the workspace.",
        inputSchema: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } } }
      }]
    });
    const app = createApp(graph);
    const event = {
      eventId: "runtime-event-001",
      executionId: "execution-001",
      serverId: server.id,
      toolName: "write_file",
      eventType: "SIDE_EFFECT_OBSERVED",
      effect: "filesystem_write",
      agentId: "agent-support",
      observedAt: "2026-11-20T12:01:00.000Z",
      durationMs: 41
    };

    try {
      delete process.env.AGENT_TRELLIS_RUNTIME_TOKEN;
      await request(app).post("/api/runtime/events").send(event).expect(503);

      process.env.AGENT_TRELLIS_RUNTIME_TOKEN = "test-runtime-token";
      await request(app).post("/api/runtime/events").set("x-agent-trellis-token", "wrong").send(event).expect(401);

      const stored = await request(app)
        .post("/api/runtime/events")
        .set("x-agent-trellis-token", "test-runtime-token")
        .send(event)
        .expect(201);
      expect(stored.body.duplicate).toBe(false);

      const duplicate = await request(app)
        .post("/api/runtime/events")
        .set("x-agent-trellis-token", "test-runtime-token")
        .send(event)
        .expect(200);
      expect(duplicate.body.duplicate).toBe(true);

      const monitoring = await request(app).get("/api/runtime/monitoring").expect(200);
      expect(monitoring.body.telemetryConfigured).toBe(true);
      expect(monitoring.body.summary.totalEvents).toBe(1);
      expect(monitoring.body.summary.sideEffects).toBe(1);
      expect(monitoring.body.summary.highSeveritySideEffects).toBe(1);
      expect(monitoring.body.provenance).toEqual({ gatewayObserved: 0, adapterReported: 1 });
      expect(monitoring.body.events[0].sourceKind).toBe("adapter_reported");
      expect(monitoring.body.events[0].toolName).toBe("write_file");
      expect(monitoring.body.events[0]).not.toHaveProperty("arguments");
      expect(monitoring.body.events[0]).not.toHaveProperty("input");
      expect(monitoring.body.events[0]).not.toHaveProperty("output");

      await request(app)
        .post("/api/runtime/events")
        .set("x-agent-trellis-token", "test-runtime-token")
        .send({ ...event, eventId: "runtime-event-002", arguments: { content: "private" } })
        .expect(400);
    } finally {
      graph.checkpoint();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
