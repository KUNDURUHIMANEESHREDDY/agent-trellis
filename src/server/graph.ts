import path from "node:path";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { Database, type Connection } from "@relate/relate";
import type { DiscoveredMcpServer, MCPDiscoveryResult } from "./discovery";
import type { MCPInspectionOutcome } from "./mcp-inspector";
import { aggregateExposure, inferToolCapabilities, INFERENCE_VERSION, type ToolCapabilityAnalysis } from "./capability-intelligence";

export type GraphNode = { id: string; labels: string[]; properties: Record<string, unknown> };
export type GraphEdge = { source: string; target: string; type: string; properties: Record<string, unknown> };

const agents = [
  { id: "agent-research", name: "Research Agent", owner: "Knowledge Ops", status: "ACTIVE", risk: "MEDIUM", description: "Collects and summarizes external research." },
  { id: "agent-support", name: "Support Agent", owner: "Customer Experience", status: "ACTIVE", risk: "HIGH", description: "Retrieves customer context and drafts support responses." },
  { id: "agent-finance", name: "Finance Agent", owner: "Finance Ops", status: "ACTIVE", risk: "LOW", description: "Reads finance data and prepares payment recommendations." }
];
const servers = [
  { id: "mcp-browser", name: "Browser MCP", version: "1.4.2", status: "CONNECTED" },
  { id: "mcp-finance", name: "Finance MCP", version: "2.1.0", status: "CONNECTED" },
  { id: "mcp-crm", name: "CRM MCP", version: "0.9.8", status: "CONNECTED" }
];
const tools = [
  { id: "tool-search", name: "web_search", serverId: "mcp-browser", risk: "MEDIUM", category: "DISCOVERY" },
  { id: "tool-fetch", name: "fetch_url", serverId: "mcp-browser", risk: "HIGH", category: "BROWSER" },
  { id: "tool-customer", name: "get_customer", serverId: "mcp-crm", risk: "MEDIUM", category: "DATA ACCESS" },
  { id: "tool-update", name: "update_ticket", serverId: "mcp-crm", risk: "HIGH", category: "WRITE" },
  { id: "tool-balance", name: "read_balance", serverId: "mcp-finance", risk: "LOW", category: "FINANCE" },
  { id: "tool-payment", name: "prepare_payment", serverId: "mcp-finance", risk: "HIGH", category: "FINANCE" }
];
const capabilities = [
  { id: "cap-public-web", name: "public_web_access", sensitivity: "MEDIUM" },
  { id: "cap-customer-pii", name: "customer_data_read", sensitivity: "HIGH" },
  { id: "cap-ticket-write", name: "ticket_write", sensitivity: "HIGH" },
  { id: "cap-finance-read", name: "finance_read", sensitivity: "MEDIUM" },
  { id: "cap-payment-write", name: "payment_prepare", sensitivity: "CRITICAL" }
];
const policies = [
  { id: "policy-domain", name: "Approved Domain Policy", status: "ENFORCED", rule: "Only approved domains may be fetched." },
  { id: "policy-pii", name: "Customer Data Boundary", status: "ENFORCED", rule: "Customer data is available only to support workflows." },
  { id: "policy-payment", name: "Payment Approval Gate", status: "ENFORCED", rule: "Payment preparation requires human approval." }
];
const evidence = [
  { id: "evidence-001", title: "Unrestricted URL fetch test", result: "FAIL", severity: "HIGH", source: "Red-team simulation", age: "12 min ago" },
  { id: "evidence-002", title: "Customer data scope check", result: "PASS", severity: "INFO", source: "Policy evaluation", age: "28 min ago" },
  { id: "evidence-003", title: "Payment approval boundary", result: "PASS", severity: "INFO", source: "MCP contract test", age: "1 hr ago" },
  { id: "evidence-004", title: "Tool schema integrity", result: "INDETERMINATE", severity: "MEDIUM", source: "Contract monitor", age: "2 hrs ago" }
];

export class AgentGraph {
  private db: Database;
  private conn: Connection;

  constructor(databasePath = process.env.RELATE_DB_PATH || "./.data/agent-trellis") {
    const resolved = path.resolve(databasePath);
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    this.db = Database.open(resolved);
    this.conn = this.db.connect();
  }

