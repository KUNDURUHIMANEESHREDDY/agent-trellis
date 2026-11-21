import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Server } from "node:http";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createApp } from "../src/server/api";
import { discoverMcpConfigurations, resolveMcpServerConfig } from "../src/server/discovery";
import { AgentGraph } from "../src/server/graph";
import { inspectMcpServer } from "../src/server/mcp-inspector";

const endpoint = "https://mcp.deepwiki.com/mcp";
const repository = "modelcontextprotocol/typescript-sdk";
const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-trellis-live-mcp-"));
const previousToken = process.env.AGENT_TRELLIS_RUNTIME_TOKEN;
const previousRoots = process.env.AGENT_TRELLIS_WORKSPACES;
let graph: AgentGraph | undefined;
let listener: Server | undefined;
let client: Client | undefined;

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

async function main(): Promise<void> {
  const token = randomBytes(32).toString("hex");
  process.env.AGENT_TRELLIS_RUNTIME_TOKEN = token;
  process.env.AGENT_TRELLIS_WORKSPACES = root;
  fs.writeFileSync(path.join(root, ".mcp.json"), JSON.stringify({
    mcpServers: { deepwiki: { type: "http", url: endpoint } }
  }), "utf8");

  graph = new AgentGraph(path.join(root, "graph"));
  await graph.initialize();
  const discovery = discoverMcpConfigurations({ workspaceRoots: [process.cwd(), root] });
  const server = discovery.servers.find((item) => item.name === "deepwiki");
  if (!server) throw new Error("The temporary DeepWiki MCP configuration was not discovered.");
  graph.syncMcpDiscovery(discovery);

  const target = resolveMcpServerConfig(server.id, { workspaceRoots: [process.cwd(), root] });
  if (!target) throw new Error("The live MCP configuration could not be resolved.");
  const inspection = await inspectMcpServer(target);
  if (!inspection.success) throw new Error("DeepWiki MCP inspection failed: " + (inspection.errorSummary ?? "unknown error"));
  graph.recordMcpInspection(inspection);

  const app = createApp(graph);
  listener = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    listener!.once("error", reject);
    listener!.once("listening", resolve);
  });
  const address = listener.address();
  if (!address || typeof address === "string") throw new Error("The local MCP gateway did not bind.");
  const gatewayEndpoint = new URL(
    "http://127.0.0.1:" + address.port + "/api/runtime/mcp/" + server.id
  );

  client = new Client({ name: "agent-trellis-live-validator", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(gatewayEndpoint, {
    requestInit: { headers: { "x-agent-trellis-token": token } }
  });
  await client.connect(transport);
  const tool = inspection.tools.find((item) => item.name === "read_wiki_structure");
  if (!tool) throw new Error("DeepWiki did not expose the expected read-only read_wiki_structure tool.");
  const result = await client.callTool({
    name: "read_wiki_structure",
    arguments: { repoName: repository }
  });
  if (result.isError === true) {
    const detail = Array.isArray(result.content)
      ? result.content.map((item: any) => typeof item.text === "string" ? item.text : "").join(" ").slice(0, 400)
      : "";
    throw new Error("DeepWiki returned an MCP tool error: " + detail);
  }

  const monitoring = graph.getRuntimeMonitoring();
  if (monitoring.provenance.gatewayObserved !== 2 ||
      monitoring.summary.callsStarted !== 1 ||
      monitoring.summary.callsSucceeded !== 1) {
    throw new Error("Gateway evidence did not contain the expected start/success pair.");
  }
  const evidenceText = JSON.stringify(monitoring.events);
  if (evidenceText.includes(repository) || evidenceText.includes(JSON.stringify(result))) {
    throw new Error("MCP request arguments or result content were persisted in runtime evidence.");
  }

  console.log(JSON.stringify({
    externalServer: "DeepWiki",
    endpoint,
    transport: server.transport,
    protocolVersion: inspection.protocolVersion,
    toolsListed: inspection.tools.map((item) => item.name),
    liveToolCall: "read_wiki_structure",
    repository,
    toolCallReturned: true,
    resultIsError: result.isError === true,
    resultContentBlocks: Array.isArray(result.content) ? result.content.length : 0,
    runtimeProvenance: monitoring.provenance,
    runtimeCallCounts: {
      started: monitoring.summary.callsStarted,
      succeeded: monitoring.summary.callsSucceeded,
      failed: monitoring.summary.callsFailed
    },
    evidenceSource: monitoring.events.map((event: any) => event.sourceKind),
    rawArgumentsAndResultsPersisted: false
  }, null, 2));
}

main().catch((error) => {
  console.error("Live MCP gateway validation failed:", error instanceof Error ? error.message : "unknown error");
  process.exitCode = 1;
}).finally(async () => {
  await client?.close().catch(() => {});
  if (listener) await closeServer(listener).catch(() => {});
  graph?.checkpoint();
  fs.rmSync(root, { recursive: true, force: true });
  if (previousToken === undefined) delete process.env.AGENT_TRELLIS_RUNTIME_TOKEN;
  else process.env.AGENT_TRELLIS_RUNTIME_TOKEN = previousToken;
  if (previousRoots === undefined) delete process.env.AGENT_TRELLIS_WORKSPACES;
  else process.env.AGENT_TRELLIS_WORKSPACES = previousRoots;
});
