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

  private parseStoredJson(value: unknown): unknown {
    if (typeof value !== "string" || value.length === 0) return {};
    try { return JSON.parse(value) as unknown; } catch { return {}; }
  }

  analyzeMcpCapabilities(serverId?: string) {
    const rows = this.query(
      "MATCH (t:Tool {mcpDiscovered: true}) WHERE ($serverId IS NULL OR t.mcpServerId = $serverId) RETURN properties(t) AS tool ORDER BY t.mcpServerId, t.name",
      { serverId: serverId ?? null }
    ).rows as Array<{ tool: Record<string, unknown> }>;
    const analyzedAt = new Date().toISOString();
    const analyses: Array<Record<string, unknown>> = [];
    const exposureByServer = new Map<string, number[]>();

    for (const row of rows) {
      const tool = row.tool;
      const toolId = String(tool.id ?? "");
      const toolServerId = String(tool.mcpServerId ?? "");
      const analysis: ToolCapabilityAnalysis = inferToolCapabilities({
        name: String(tool.name ?? ""),
        description: String(tool.description ?? ""),
        inputSchema: this.parseStoredJson(tool.inputSchemaJson),
        outputSchema: this.parseStoredJson(tool.outputSchemaJson),
        annotations: this.parseStoredJson(tool.annotationsJson)
      });

      this.query(
        "MATCH (t:Tool {id: $id})-[r:REQUIRES]->(:Capability) WHERE r.source = 'schema-inference' DELETE r",
        { id: toolId }
      );
      for (const finding of analysis.capabilities) {
        const properties = {
          id: finding.graphId,
          name: finding.name,
          category: finding.category,
          sensitivity: finding.sensitivity,
          description: finding.description,
          source: "schema-inference",
          inferenceKey: finding.key,
          inferenceVersion: INFERENCE_VERSION
        };
        this.query("MERGE (c:Capability {id: $id}) SET c += $props", {
          id: finding.graphId,
          props: properties
        });
        this.query(
          "MATCH (t:Tool {id: $toolId}), (c:Capability {id: $capabilityId}) MERGE (t)-[r:REQUIRES {source: 'schema-inference'}]->(c) SET r.confidence = $confidence, r.evidenceJson = $evidenceJson",
          {
            toolId,
            capabilityId: finding.graphId,
            confidence: finding.confidence,
            evidenceJson: JSON.stringify(finding.evidence)
          }
        );
      }

      const fingerprint = createHash("sha256")
        .update([
          String(tool.inputSchemaJson ?? ""),
          String(tool.outputSchemaJson ?? ""),
          String(tool.annotationsJson ?? ""),
          analysis.inferenceVersion
        ].join("\0"))
        .digest("hex");
      const evidenceId = "evidence-capability-" + createHash("sha256")
        .update(toolId + "\0" + fingerprint)
        .digest("hex").slice(0, 20);
      const mismatches = analysis.comparisons.filter((item) => item.status === "mismatch");
      const evidenceProperties = {
        id: evidenceId,
        kind: "MCP_CAPABILITY_ANALYSIS",
        title: "Capability analysis: " + String(tool.name ?? toolId),
        result: mismatches.length > 0 ? "FAIL" : "OBSERVED",
        severity: analysis.riskLevel,
        source: "Deterministic tool-schema inference",
        age: "just now",
        analyzedAt,
        toolId,
        serverId: toolServerId,
        inferenceVersion: analysis.inferenceVersion,
        riskScore: analysis.riskScore,
        riskLevel: analysis.riskLevel,
        permissionMode: analysis.permissionMode,
        capabilityFindingsJson: JSON.stringify(analysis.capabilities),
        comparisonsJson: JSON.stringify(analysis.comparisons),
        summary: analysis.summary
      };
      this.query("MERGE (e:Evidence {id: $id}) SET e += $props", {
        id: evidenceId,
        props: evidenceProperties
      });
      this.query(
        "MATCH (e:Evidence {id: $evidenceId}), (t:Tool {id: $toolId}) MERGE (e)-[:ANALYZES]->(t)",
        { evidenceId, toolId }
      );
      for (const finding of analysis.capabilities) {
        this.query(
          "MATCH (e:Evidence {id: $evidenceId}), (c:Capability {id: $capabilityId}) MERGE (e)-[:IDENTIFIES]->(c)",
          { evidenceId, capabilityId: finding.graphId }
        );
      }

      this.query(
        "MATCH (t:Tool {id: $id}) SET t += $props",
        {
          id: toolId,
          props: {
            capabilityAnalysisVersion: INFERENCE_VERSION,
            capabilityAnalyzedAt: analyzedAt,
            inferredCapabilitiesJson: JSON.stringify(analysis.capabilities),
            capabilityComparisonsJson: JSON.stringify(analysis.comparisons),
            permissionMode: analysis.permissionMode,
            destructiveObserved: analysis.destructiveObserved,
            openWorldObserved: analysis.openWorldObserved,
            riskScore: analysis.riskScore,
            riskLevel: analysis.riskLevel,
            analysisSummary: analysis.summary,
            readOnlyHint: analysis.readOnlyHint,
            destructiveHint: analysis.destructiveHint,
            capabilityCount: analysis.capabilities.length
          }
        }
      );
      const scores = exposureByServer.get(toolServerId) ?? [];
      scores.push(analysis.riskScore);
      exposureByServer.set(toolServerId, scores);
      analyses.push({
        toolId,
        serverId: toolServerId,
        toolName: tool.name,
        riskScore: analysis.riskScore,
        riskLevel: analysis.riskLevel,
        permissionMode: analysis.permissionMode,
        capabilityCount: analysis.capabilities.length,
        capabilities: analysis.capabilities,
        comparisons: analysis.comparisons,
        evidenceId
      });
    }

    for (const [id, scores] of exposureByServer) {
      const exposure = aggregateExposure(scores);
      const capabilityRows = this.query(
        "MATCH (s:MCPServer {id: $id})-[:EXPOSES]->(t:Tool {mcpDiscovered: true})-[r:REQUIRES {source: 'schema-inference'}]->(c:Capability) RETURN DISTINCT c.name AS name, c.inferenceKey AS key",
        { id }
      ).rows as Array<{ name: string; key: string }>;
      const toolRows = this.query(
        "MATCH (s:MCPServer {id: $id})-[:EXPOSES]->(t:Tool {mcpDiscovered: true}) RETURN count(t) AS total",
        { id }
      ).rows[0] as { total?: number };
      const uniqueCapabilities = [...new Set(capabilityRows.map((item) => item.key || item.name))].sort();
      this.query(
        "MATCH (s:MCPServer {id: $id, discovered: true}) SET s += $props",
        {
          id,
          props: {
            exposureScore: exposure.score,
            exposureLevel: exposure.level,
            analyzedToolCount: Number(toolRows?.total ?? scores.length),
            observedCapabilityKeys: uniqueCapabilities,
            capabilityAnalysisVersion: INFERENCE_VERSION,
            capabilityAnalyzedAt: analyzedAt
          }
        }
      );
    }

    this.recalculateAgentExposure();
    this.checkpoint();
    return {
      inferenceVersion: INFERENCE_VERSION,
      analyzedAt,
      analyzedTools: analyses.length,
      findings: analyses,
      summary: this.getCapabilityIntelligence().summary
    };
  }

  private recalculateAgentExposure() {
    const agents = this.query("MATCH (a:Agent) RETURN a.id AS id").rows as Array<{ id: string }>;
    for (const agent of agents) {
      const links = this.query(
        "MATCH (a:Agent {id: $id})-[:CONNECTS_TO|USER_ASSOCIATED_WITH]->(s:MCPServer {discovered: true}) RETURN properties(s) AS server",
        { id: agent.id }
      ).rows as Array<{ server: Record<string, unknown> }>;
      const exposure = aggregateExposure(links.map((item) => Number(item.server.exposureScore ?? 0)));
      const toolCount = links.reduce((sum, item) => sum + Number(item.server.analyzedToolCount ?? 0), 0);
      const capabilities = [...new Set(links.flatMap((item) =>
        Array.isArray(item.server.observedCapabilityKeys) ? item.server.observedCapabilityKeys.map(String) : []
      ))].sort();
      this.query(
        "MATCH (a:Agent {id: $id}) SET a += $props",
        {
          id: agent.id,
          props: {
            mcpExposureScore: exposure.score,
            mcpExposureLevel: exposure.level,
            exposedMcpServerCount: links.length,
            exposedMcpToolCount: toolCount,
            observedMcpCapabilities: capabilities
          }
        }
      );
    }
  }

  associateAgentWithMcpServer(agentId: string, serverId: string) {
    const agent = this.query("MATCH (a:Agent {id: $id}) RETURN a.id AS id", { id: agentId }).rows[0];
    if (!agent) return { ok: false, status: 404 as const, error: "Agent not found." };
    const server = this.query(
      "MATCH (s:MCPServer {id: $id, discovered: true}) RETURN s.id AS id",
      { id: serverId }
    ).rows[0];
    if (!server) return { ok: false, status: 404 as const, error: "Discovered MCP server not found." };
    this.query(
      "MATCH (a:Agent {id: $agentId}), (s:MCPServer {id: $serverId}) MERGE (a)-[:USER_ASSOCIATED_WITH]->(s)",
      { agentId, serverId }
    );
    this.recalculateAgentExposure();
    this.checkpoint();
    return { ok: true as const, agentId, serverId };
  }

  removeAgentMcpAssociation(agentId: string, serverId: string) {
    this.query(
      "MATCH (a:Agent {id: $agentId})-[r:USER_ASSOCIATED_WITH]->(s:MCPServer {id: $serverId, discovered: true}) DELETE r",
      { agentId, serverId }
    );
    this.recalculateAgentExposure();
    this.checkpoint();
    return { ok: true as const, agentId, serverId };
  }

  getCapabilityIntelligence() {
    const servers = this.getDiscoveredMcpServers();
    const serverResults: Array<Record<string, any>> = servers.map((server) => {
      const toolRows = this.query(
        "MATCH (s:MCPServer {id: $id})-[:EXPOSES]->(t:Tool {mcpDiscovered: true}) RETURN properties(t) AS tool ORDER BY t.name",
        { id: server.id }
      ).rows as Array<{ tool: Record<string, unknown> }>;
      const agentRows = this.query(
        "MATCH (a:Agent)-[r:CONNECTS_TO|USER_ASSOCIATED_WITH]->(s:MCPServer {id: $id}) RETURN DISTINCT properties(a) AS agent, type(r) AS relation",
        { id: server.id }
      ).rows as Array<{ agent: Record<string, unknown>; relation: string }>;
      const tools = toolRows.map((row) => {
        const tool = row.tool;
        return {
          id: tool.id,
          name: tool.name,
          description: tool.description,
          riskScore: Number(tool.riskScore ?? 0),
          riskLevel: String(tool.riskLevel ?? "UNKNOWN"),
          permissionMode: String(tool.permissionMode ?? "UNKNOWN"),
          capabilityAnalysisVersion: tool.capabilityAnalysisVersion ?? null,
          capabilities: this.parseStoredJson(tool.inferredCapabilitiesJson),
          comparisons: this.parseStoredJson(tool.capabilityComparisonsJson),
          analysisSummary: tool.analysisSummary ?? "Not analyzed"
        };
      });
      return {
        ...server,
        exposureScore: Number(server.exposureScore ?? 0),
        exposureLevel: String(server.exposureLevel ?? "UNKNOWN"),
        tools,
        agents: agentRows.map((row) => ({
          id: row.agent.id,
          name: row.agent.name,
          risk: row.agent.risk,
          exposureScore: Number(row.agent.mcpExposureScore ?? 0),
          associationSource: row.relation === "USER_ASSOCIATED_WITH" ? "user-confirmed" : "existing graph relationship"
        }))
      };
    });

    const capabilityRows = this.query(
      "MATCH (c:Capability) WHERE c.source = 'schema-inference' OR c.inferenceVersion = $version RETURN properties(c) AS capability ORDER BY c.sensitivity DESC, c.name",
      { version: INFERENCE_VERSION }
    ).rows as Array<{ capability: Record<string, unknown> }>;
    const tools = serverResults.flatMap((server) => server.tools);
    return {
      summary: {
        servers: serverResults.length,
        analyzedServers: serverResults.filter((server) => server.tools.some((tool: any) => tool.capabilityAnalysisVersion === INFERENCE_VERSION)).length,
        tools: tools.length,
        analyzedTools: tools.filter((tool: any) => tool.capabilityAnalysisVersion === INFERENCE_VERSION).length,
        highRiskTools: tools.filter((tool: any) => ["HIGH", "CRITICAL"].includes(tool.riskLevel)).length,
        criticalTools: tools.filter((tool: any) => tool.riskLevel === "CRITICAL").length,
        unassociatedServers: serverResults.filter((server) => server.agents.length === 0).length,
        capabilities: capabilityRows.length
      },
      capabilities: capabilityRows.map((row) => row.capability),
      servers: serverResults
    };
  }

  reset() { return this.seed(); }
}