  query(cypher: string, params: Record<string, unknown> = {}) {
    return this.conn.query(cypher, params as Record<string, never>);
  }

  checkpoint() { this.db.checkpoint(); }

  async initialize() {
    const row = this.query("MATCH (n:Agent) RETURN count(n) AS count").rows[0] as { count?: number } | undefined;
    if (!row || Number(row.count ?? 0) === 0) await this.seed();
  }

  async seed() {
    this.query("MATCH (n) DETACH DELETE n");
    for (const item of agents) this.query("MERGE (n:Agent {id: $id}) SET n += $props", { id: item.id, props: item });
    for (const item of servers) this.query("MERGE (n:MCPServer {id: $id}) SET n += $props", { id: item.id, props: item });
    for (const item of tools) this.query("MERGE (n:Tool {id: $id}) SET n += $props", { id: item.id, props: item });
    for (const item of capabilities) this.query("MERGE (n:Capability {id: $id}) SET n += $props", { id: item.id, props: item });
    for (const item of policies) this.query("MERGE (n:Policy {id: $id}) SET n += $props", { id: item.id, props: item });
    for (const item of evidence) this.query("MERGE (n:Evidence {id: $id}) SET n += $props", { id: item.id, props: item });

    const agentServer = [
      ["agent-research", "mcp-browser"], ["agent-support", "mcp-browser"],
      ["agent-support", "mcp-crm"], ["agent-finance", "mcp-finance"]
    ];
    for (const [agentId, serverId] of agentServer) {
      this.query("MATCH (a:Agent {id: $agentId}), (s:MCPServer {id: $serverId}) MERGE (a)-[:CONNECTS_TO]->(s)", { agentId, serverId });
    }
    for (const tool of tools) {
      this.query("MATCH (s:MCPServer {id: $serverId}), (t:Tool {id: $toolId}) MERGE (s)-[:EXPOSES]->(t)", { serverId: tool.serverId, toolId: tool.id });
    }
    const requirements = [
      ["tool-search", "cap-public-web"], ["tool-fetch", "cap-public-web"],
      ["tool-customer", "cap-customer-pii"], ["tool-update", "cap-ticket-write"],
      ["tool-balance", "cap-finance-read"], ["tool-payment", "cap-payment-write"]
    ];
    for (const [toolId, capabilityId] of requirements) {
      this.query("MATCH (t:Tool {id: $toolId}), (c:Capability {id: $capabilityId}) MERGE (t)-[:REQUIRES]->(c)", { toolId, capabilityId });
    }
    const restrictions = [
      ["policy-domain", "cap-public-web"], ["policy-pii", "cap-customer-pii"],
      ["policy-payment", "cap-payment-write"]
    ];
    for (const [policyId, capabilityId] of restrictions) {
      this.query("MATCH (p:Policy {id: $policyId}), (c:Capability {id: $capabilityId}) MERGE (p)-[:RESTRICTS]->(c)", { policyId, capabilityId });
    }
    this.query("MATCH (e:Evidence {id: 'evidence-001'}), (t:Tool {id: 'tool-fetch'}) MERGE (e)-[:TESTED]->(t)");
    this.query("MATCH (e:Evidence {id: 'evidence-002'}), (c:Capability {id: 'cap-customer-pii'}) MERGE (e)-[:VALIDATES]->(c)");
    this.query("MATCH (e:Evidence {id: 'evidence-003'}), (p:Policy {id: 'policy-payment'}) MERGE (e)-[:VALIDATES]->(p)");
    this.query("MATCH (e:Evidence {id: 'evidence-004'}), (t:Tool {id: 'tool-update'}) MERGE (e)-[:OBSERVES]->(t)");
    this.query("MATCH (a:Agent {id: 'agent-support'}), (e:Evidence {id: 'evidence-001'}) MERGE (a)-[:HAS_FINDING]->(e)");
    this.query("MATCH (a:Agent {id: 'agent-research'}), (e:Evidence {id: 'evidence-001'}) MERGE (a)-[:HAS_FINDING]->(e)");
    this.checkpoint();
  }

