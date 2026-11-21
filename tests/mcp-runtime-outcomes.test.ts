import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/server/api";
import { discoverMcpConfigurations } from "../src/server/discovery";
import { AgentGraph } from "../src/server/graph";

const previousToken = process.env.AGENT_TRELLIS_RUNTIME_TOKEN;
const previousObserverToken = process.env.AGENT_TRELLIS_RUNTIME_OBSERVER_TOKEN;
const previousRoots = process.env.AGENT_TRELLIS_WORKSPACES;

afterEach(() => {
  if (previousToken === undefined) delete process.env.AGENT_TRELLIS_RUNTIME_TOKEN;
  else process.env.AGENT_TRELLIS_RUNTIME_TOKEN = previousToken;
  if (previousObserverToken === undefined) delete process.env.AGENT_TRELLIS_RUNTIME_OBSERVER_TOKEN;
  else process.env.AGENT_TRELLIS_RUNTIME_OBSERVER_TOKEN = previousObserverToken;
  if (previousRoots === undefined) delete process.env.AGENT_TRELLIS_WORKSPACES;
  else process.env.AGENT_TRELLIS_WORKSPACES = previousRoots;
});

async function listen(server: http.Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test upstream did not bind.");
  return "http://127.0.0.1:" + address.port;
}

async function close(server: http.Server): Promise<void> {
  server.closeAllConnections();
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

describe("runtime outcome completeness and independent observation", () => {
  it("terminalizes oversized, unparseable and uncorrelated Streamable HTTP responses", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-trellis-terminal-outcomes-"));
    let graph: AgentGraph | undefined;
    let upstream: http.Server | undefined;
    let responseBody = "";
    let responseType = "application/json";
    try {
      upstream = http.createServer((_req, res) => {
        res.writeHead(200, { "content-type": responseType });
        res.end(responseBody);
      });
      const upstreamUrl = await listen(upstream);
      process.env.AGENT_TRELLIS_RUNTIME_TOKEN = "terminal-test-token";
      process.env.AGENT_TRELLIS_WORKSPACES = root;
      fs.writeFileSync(path.join(root, ".mcp.json"), JSON.stringify({
        mcpServers: { terminalTest: { type: "http", url: upstreamUrl + "/mcp" } }
      }));
      graph = new AgentGraph(path.join(root, "graph"));
      await graph.initialize();
      const discovery = discoverMcpConfigurations({ workspaceRoots: [process.cwd(), root] });
      graph.syncMcpDiscovery(discovery);
      const server = discovery.servers.find((item) => item.name === "terminalTest");
      expect(server).toBeDefined();
      graph.recordMcpInspection({
        serverId: server!.id, serverName: server!.name, inspectedAt: new Date().toISOString(),
        success: true, transport: "http", declaredCapabilities: ["tools"], observedCapabilities: ["tools"],
        capabilityComparisons: [{ capability: "tools", declared: true, observed: true, status: "consistent" }],
        tools: [{ name: "probe", inputSchema: { type: "object" } }]
      });
      const app = createApp(graph);
      const cases = [
        { id: 11, body: "not-json", contentType: "text/plain", errorCode: "UNPARSEABLE_RESPONSE" },
        { id: 12, body: JSON.stringify({ jsonrpc: "2.0", id: 999, result: {} }), contentType: "application/json", errorCode: "UNCORRELATED_RESPONSE" },
        { id: 13, body: JSON.stringify({ jsonrpc: "2.0", id: 13, result: { data: "x".repeat(300 * 1024) } }), contentType: "application/json", errorCode: "RESPONSE_TOO_LARGE" }
      ];
      for (const item of cases) {
        responseBody = item.body;
        responseType = item.contentType;
        await request(app)
          .post("/api/runtime/mcp/" + server!.id)
          .set("x-agent-trellis-token", "terminal-test-token")
          .send({ jsonrpc: "2.0", id: item.id, method: "tools/call", params: { name: "probe", arguments: { secret: "must-not-persist" } } })
          .expect(200);
      }
      responseType = "text/event-stream";
      responseBody = "event: message\ndata: " + JSON.stringify({ jsonrpc: "2.0", id: 14, result: { content: [{ type: "text", text: "stream-result" }] } }) + "\n\n";
      await request(app)
        .post("/api/runtime/mcp/" + server!.id)
        .set("x-agent-trellis-token", "terminal-test-token")
        .send({ jsonrpc: "2.0", id: 14, method: "tools/call", params: { name: "probe", arguments: {} } })
        .expect(200);

      const monitoring = graph.getRuntimeMonitoring();
      expect(monitoring.summary.callsStarted).toBe(4);
      expect(monitoring.summary.callsSucceeded).toBe(1);
      expect(monitoring.summary.callsOutcomeUnknown).toBe(3);
      expect(monitoring.events.filter((event: any) => event.eventType === "CALL_STARTED")).toHaveLength(4);
      const terminals = monitoring.events.filter((event: any) => event.eventType === "CALL_OUTCOME_UNKNOWN");
      expect(terminals).toHaveLength(3);
      expect(terminals.map((event: any) => event.errorCode).sort()).toEqual([
        "RESPONSE_TOO_LARGE", "UNCORRELATED_RESPONSE", "UNPARSEABLE_RESPONSE"
      ]);
      const eventsByExecution = new Map<string, any[]>();
      for (const event of monitoring.events) {
        const rows = eventsByExecution.get(String(event.executionId)) ?? [];
        rows.push(event);
        eventsByExecution.set(String(event.executionId), rows);
      }
      expect([...eventsByExecution.values()].every((rows) =>
        rows.filter((event) => event.eventType === "CALL_STARTED").length === 1 &&
        rows.filter((event) => event.eventType !== "CALL_STARTED").length === 1
      )).toBe(true);
      expect(JSON.stringify(monitoring.events)).not.toContain("must-not-persist");
    } finally {
      if (upstream) await close(upstream);
      graph?.checkpoint();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps terminal lifecycle evidence valid after the inspected tool inventory changes", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-trellis-runtime-inventory-change-"));
    const graph = new AgentGraph(path.join(root, "graph"));
    try {
      await graph.initialize();
      const server = {
        id: "mcp-terminal-inventory",
        hostId: "mcp-terminal-host",
        hostName: "Terminal inventory test",
        source: "test",
        configPath: path.join(root, ".mcp.json"),
        configScope: "workspace",
        name: "terminal-inventory",
        transport: "http" as const,
        endpoint: "https://terminal.example.test/mcp",
        argumentCount: 0,
        environmentKeys: [],
        headerNames: [],
        credentialHints: false
      };
      graph.syncMcpDiscovery({ scannedConfigPaths: [server.configPath], servers: [server], diagnostics: [] });
      const snapshot = (tools: Array<Record<string, unknown>>) => ({
        serverId: server.id, serverName: server.name, inspectedAt: new Date().toISOString(),
        success: true, transport: "http", declaredCapabilities: ["tools"], observedCapabilities: ["tools"],
        capabilityComparisons: [{ capability: "tools", declared: true, observed: true, status: "consistent" }],
        tools
      });
      graph.recordMcpInspection(snapshot([{ name: "temporary_tool", inputSchema: { type: "object" } }]) as any);
      const terminalBeforeStart = graph.recordRuntimeEvent({
        eventId: "inventory-terminal-before-start", executionId: "never-started-exec", serverId: server.id,
        toolName: "temporary_tool", eventType: "CALL_OUTCOME_UNKNOWN", observedAt: new Date().toISOString(),
        errorCode: "MISSING_START"
      }, "gateway_observed");
      expect(terminalBeforeStart.ok).toBe(false);
      expect((terminalBeforeStart as any).status).toBe(409);

      const started = graph.recordRuntimeEvent({
        eventId: "inventory-start-001", executionId: "inventory-exec-001", serverId: server.id,
        toolName: "temporary_tool", eventType: "CALL_STARTED", observedAt: new Date().toISOString()
      }, "gateway_observed");
      expect(started.ok).toBe(true);

      graph.recordMcpInspection(snapshot([]) as any);
      const terminalEvent = {
        eventId: "inventory-terminal-001", executionId: "inventory-exec-001", serverId: server.id,
        toolName: "temporary_tool", eventType: "CALL_SUCCEEDED" as const, observedAt: new Date().toISOString()
      };
      const completed = graph.recordRuntimeEvent(terminalEvent, "gateway_observed");
      expect(completed.ok).toBe(true);
      const duplicate = graph.recordRuntimeEvent(terminalEvent, "gateway_observed");
      expect(duplicate.ok).toBe(true);
      expect((duplicate as any).duplicate).toBe(true);

      const secondTerminal = graph.recordRuntimeEvent({
        eventId: "inventory-terminal-002", executionId: "inventory-exec-001", serverId: server.id,
        toolName: "temporary_tool", eventType: "CALL_OUTCOME_UNKNOWN", observedAt: new Date().toISOString(),
        errorCode: "LATE_TIMEOUT"
      }, "gateway_observed");
      expect(secondTerminal.ok).toBe(false);
      expect(graph.getRuntimeMonitoring().summary.callsStarted).toBe(1);
      expect(graph.getRuntimeMonitoring().summary.callsSucceeded).toBe(1);
      expect(graph.getRuntimeMonitoring().summary.callsOutcomeUnknown).toBe(0);
    } finally {
      graph.checkpoint();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("stores separately authenticated, metadata-only host side-effect observations", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-trellis-independent-observer-"));
    const graph = new AgentGraph(path.join(root, "graph"));
    try {
      await graph.initialize();
      const server = {
        id: "mcp-independent-test",
        hostId: "mcp-independent-host",
        hostName: "Independent observer test",
        source: "test",
        configPath: path.join(root, ".mcp.json"),
        configScope: "workspace",
        name: "local-files",
        transport: "stdio" as const,
        command: "node",
        argumentCount: 0,
        environmentKeys: [],
        headerNames: [],
        credentialHints: false
      };
      graph.syncMcpDiscovery({ scannedConfigPaths: [server.configPath], servers: [server], diagnostics: [] });
      graph.recordMcpInspection({
        serverId: server.id, serverName: server.name, inspectedAt: new Date().toISOString(),
        success: true, transport: "stdio", declaredCapabilities: ["tools"], observedCapabilities: ["tools"],
        capabilityComparisons: [{ capability: "tools", declared: true, observed: true, status: "consistent" }],
        tools: [{ name: "write_file", inputSchema: { type: "object" } }]
      });
      process.env.AGENT_TRELLIS_RUNTIME_OBSERVER_TOKEN = "observer-secret-token";
      const event = {
        observationId: "filesystem-observation-001",
        serverId: server.id,
        effect: "filesystem_write",
        observer: "host-filesystem-watcher",
        observedAt: new Date().toISOString(),
        eventCount: 4,
        correlation: "single_active_call",
        executionId: "stdio-exec-001",
        toolName: "write_file"
      };
      const app = createApp(graph);
      await request(app)
        .post("/api/runtime/independent-observations")
        .set("x-agent-trellis-observer-token", "wrong")
        .send(event).expect(401);
      await request(app)
        .post("/api/runtime/independent-observations")
        .set("x-agent-trellis-observer-token", "observer-secret-token")
        .send(event).expect(201);
      const monitoring = graph.getRuntimeMonitoring();
      expect(monitoring.provenance.independentObserver).toBe(1);
      expect(monitoring.independentObservations.total).toBe(1);
      expect(monitoring.independentObservations.events[0].sourceKind).toBe("independent_observer");
      expect(monitoring.independentObservations.events[0].correlatedExecutionId).toBe("stdio-exec-001");
      expect(JSON.stringify(monitoring.independentObservations.events)).not.toContain(root);
      await request(app)
        .post("/api/runtime/independent-observations")
        .set("x-agent-trellis-observer-token", "observer-secret-token")
        .send({ ...event, observationId: "bad-extra-field", path: "must-be-rejected" }).expect(400);
    } finally {
      graph.checkpoint();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
