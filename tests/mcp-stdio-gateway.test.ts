import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { createApp } from "../src/server/api";
import { discoverMcpConfigurations } from "../src/server/discovery";
import { AgentGraph } from "../src/server/graph";

const envKeys = [
  "AGENT_TRELLIS_RUNTIME_TOKEN",
  "AGENT_TRELLIS_RUNTIME_GATEWAY_TOKEN",
  "AGENT_TRELLIS_RUNTIME_OBSERVER_TOKEN",
  "AGENT_TRELLIS_RUNTIME_STDIO",
  "AGENT_TRELLIS_RUNTIME_OBSERVE_FILESYSTEM",
  "AGENT_TRELLIS_RUNTIME_WATCH_PATHS",
  "AGENT_TRELLIS_WORKSPACES",
  "AGENT_TRELLIS_API_URL"
] as const;
const previousEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));

afterEach(() => {
  for (const key of envKeys) {
    const previous = previousEnv[key];
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  }
});

async function listen(server: http.Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("The AgentTrellis API did not bind.");
  return "http://127.0.0.1:" + address.port;
}

async function close(server: http.Server): Promise<void> {
  server.closeAllConnections();
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

describe("stdio MCP runtime gateway", () => {
  it("proxies a real local MCP process and independently observes its filesystem change", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-trellis-stdio-gateway-"));
    const configRoot = path.join(root, "config");
    const workRoot = path.join(root, "workspace");
    const graphRoot = path.join(root, "graph-db");
    fs.mkdirSync(configRoot, { recursive: true });
    fs.mkdirSync(workRoot, { recursive: true });
    let graph: AgentGraph | undefined;
    let apiServer: http.Server | undefined;
    let client: Client | undefined;
    try {
      const outputFile = path.join(workRoot, "created-during-call", "observed-output.txt");
      const leakFile = path.join(workRoot, "proxy-token-leak.txt");
      const upstreamProgram = [
        "const fs = require('node:fs');",
        "const path = require('node:path');",
        "if (process.env.AGENT_TRELLIS_RUNTIME_GATEWAY_TOKEN || process.env.AGENT_TRELLIS_RUNTIME_OBSERVER_TOKEN || process.env.AGENT_TRELLIS_API_URL) fs.writeFileSync(process.env.LEAK_TARGET, 'proxy credential leaked');",
        "const readline = require('node:readline').createInterface({ input: process.stdin, crlfDelay: Infinity });",
        "readline.on('line', (line) => {",
        "  let message; try { message = JSON.parse(line); } catch { return; }",
        "  if (message.method === 'notifications/initialized') return;",
        "  let result = {};",
        "  if (message.method === 'initialize') result = { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'stdio-fixture', version: '1.0' } };",
        "  else if (message.method === 'tools/list') result = { tools: [{ name: 'write_file', description: 'Write a workspace file', inputSchema: { type: 'object' } }, { name: 'write_big', description: 'Return a large response', inputSchema: { type: 'object' } }, { name: 'return_uncorrelated', inputSchema: { type: 'object' } }, { name: 'return_without_result', inputSchema: { type: 'object' } }] };",
        "  else if (message.method === 'tools/call' && message.params.name === 'write_big') result = { content: [{ type: 'text', text: 'x'.repeat(300 * 1024) }] };",
        "  else if (message.method === 'tools/call' && message.params.name === 'write_file') { fs.mkdirSync(path.dirname(process.env.FILE_WRITE_TARGET), { recursive: true }); setTimeout(() => { fs.writeFileSync(process.env.FILE_WRITE_TARGET, 'observed by the OS watcher'); process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: 'done' }] } }) + '\\n'); }, 250); return; }",
        "  if (message.id !== undefined) {",
        "    if (message.method === 'tools/call' && message.params.name === 'return_uncorrelated') process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id + 1000, result: { content: [] } }) + '\\n');",
        "    else if (message.method === 'tools/call' && message.params.name === 'return_without_result') process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id }) + '\\n');",
        "    else process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\\n');",
        "  }",
        "});"
      ].join("\n");
      fs.writeFileSync(path.join(configRoot, ".mcp.json"), JSON.stringify({
        mcpServers: {
          localFiles: {
            type: "stdio",
            command: process.execPath,
            args: ["-e", upstreamProgram],
            cwd: workRoot,
            env: {
              FILE_WRITE_TARGET: outputFile,
              LEAK_TARGET: leakFile,
              AGENT_TRELLIS_RUNTIME_GATEWAY_TOKEN: "must-not-reach-upstream",
              AGENT_TRELLIS_RUNTIME_OBSERVER_TOKEN: "must-not-reach-upstream",
              AGENT_TRELLIS_API_URL: "http://must-not-reach-upstream.invalid"
            }
          }
        }
      }));
      process.env.AGENT_TRELLIS_RUNTIME_TOKEN = "runtime-ingestion-token";
      process.env.AGENT_TRELLIS_RUNTIME_GATEWAY_TOKEN = "runtime-gateway-token";
      process.env.AGENT_TRELLIS_RUNTIME_OBSERVER_TOKEN = "runtime-observer-token";
      process.env.AGENT_TRELLIS_RUNTIME_STDIO = "true";
      process.env.AGENT_TRELLIS_RUNTIME_OBSERVE_FILESYSTEM = "true";
      process.env.AGENT_TRELLIS_RUNTIME_WATCH_PATHS = workRoot;
      process.env.AGENT_TRELLIS_WORKSPACES = configRoot;

      graph = new AgentGraph(path.join(graphRoot, "graph"));
      await graph.initialize();
      const discovery = discoverMcpConfigurations({ workspaceRoots: [process.cwd(), configRoot] });
      graph.syncMcpDiscovery(discovery);
      const server = discovery.servers.find((item) => item.name === "localFiles");
      expect(server?.transport).toBe("stdio");
      graph.recordMcpInspection({
        serverId: server!.id, serverName: server!.name, inspectedAt: new Date().toISOString(),
        success: true, transport: "stdio", declaredCapabilities: ["tools"], observedCapabilities: ["tools"],
        capabilityComparisons: [{ capability: "tools", declared: true, observed: true, status: "consistent" }],
        tools: [
          { name: "write_file", inputSchema: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } } } },
          { name: "write_big", inputSchema: { type: "object" } },
          { name: "return_uncorrelated", inputSchema: { type: "object" } },
          { name: "return_without_result", inputSchema: { type: "object" } }
        ]
      });

      apiServer = createApp(graph).listen(0, "127.0.0.1");
      const apiUrl = await listen(apiServer);
      process.env.AGENT_TRELLIS_API_URL = apiUrl;
      const gatewayScript = path.join(process.cwd(), "src", "server", "mcp-stdio-gateway.ts");
      const childEnv = Object.fromEntries(
        Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string")
      );
      client = new Client({ name: "stdio-gateway-integration-test", version: "1.0.0" });
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: ["--import", "tsx", gatewayScript, "--server-id", server!.id],
        env: childEnv
      });
      await client.connect(transport);
      const result = await client.callTool({
        name: "write_file",
        arguments: { path: outputFile, content: "private content not to be logged" }
      });
      expect(result.isError).not.toBe(true);
      expect(fs.readFileSync(outputFile, "utf8")).toBe("observed by the OS watcher");
      const bigResult = await client.callTool({ name: "write_big", arguments: {} });
      expect(bigResult.isError).not.toBe(true);
      expect(String((bigResult.content as Array<{ text?: string }>)[0]?.text).length).toBe(300 * 1024);
      void client.callTool({ name: "return_uncorrelated", arguments: {} }).catch(() => undefined);
      for (let attempt = 0; attempt < 80; attempt += 1) {
        if (graph.getRuntimeMonitoring().events.some((event: any) =>
          event.eventType === "CALL_OUTCOME_UNKNOWN" && event.errorCode === "UNCORRELATED_RESPONSE"
        )) break;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      void client.callTool({ name: "return_without_result", arguments: {} }).catch(() => undefined);
      for (let attempt = 0; attempt < 80; attempt += 1) {
        const monitoring = graph.getRuntimeMonitoring();
        if (monitoring.summary.callsStarted >= 4 &&
            monitoring.events.some((event: any) => event.errorCode === "RESPONSE_WITHOUT_RESULT")) break;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(fs.existsSync(leakFile)).toBe(false);

      await new Promise((resolve) => setTimeout(resolve, 450));
      const monitoring = graph.getRuntimeMonitoring();
      expect(monitoring.summary.callsStarted).toBe(4);
      expect(monitoring.summary.callsSucceeded).toBe(1);
      expect(monitoring.summary.callsOutcomeUnknown).toBe(3);
      const unknownCodes = monitoring.events
        .filter((event: any) => event.eventType === "CALL_OUTCOME_UNKNOWN")
        .map((event: any) => event.errorCode);
      expect(unknownCodes).toContain("RESPONSE_TOO_LARGE");
      expect(unknownCodes).toContain("UNCORRELATED_RESPONSE");
      expect(unknownCodes).toContain("RESPONSE_WITHOUT_RESULT");
      expect(monitoring.provenance.gatewayObserved).toBe(8);
      expect(monitoring.provenance.independentObserver).toBeGreaterThanOrEqual(1);
      expect(monitoring.independentObservations.total).toBeGreaterThanOrEqual(1);
      expect(monitoring.independentObservations.events.reduce(
        (total: number, event: any) => total + Number(event.eventCount ?? 0), 0
      )).toBeGreaterThanOrEqual(2);
      const observation = monitoring.independentObservations.events[0];
      expect(observation.effect).toBe("filesystem_write");
      expect(observation.observer).toBe("host-filesystem-watcher");
      expect(["single_active_call", "multiple_active_calls", "no_active_call", "ambiguous"]).toContain(observation.correlation);
      if (observation.correlation === "single_active_call") {
        expect(observation.toolName).toBe("write_file");
        expect(observation.executionId).toBeTruthy();
      } else {
        expect(observation.toolName).toBeUndefined();
        expect(observation.executionId).toBeUndefined();
      }
      const evidence = JSON.stringify({
        runtime: monitoring.events,
        observations: monitoring.independentObservations.events
      });
      expect(evidence).not.toContain(outputFile);
      expect(evidence).not.toContain("private content not to be logged");
    } finally {
      await client?.close().catch(() => {});
      if (apiServer) await close(apiServer);
      graph?.checkpoint();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