  getOverview() {
    const rows = this.query("MATCH (n) RETURN labels(n)[0] AS label, count(n) AS total").rows as Array<{ label: string; total: number }>;
    const counts = Object.fromEntries(rows.map((row) => [row.label, Number(row.total)]));
    const failed = this.query("MATCH (e:Evidence {result: 'FAIL'}) RETURN count(e) AS total").rows[0] as { total: number };
    const highRisk = this.query("MATCH (t:Tool) WHERE t.risk IN ['HIGH', 'CRITICAL'] RETURN count(t) AS total").rows[0] as { total: number };
    const discovered = this.query("MATCH (s:MCPServer {discovered: true}) RETURN count(s) AS total").rows[0] as { total?: number } | undefined;
    const analyzed = this.query("MATCH (t:Tool {mcpDiscovered: true, capabilityAnalysisVersion: $version}) RETURN count(t) AS total", { version: INFERENCE_VERSION }).rows[0] as { total?: number } | undefined;
    const criticalMcp = this.query("MATCH (t:Tool {mcpDiscovered: true, riskLevel: 'CRITICAL'}) RETURN count(t) AS total").rows[0] as { total?: number } | undefined;
    return { agents: counts.Agent ?? 0, mcpServers: counts.MCPServer ?? 0, discoveredMcpServers: Number(discovered?.total ?? 0), tools: counts.Tool ?? 0, capabilities: counts.Capability ?? 0, policies: counts.Policy ?? 0, evidence: counts.Evidence ?? 0, failedFindings: Number(failed?.total ?? 0), highRiskTools: Number(highRisk?.total ?? 0), analyzedMcpTools: Number(analyzed?.total ?? 0), criticalMcpTools: Number(criticalMcp?.total ?? 0) };
  }

  getGraph() {
    const nodeRows = this.query("MATCH (n) RETURN elementId(n) AS elementId, labels(n) AS labels, properties(n) AS properties").rows as Array<{ elementId: string; labels: string[]; properties: Record<string, unknown> }>;
    const edgeRows = this.query("MATCH (a)-[r]->(b) RETURN elementId(a) AS source, elementId(b) AS target, type(r) AS type, properties(r) AS properties").rows as Array<{ source: string; target: string; type: string; properties: Record<string, unknown> }>;
    const nodes = nodeRows.map((row) => ({ id: String(row.properties.id ?? row.elementId), labels: row.labels, properties: row.properties }));
    const elementToId = new Map(nodeRows.map((row) => [row.elementId, String(row.properties.id ?? row.elementId)]));
    const edges = edgeRows.map((row) => ({ source: elementToId.get(row.source) ?? row.source, target: elementToId.get(row.target) ?? row.target, type: row.type, properties: row.properties }));
    return { nodes, edges };
  }

  getAgents() {
    return this.query("MATCH (a:Agent) RETURN properties(a) AS agent ORDER BY a.name").rows.map((row) => (row as { agent: Record<string, unknown> }).agent);
  }
  getEvidence() {
    return this.query("MATCH (e:Evidence) RETURN properties(e) AS evidence ORDER BY e.id").rows.map((row) => (row as { evidence: Record<string, unknown> }).evidence);
  }

  getImpact(toolId: string) {
    const tool = this.query("MATCH (t:Tool {id: $id}) RETURN properties(t) AS tool", { id: toolId }).rows[0] as { tool: Record<string, unknown> } | undefined;
    if (!tool) return null;
    const affected = this.query("MATCH (a:Agent)-[:CONNECTS_TO|USER_ASSOCIATED_WITH]->(s:MCPServer)-[:EXPOSES]->(t:Tool {id: $id}) RETURN DISTINCT properties(a) AS agent, properties(s) AS server", { id: toolId }).rows as Array<{ agent: Record<string, unknown>; server: Record<string, unknown> }>;
    const chain = this.query("MATCH (t:Tool {id: $id})-[:REQUIRES]->(c:Capability)<-[:RESTRICTS]-(p:Policy) RETURN properties(c) AS capability, properties(p) AS policy", { id: toolId }).rows as Array<{ capability: Record<string, unknown>; policy: Record<string, unknown> }>;
    return { tool: tool.tool, affectedAgents: affected.map((row) => row.agent), servers: [...new Map(affected.map((row) => [String(row.server.id), row.server])).values()], controls: chain };
  }

