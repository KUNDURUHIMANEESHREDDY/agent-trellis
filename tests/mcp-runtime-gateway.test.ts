import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Client, SSEClientTransport, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createApp } from "../src/server/api";
import { discoverMcpConfigurations } from "../src/server/discovery";
import { AgentGraph } from "../src/server/graph";

const previousToken = process.env.AGENT_TRELLIS_RUNTIME_TOKEN;
const previousRoots = process.env.AGENT_TRELLIS_WORKSPACES;
const previousSecret = process.env.TRELLIS_TEST_UPSTREAM_SECRET;
const previousGatewayToken = process.env.AGENT_TRELLIS_RUNTIME_GATEWAY_TOKEN;
const previousObserverToken = process.env.AGENT_TRELLIS_RUNTIME_OBSERVER_TOKEN;

afterEach(() => {
  if (previousToken === undefined) delete process.env.AGENT_TRELLIS_RUNTIME_TOKEN;
  else process.env.AGENT_TRELLIS_RUNTIME_TOKEN = previousToken;
  if (previousRoots === undefined) delete process.env.AGENT_TRELLIS_WORKSPACES;
  else process.env.AGENT_TRELLIS_WORKSPACES = previousRoots;
  if (previousSecret === undefined) delete process.env.TRELLIS_TEST_UPSTREAM_SECRET;
  else process.env.TRELLIS_TEST_UPSTREAM_SECRET = previousSecret;
  if (previousGatewayToken === undefined) delete process.env.AGENT_TRELLIS_RUNTIME_GATEWAY_TOKEN;
  else process.env.AGENT_TRELLIS_RUNTIME_GATEWAY_TOKEN = previousGatewayToken;
  if (previousObserverToken === undefined) delete process.env.AGENT_TRELLIS_RUNTIME_OBSERVER_TOKEN;
  else process.env.AGENT_TRELLIS_RUNTIME_OBSERVER_TOKEN = previousObserverToken;
});

async function listen(server: http.Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test server did not bind.");
  return "http://127.0.0.1:" + address.port;
}