  simulateCompromise(toolId: string) {
    const impact = this.getImpact(toolId);
    if (!impact) return null;
    const incidentId = `incident-${Date.now()}`;
    this.query("MATCH (t:Tool {id: $id}) SET t.risk = 'CRITICAL', t.compromised = true", { id: toolId });
    this.query("CREATE (i:Incident {id: $id, title: 'Simulated tool compromise', severity: 'CRITICAL', status: 'OPEN', createdAt: $createdAt})", { id: incidentId, createdAt: new Date().toISOString() });
    this.query("MATCH (i:Incident {id: $incidentId}), (t:Tool {id: $toolId}) CREATE (i)-[:TARGETS]->(t)", { incidentId, toolId });
    for (const agent of impact.affectedAgents) this.query("MATCH (i:Incident {id: $incidentId}), (a:Agent {id: $agentId}) CREATE (i)-[:IMPACTS]->(a)", { incidentId, agentId: String(agent.id) });
    const evidenceId = `evidence-${incidentId}`;
    this.query("CREATE (e:Evidence {id: $id, title: 'Compromise simulation evidence', result: 'FAIL', severity: 'CRITICAL', source: 'AgentTrellis simulation', age: 'just now'})", { id: evidenceId });
    this.query("MATCH (i:Incident {id: $incidentId}), (e:Evidence {id: $evidenceId}) CREATE (i)-[:SUPPORTED_BY]->(e)", { incidentId, evidenceId });
    this.checkpoint();
    return { incidentId, ...impact };
  }

  syncMcpDiscovery(discovery: MCPDiscoveryResult) {
    const seenServerIds = new Set<string>();
    const discoveredAt = new Date().toISOString();

    for (const server of discovery.servers) {
      seenServerIds.add(server.id);
      const host = {
        id: server.hostId,
        name: server.hostName,
        source: server.source,
        configPath: server.configPath,
        discovered: true,
        lastDiscoveredAt: discoveredAt
      };
      const serverProperties = {
        ...server,
        discovered: true,
        lastDiscoveredAt: discoveredAt,
        status: "CONFIGURED"
      };

      this.query("MERGE (h:MCPHost {id: $id}) SET h += $props", { id: server.hostId, props: host });
      this.query("MERGE (s:MCPServer {id: $id}) SET s += $props", { id: server.id, props: serverProperties });
      this.query(
        "MATCH (h:MCPHost {id: $hostId}), (s:MCPServer {id: $serverId}) MERGE (h)-[:CONFIGURES]->(s)",
        { hostId: server.hostId, serverId: server.id }
      );
    }

    const scannedPaths = new Set(discovery.scannedConfigPaths.map((value) => path.resolve(value)));
    const existing = this.query(
      "MATCH (s:MCPServer {discovered: true}) RETURN s.id AS id, s.configPath AS configPath"
    ).rows as Array<{ id: string; configPath: string }>;

    for (const item of existing) {
      if (scannedPaths.has(path.resolve(item.configPath)) && !seenServerIds.has(item.id)) {
        this.query("MATCH (s:MCPServer {id: $id}) DETACH DELETE s", { id: item.id });
      }
    }

    const linkedHostRows = this.query(
      "MATCH (h:MCPHost)-[:CONFIGURES]->(s:MCPServer {discovered: true}) RETURN DISTINCT h.id AS id"
    ).rows as Array<{ id: string }>;
    const linkedHostIds = new Set(linkedHostRows.map((row) => row.id));
    const hosts = this.query("MATCH (h:MCPHost) RETURN h.id AS id").rows as Array<{ id: string }>;
    for (const host of hosts) {
      if (!linkedHostIds.has(host.id)) {
        this.query("MATCH (h:MCPHost {id: $id}) DETACH DELETE h", { id: host.id });
      }
    }

    this.checkpoint();
  }

  getDiscoveredMcpServers(): DiscoveredMcpServer[] {
    const rows = this.query(
      "MATCH (h:MCPHost)-[:CONFIGURES]->(s:MCPServer {discovered: true}) RETURN properties(h) AS host, properties(s) AS server ORDER BY h.name, s.name"
    ).rows as Array<{ host: Record<string, unknown>; server: Record<string, unknown> }>;
    return rows.map((row) => {
      const server = row.server;
      return {
        id: String(server.id ?? ""),
        hostId: String(server.hostId ?? ""),
        hostName: String(row.host.name ?? ""),
        hostSource: String(row.host.source ?? ""),
        source: String(server.source ?? ""),
        configPath: String(server.configPath ?? ""),
        configScope: String(server.configScope ?? ""),
        name: String(server.name ?? ""),
        transport: server.transport === "stdio" || server.transport === "http" || server.transport === "sse"
          ? server.transport
          : "unknown",
        ...(typeof server.command === "string" ? { command: server.command } : {}),
        ...(typeof server.endpoint === "string" ? { endpoint: server.endpoint } : {}),
        argumentCount: Number(server.argumentCount ?? 0),
        environmentKeys: Array.isArray(server.environmentKeys) ? server.environmentKeys.map(String) : [],
        headerNames: Array.isArray(server.headerNames) ? server.headerNames.map(String) : [],
        credentialHints: Boolean(server.credentialHints)
      };
    });
  }

  recordMcpInspection(outcome: MCPInspectionOutcome) {
    const server = this.query(
      "MATCH (s:MCPServer {id: $id, discovered: true}) RETURN properties(s) AS server",
      { id: outcome.serverId }
    ).rows[0] as { server: Record<string, unknown> } | undefined;
    if (!server) return null;

    const mismatches = outcome.capabilityComparisons.filter(
      (item) => item.status === "missing" || item.status === "unexpected"
    );
    const result = outcome.success && mismatches.length === 0 ? "PASS" : "FAIL";
    const severity = result === "PASS" ? "INFO" : "HIGH";
    const inspectedAt = outcome.inspectedAt;
    const evidenceId = "evidence-mcp-" + createHash("sha256")
      .update(outcome.serverId + "\0" + inspectedAt)
      .digest("hex").slice(0, 20);

    this.query(
      "MATCH (s:MCPServer {id: $id, discovered: true}) SET s += $props",
      {
        id: outcome.serverId,
        props: {
          connectionStatus: outcome.success ? "INSPECTED" : "FAILED",
          lastInspectedAt: inspectedAt,
          lastInspectionResult: result,
          protocolEra: outcome.protocolEra ?? "unknown",
          protocolVersion: outcome.protocolVersion ?? "unknown",
          serverInfoName: outcome.serverInfo?.name ?? "",
          serverInfoVersion: outcome.serverInfo?.version ?? "",
          observedToolCount: outcome.tools.length,
          declaredCapabilities: outcome.declaredCapabilities,
          observedCapabilities: outcome.observedCapabilities
        }
      }
    );

    const existingTools = this.query(
      "MATCH (t:Tool {mcpDiscovered: true, mcpServerId: $serverId}) RETURN t.id AS id",
      { serverId: outcome.serverId }
    ).rows as Array<{ id: string }>;
    const retainedToolIds = new Set<string>();

    for (const tool of outcome.tools) {
      const toolId = "mcp-tool-" + createHash("sha256")
        .update(outcome.serverId + "\0" + tool.name)
        .digest("hex").slice(0, 20);
      retainedToolIds.add(toolId);
      const props = {
        id: toolId,
        name: tool.name,
        description: tool.description ?? "",
        mcpDiscovered: true,
        mcpServerId: outcome.serverId,
        inputSchemaJson: JSON.stringify(tool.inputSchema),
        outputSchemaJson: tool.outputSchema === undefined ? "" : JSON.stringify(tool.outputSchema),
        annotationsJson: tool.annotations === undefined ? "" : JSON.stringify(tool.annotations),
        schemaInspectedAt: inspectedAt
      };
      this.query("MERGE (t:Tool {id: $id}) SET t += $props", { id: toolId, props });
      this.query(
        "MATCH (s:MCPServer {id: $serverId}), (t:Tool {id: $toolId}) MERGE (s)-[:EXPOSES]->(t)",
        { serverId: outcome.serverId, toolId }
      );
    }

    const canReconcileTools = outcome.success && outcome.observedCapabilities.includes("tools");
    if (canReconcileTools) {
      for (const tool of existingTools) {
        if (!retainedToolIds.has(tool.id)) {
          this.query("MATCH (t:Tool {id: $id}) DETACH DELETE t", { id: tool.id });
        }
      }
    }

    const evidenceProps = {
      id: evidenceId,
      kind: "MCP_LIVE_INSPECTION",
      title: "MCP inspection: " + outcome.serverName,
      result,
      severity,
      source: "MCP protocol inspection",
      age: "just now",
      inspectedAt,
      serverId: outcome.serverId,
      serverName: outcome.serverName,
      transport: outcome.transport,
      protocolEra: outcome.protocolEra ?? "unknown",
      protocolVersion: outcome.protocolVersion ?? "unknown",
      serverInfoJson: JSON.stringify(outcome.serverInfo ?? {}),
      instructions: outcome.instructions ?? "",
      declaredCapabilitiesJson: JSON.stringify(outcome.declaredCapabilities),
      observedCapabilitiesJson: JSON.stringify(outcome.observedCapabilities),
      capabilityComparisonsJson: JSON.stringify(outcome.capabilityComparisons),
      toolsCount: outcome.tools.length,
      errorSummary: outcome.errorSummary ?? ""
    };
    this.query("MERGE (e:Evidence {id: $id}) SET e += $props", { id: evidenceId, props: evidenceProps });
    this.query(
      "MATCH (e:Evidence {id: $evidenceId}), (s:MCPServer {id: $serverId}) MERGE (e)-[:INSPECTED]->(s)",
      { evidenceId, serverId: outcome.serverId }
    );
    this.checkpoint();

    return {
      id: evidenceId,
      serverId: outcome.serverId,
      result,
      severity,
      inspectedAt,
      toolsCount: outcome.tools.length,
      capabilityComparisons: outcome.capabilityComparisons,
      errorSummary: outcome.errorSummary
    };
  }