async function close(server: http.Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

describe("MCP runtime gateway", () => {
  it("observes correlated tool calls while redacting arguments and results", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-trellis-gateway-"));
    let graph: AgentGraph | undefined;
    let upstream: http.Server | undefined;
    let gateway: http.Server | undefined;
    let upstreamHeaders: http.IncomingHttpHeaders | undefined;
    let upstreamCall: Record<string, unknown> | undefined;
    try {
      upstream = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (chunk: Buffer) => chunks.push(chunk));
        req.on("end", () => {
          upstreamHeaders = req.headers;
          const payload = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
          if (payload.method === "notifications/initialized") {
            res.writeHead(202).end();
            return;
          }
          let result: Record<string, unknown>;
          if (payload.method === "initialize") {
            result = {
              protocolVersion: "2025-03-26",
              capabilities: { tools: {} },
              serverInfo: { name: "gateway-test", version: "1.0.0" }
            };
          } else if (payload.method === "tools/list") {
            result = { tools: [
              { name: "write_file", description: "Write a file", inputSchema: { type: "object" } },
              { name: "fail_call", description: "Return a tool error", inputSchema: { type: "object" } }
            ] };
          } else if (payload.method === "tools/call") {
            upstreamCall = payload as Record<string, unknown>;
            result = payload.params?.name === "fail_call"
              ? { isError: true, content: [{ type: "text", text: "private remote failure detail" }] }
              : { content: [{ type: "text", text: "private remote result body" }] };
          } else {
            res.writeHead(400).end();
            return;
          }
          res.writeHead(200, {
            "content-type": "application/json",
            "mcp-session-id": "gateway-test-session"
          });
          res.end(JSON.stringify({ jsonrpc: "2.0", id: payload.id, result }));
        });
      });
      const upstreamUrl = await listen(upstream);
      process.env.TRELLIS_TEST_UPSTREAM_SECRET = "upstream-secret-value";
      process.env.AGENT_TRELLIS_RUNTIME_TOKEN = "gateway-test-token";
      fs.writeFileSync(path.join(root, ".mcp.json"), JSON.stringify({
        mcpServers: {
          gatewayTest: {
            type: "http",
            url: upstreamUrl + "/mcp",
            headers: { "x-upstream-secret": "${TRELLIS_TEST_UPSTREAM_SECRET}" }
          }
        }
      }));
      process.env.AGENT_TRELLIS_WORKSPACES = root;
      graph = new AgentGraph(path.join(root, "graph"));
      await graph.initialize();
      const discovery = discoverMcpConfigurations({ workspaceRoots: [process.cwd(), root] });
      graph.syncMcpDiscovery(discovery);
      const server = discovery.servers.find((item) => item.name === "gatewayTest");
      expect(server).toBeDefined();
      graph.recordMcpInspection({
        serverId: server!.id, serverName: server!.name, inspectedAt: new Date().toISOString(),
        success: true, transport: "http", declaredCapabilities: ["tools"], observedCapabilities: ["tools"],
        capabilityComparisons: [{ capability: "tools", declared: true, observed: true, status: "consistent" }],
        tools: [
          { name: "write_file", inputSchema: { type: "object" } },
          { name: "fail_call", inputSchema: { type: "object" } }
        ]
      });
      const appServer = createApp(graph).listen(0, "127.0.0.1");
      gateway = appServer;
      const gatewayUrl = await new Promise<string>((resolve, reject) => {
        appServer.once("error", reject);
        appServer.once("listening", () => {
          const address = appServer.address();
          if (!address || typeof address === "string") return reject(new Error("Gateway did not bind."));
          resolve("http://127.0.0.1:" + address.port);
        });
      });
      const endpoint = new URL(gatewayUrl + "/api/runtime/mcp/" + server!.id);
      const client = new Client({ name: "gateway-test-client", version: "1.0.0" });
      const transport = new StreamableHTTPClientTransport(endpoint, {
        requestInit: { headers: { "x-agent-trellis-token": "gateway-test-token" } }
      });
      try {
        await client.connect(transport);
        const success = await client.callTool({
          name: "write_file",
          arguments: { path: "/private/path", content: "private file content must not be stored" }
        });
        expect(success.isError).not.toBe(true);
        const failure = await client.callTool({ name: "fail_call", arguments: {} });
        expect(failure.isError).toBe(true);
      } finally {
        await client.close();
      }
      expect(upstreamHeaders?.["x-upstream-secret"]).toBe("upstream-secret-value");
      expect(upstreamHeaders?.["x-agent-trellis-token"]).toBeUndefined();
      expect((upstreamCall?.params as Record<string, unknown>).name).toBe("fail_call");

      const monitoring = graph.getRuntimeMonitoring();
      expect(monitoring.provenance).toEqual({ gatewayObserved: 4, adapterReported: 0, independentObserver: 0 });
      expect(monitoring.summary.callsStarted).toBe(2);
      expect(monitoring.summary.callsSucceeded).toBe(1);
      expect(monitoring.summary.callsFailed).toBe(1);
      expect(monitoring.events.every((event: any) => event.sourceKind === "gateway_observed")).toBe(true);
      const evidenceText = JSON.stringify(monitoring.events);
      expect(evidenceText).not.toContain("private file content");
      expect(evidenceText).not.toContain("private remote result body");
      expect(evidenceText).not.toContain("private remote failure detail");
      expect(evidenceText).not.toContain("/private/path");
    } finally {
      if (gateway) await close(gateway);
      if (upstream) await close(upstream);
      graph?.checkpoint();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("relays legacy SSE sessions and correlates asynchronous tool responses", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-trellis-sse-gateway-"));
    let graph: AgentGraph | undefined;
    let upstream: http.Server | undefined;
    let gateway: http.Server | undefined;
    let sseConnection: http.ServerResponse | undefined;
    let client: Client | undefined;
    try {
      upstream = http.createServer((req, res) => {
        if (req.method === "GET" && req.url?.startsWith("/sse")) {
          sseConnection = res;
          res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
          res.write("event: endpoint\ndata: /messages?sessionId=legacy-session\n\n");
          return;
        }
        if (req.method === "POST" && req.url?.startsWith("/messages")) {
          const chunks: Buffer[] = [];
          req.on("data", (chunk: Buffer) => chunks.push(chunk));
          req.on("end", () => {
            const message = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            if (message.id !== undefined) {
              if (message.method === "tools/call") sseConnection?.write(": keepalive\n\n");
              let result: Record<string, unknown>;
              if (message.method === "initialize") {
                result = { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "legacy-sse", version: "1.0" } };
              } else if (message.method === "tools/list") {
                result = { tools: [{ name: "read_file", inputSchema: { type: "object" } }] };
              } else if (message.method === "tools/call") {
                result = { content: [{ type: "text", text: "legacy SSE result" }] };
              } else {
                result = {};
              }
              sseConnection?.write("event: message\ndata: " + JSON.stringify({
                jsonrpc: "2.0", id: message.id, result
              }) + "\n\n");
            }
            res.writeHead(202).end();
          });
          return;
        }
        res.writeHead(404).end();
      });
      const upstreamUrl = await listen(upstream);
      process.env.AGENT_TRELLIS_RUNTIME_TOKEN = "legacy-sse-token";
      fs.writeFileSync(path.join(root, ".mcp.json"), JSON.stringify({
        mcpServers: { legacy: { type: "sse", url: upstreamUrl + "/sse" } }
      }));
      process.env.AGENT_TRELLIS_WORKSPACES = root;
      graph = new AgentGraph(path.join(root, "graph"));
      await graph.initialize();
      const discovery = discoverMcpConfigurations({ workspaceRoots: [process.cwd(), root] });
      graph.syncMcpDiscovery(discovery);
      const server = discovery.servers.find((item) => item.name === "legacy");
      expect(server?.transport).toBe("sse");
      graph.recordMcpInspection({
        serverId: server!.id, serverName: server!.name, inspectedAt: new Date().toISOString(),
        success: true, transport: "sse", declaredCapabilities: ["tools"], observedCapabilities: ["tools"],
        capabilityComparisons: [{ capability: "tools", declared: true, observed: true, status: "consistent" }],
        tools: [{ name: "read_file", inputSchema: { type: "object" } }]
      });
      gateway = createApp(graph).listen(0, "127.0.0.1");
      const gatewayUrl = await new Promise<string>((resolve, reject) => {
        gateway!.once("error", reject);
        gateway!.once("listening", () => {
          const address = gateway!.address();
          if (!address || typeof address === "string") return reject(new Error("Gateway did not bind."));
          resolve("http://127.0.0.1:" + address.port);
        });
      });
      client = new Client({ name: "legacy-sse-gateway-test", version: "1.0.0" });
      await client.connect(new SSEClientTransport(
        new URL(gatewayUrl + "/api/runtime/mcp/" + server!.id),
        { requestInit: { headers: { "x-agent-trellis-token": "legacy-sse-token" } } }
      ));
      const result = await client.callTool({ name: "read_file", arguments: { path: "sensitive" } });
      expect(result.isError).not.toBe(true);
      const monitoring = graph.getRuntimeMonitoring();
      expect(monitoring.summary.callsStarted).toBe(1);
      expect(monitoring.summary.callsSucceeded).toBe(1);
      expect(monitoring.provenance.gatewayObserved).toBe(2);
      expect(JSON.stringify(monitoring.events)).not.toContain("sensitive");
    } finally {
      await client?.close().catch(() => {});
      sseConnection?.end();
      if (gateway) await close(gateway);
      if (upstream) {
        upstream.closeAllConnections();
        await close(upstream);
      }
      graph?.checkpoint();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });


  it("terminalizes oversized legacy SSE responses without attributing their contents", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-trellis-sse-oversized-"));
    let graph: AgentGraph | undefined;
    let upstream: http.Server | undefined;
    let gateway: http.Server | undefined;
    let sseConnection: http.ServerResponse | undefined;
    try {
      upstream = http.createServer((req, res) => {
        if (req.method === "GET" && req.url?.startsWith("/sse")) {
          sseConnection = res;
          res.writeHead(200, { "content-type": "text/event-stream" });
          res.write("event: endpoint\ndata: /messages?sessionId=large-event\n\n");
          return;
        }
        if (req.method === "POST" && req.url?.startsWith("/messages")) {
          const chunks: Buffer[] = [];
          req.on("data", (chunk: Buffer) => chunks.push(chunk));
          req.on("end", () => {
            const message = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            res.writeHead(202).end();
            if (message.method === "tools/call") {
              const payload = JSON.stringify({
                jsonrpc: "2.0",
                id: message.id,
                result: { content: [{ type: "text", text: "private-" + "x".repeat(300 * 1024) }] }
              });
              sseConnection?.write("event: message\ndata: " + payload);
              setTimeout(() => {
                sseConnection?.write("\n\n");
                sseConnection?.end();
              }, 50);
            }
          });
          return;
        }
        res.writeHead(404).end();
      });
      const upstreamUrl = await listen(upstream);
      process.env.AGENT_TRELLIS_RUNTIME_TOKEN = "oversized-sse-token";
      fs.writeFileSync(path.join(root, ".mcp.json"), JSON.stringify({
        mcpServers: { oversizedLegacy: { type: "sse", url: upstreamUrl + "/sse" } }
      }));
      process.env.AGENT_TRELLIS_WORKSPACES = root;
      graph = new AgentGraph(path.join(root, "graph"));
      await graph.initialize();
      const discovery = discoverMcpConfigurations({ workspaceRoots: [process.cwd(), root] });
      graph.syncMcpDiscovery(discovery);
      const server = discovery.servers.find((item) => item.name === "oversizedLegacy");
      expect(server?.transport).toBe("sse");
      graph.recordMcpInspection({
        serverId: server!.id, serverName: server!.name, inspectedAt: new Date().toISOString(),
        success: true, transport: "sse", declaredCapabilities: ["tools"], observedCapabilities: ["tools"],
        capabilityComparisons: [{ capability: "tools", declared: true, observed: true, status: "consistent" }],
        tools: [{ name: "large_tool", inputSchema: { type: "object" } }]
      });
      gateway = createApp(graph).listen(0, "127.0.0.1");
      const gatewayUrl = await listen(gateway);
      const sseResponse = await fetch(gatewayUrl + "/api/runtime/mcp/" + server!.id, {
        headers: { "x-agent-trellis-token": "oversized-sse-token" }
      });
      expect(sseResponse.ok).toBe(true);
      const reader = sseResponse.body!.getReader();
      let received = "";
      while (!received.includes("/messages/")) {
        const next = await reader.read();
        if (next.done) throw new Error("The gateway SSE session closed before the endpoint event.");
        received += new TextDecoder().decode(next.value);
      }
      const endpoint = received.match(/data:\s*(\/api\/runtime\/mcp\/[^\s]+\/messages\/[^\s]+)/);
      expect(endpoint?.[1]).toBeTruthy();
      const post = await fetch(gatewayUrl + endpoint![1], {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-agent-trellis-token": "oversized-sse-token"
        },
        body: JSON.stringify({
          jsonrpc: "2.0", id: 77, method: "tools/call", params: { name: "large_tool", arguments: {} }
        })
      });
      expect(post.status).toBe(202);
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        received += new TextDecoder().decode(next.value);
      }
      const monitoring = graph.getRuntimeMonitoring();
      expect(monitoring.summary.callsStarted).toBe(1);
      expect(monitoring.summary.callsOutcomeUnknown).toBe(1);
      expect(monitoring.events.find((event: any) => event.eventType === "CALL_OUTCOME_UNKNOWN")?.errorCode).toBe("RESPONSE_TOO_LARGE");
      expect(JSON.stringify(monitoring.events)).not.toContain("private-");
      reader.releaseLock();
    } finally {
      sseConnection?.end();
      if (gateway) await close(gateway);
      if (upstream) await close(upstream);
      graph?.checkpoint();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not let an adapter claim gateway-observed provenance in its payload", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-trellis-adapter-provenance-"));
    const graph = new AgentGraph(path.join(root, "graph"));
    try {
      await graph.initialize();
      const server = {
        id: "mcp-adapter-provenance",
        hostId: "mcp-adapter-provenance-host",
        hostName: "Test host",
        source: "test",
        configPath: path.join(root, ".mcp.json"),
        configScope: "workspace",
        name: "adapter-test",
        transport: "http" as const,
        endpoint: "https://adapter.example.test/mcp",
        argumentCount: 0,
        environmentKeys: [],
        headerNames: [],
        credentialHints: false
      };
      graph.syncMcpDiscovery({ scannedConfigPaths: [server.configPath], servers: [server], diagnostics: [] });
      graph.recordMcpInspection({
        serverId: server.id, serverName: server.name, inspectedAt: new Date().toISOString(),
        success: true, transport: "http", declaredCapabilities: ["tools"], observedCapabilities: ["tools"],
        capabilityComparisons: [{ capability: "tools", declared: true, observed: true, status: "consistent" }],
        tools: [{ name: "read_record", inputSchema: { type: "object" } }]
      });
      const app = createApp(graph);
      process.env.AGENT_TRELLIS_RUNTIME_TOKEN = "adapter-test-token";
      const event = {
        eventId: "adapter-event-01", executionId: "adapter-run-01", serverId: server.id,
        toolName: "read_record", eventType: "SIDE_EFFECT_OBSERVED", effect: "filesystem_write",
        observedAt: new Date().toISOString(), sourceKind: "gateway_observed"
      };
      await (await import("supertest")).default(app)
        .post("/api/runtime/events")
        .set("x-agent-trellis-token", "adapter-test-token")
        .send(event).expect(201);
      expect(graph.getRuntimeMonitoring().provenance).toEqual({ gatewayObserved: 0, adapterReported: 1, independentObserver: 0 });
      expect(graph.getRuntimeMonitoring().events[0].sourceKind).toBe("adapter_reported");
    } finally {
      graph.checkpoint();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("requires the runtime token before resolving or forwarding a server", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-trellis-gateway-auth-"));
    const graph = new AgentGraph(path.join(root, "graph"));
    try {
      await graph.initialize();
      process.env.AGENT_TRELLIS_RUNTIME_TOKEN = "auth-test-token";
      const response = await (await import("supertest")).default(createApp(graph))
        .post("/api/runtime/mcp/not-a-server")
        .send({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "anything" } })
        .expect(401);
      expect(response.body.error).toContain("token");
    } finally {
      graph.checkpoint();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