  getMcpInspections() {
    const rows = this.query(
      "MATCH (e:Evidence {kind: 'MCP_LIVE_INSPECTION'})-[:INSPECTED]->(s:MCPServer {discovered: true}) RETURN properties(e) AS evidence ORDER BY e.inspectedAt DESC"
    ).rows as Array<{ evidence: Record<string, unknown> }>;
    const toolRows = this.query(
      "MATCH (t:Tool {mcpDiscovered: true}) RETURN properties(t) AS tool ORDER BY t.name"
    ).rows as Array<{ tool: Record<string, unknown> }>;
    const toolsByServer = new Map<string, Record<string, unknown>[]>();
    for (const row of toolRows) {
      const serverId = String(row.tool.mcpServerId ?? "");
      const values = toolsByServer.get(serverId) ?? [];
      values.push(row.tool);
      toolsByServer.set(serverId, values);
    }

    const seen = new Set<string>();
    const results: Array<Record<string, unknown>> = [];
    for (const row of rows) {
      const evidence = row.evidence;
      const serverId = String(evidence.serverId ?? "");
      if (seen.has(serverId)) continue;
      seen.add(serverId);
      results.push({
        id: evidence.id,
        serverId,
        serverName: evidence.serverName,
        result: evidence.result,
        severity: evidence.severity,
        inspectedAt: evidence.inspectedAt,
        transport: evidence.transport,
        protocolEra: evidence.protocolEra,
        protocolVersion: evidence.protocolVersion,
        serverInfoJson: evidence.serverInfoJson,
        instructions: evidence.instructions,
        declaredCapabilitiesJson: evidence.declaredCapabilitiesJson,
        observedCapabilitiesJson: evidence.observedCapabilitiesJson,
        capabilityComparisonsJson: evidence.capabilityComparisonsJson,
        errorSummary: evidence.errorSummary,
        tools: toolsByServer.get(serverId) ?? []
      });
    }
    return results;
  }

  reset() { return this.seed(); }
}
