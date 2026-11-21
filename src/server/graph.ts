import path from "node:path";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { Database, type Connection } from "@relate/relate";
import type { DiscoveredMcpServer, MCPDiscoveryResult } from "./discovery";
import type { MCPInspectionOutcome } from "./mcp-inspector";
import { aggregateExposure, inferToolCapabilities, INFERENCE_VERSION, CAPABILITY_DEFINITIONS, type ToolCapabilityAnalysis } from "./capability-intelligence";
import { compareToolInventory, fingerprintToolInventory, fingerprintToolSnapshot, isHighImpactEffect, validateRuntimeEvent, type McpToolSnapshot, type RuntimeEvidenceSource } from "./runtime-security";

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
    const inferred = this.query(
      "MATCH (t:Tool {id: $id})-[r:REQUIRES]->(c:Capability) RETURN properties(c) AS capability, r.confidence AS confidence, r.source AS source",
      { id: toolId }
    ).rows as Array<{ capability: Record<string, unknown>; confidence?: number; source?: string }>;
    const servers = [...new Map(affected.map((row) => [String(row.server.id), row.server])).values()];
    const riskScore = Number(tool.tool.riskScore ?? 0);
    const capabilities: Array<Record<string, unknown>> = inferred.map((row) => ({
      ...row.capability,
      confidence: row.confidence ?? null,
      inferred: row.source === "schema-inference"
    }));
    const highSensitivityCapabilityCount = capabilities.filter((capability) =>
      capability.sensitivity === "HIGH" || capability.sensitivity === "CRITICAL"
    ).length;
    return {
      tool: tool.tool,
      affectedAgents: affected.map((row) => row.agent),
      servers,
      controls: chain,
      capabilities,
      exposure: {
        toolRiskScore: riskScore,
        riskLevel: String(tool.tool.riskLevel ?? tool.tool.risk ?? "UNKNOWN"),
        affectedAgentCount: affected.length,
        affectedServerCount: servers.length,
        capabilityCount: capabilities.length,
        highSensitivityCapabilityCount,
        serverExposureScore: servers.length ? Math.max(...servers.map((server) => Number(server.exposureScore ?? 0))) : 0
      }
    };
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
        ...(typeof server.exposureScore === "number" ? { exposureScore: server.exposureScore } : {}),
        ...(typeof server.exposureLevel === "string" ? { exposureLevel: server.exposureLevel } : {}),
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
      "MATCH (t:Tool {mcpDiscovered: true, mcpServerId: $serverId}) RETURN properties(t) AS tool",
      { serverId: outcome.serverId }
    ).rows as Array<{ tool: Record<string, unknown> }>;
    const existingByName = new Map(existingTools.map((row) => [String(row.tool.name ?? ""), row.tool]));
    const previousSnapshots: McpToolSnapshot[] = existingTools.map(({ tool }) => ({
      name: String(tool.name ?? ""),
      description: String(tool.description ?? ""),
      inputSchema: this.parseStoredJson(tool.inputSchemaJson),
      ...(String(tool.outputSchemaJson ?? "").length > 0 ? { outputSchema: this.parseStoredJson(tool.outputSchemaJson) } : {}),
      ...(String(tool.annotationsJson ?? "").length > 0 ? { annotations: this.parseStoredJson(tool.annotationsJson) } : {})
    }));
    const canReconcileTools = outcome.success && outcome.observedCapabilities.includes("tools");
    const hasBaseline = typeof server.server.schemaInventoryFingerprint === "string" || existingTools.length > 0;
    const driftChanges = canReconcileTools && hasBaseline
      ? compareToolInventory(previousSnapshots, outcome.tools)
      : [];
    const currentInventoryFingerprint = fingerprintToolInventory(outcome.tools);
    const retainedToolIds = new Set<string>();

    for (const tool of outcome.tools) {
      const toolId = "mcp-tool-" + createHash("sha256")
        .update(outcome.serverId + "\0" + tool.name)
        .digest("hex").slice(0, 20);
      retainedToolIds.add(toolId);
      const previous = existingByName.get(tool.name);
      const currentFingerprint = fingerprintToolSnapshot(tool);
      const previousFingerprint = previous
        ? String(previous.schemaFingerprint ?? fingerprintToolSnapshot({
          name: String(previous.name ?? ""),
          description: String(previous.description ?? ""),
          inputSchema: this.parseStoredJson(previous.inputSchemaJson),
          ...(String(previous.outputSchemaJson ?? "").length > 0 ? { outputSchema: this.parseStoredJson(previous.outputSchemaJson) } : {}),
          ...(String(previous.annotationsJson ?? "").length > 0 ? { annotations: this.parseStoredJson(previous.annotationsJson) } : {})
        }))
        : "";
      const changed = Boolean(previous && previousFingerprint !== currentFingerprint);
      const schemaVersion = previous
        ? Math.max(1, Number(previous.schemaVersion ?? 1)) + (changed ? 1 : 0)
        : 1;
      const props = {
        id: toolId,
        name: tool.name,
        description: tool.description ?? "",
        mcpDiscovered: true,
        mcpServerId: outcome.serverId,
        inputSchemaJson: JSON.stringify(tool.inputSchema),
        outputSchemaJson: tool.outputSchema === undefined ? "" : JSON.stringify(tool.outputSchema),
        annotationsJson: tool.annotations === undefined ? "" : JSON.stringify(tool.annotations),
        schemaInspectedAt: inspectedAt,
        schemaFingerprint: currentFingerprint,
        schemaVersion,
        schemaAddedAfterBaseline: !previous && hasBaseline,
        ...(changed ? { schemaChangedAt: inspectedAt } : {})
      };
      this.query("MERGE (t:Tool {id: $id}) SET t += $props", { id: toolId, props });
      this.query(
        "MATCH (s:MCPServer {id: $serverId}), (t:Tool {id: $toolId}) MERGE (s)-[:EXPOSES]->(t)",
        { serverId: outcome.serverId, toolId }
      );
    }

    if (canReconcileTools) {
      for (const row of existingTools) {
        const id = String(row.tool.id ?? "");
        if (!retainedToolIds.has(id)) {
          this.query("MATCH (t:Tool {id: $id}) DETACH DELETE t", { id });
        }
      }
    }

    if (canReconcileTools) {
      const driftStatus = !hasBaseline ? "BASELINED" : driftChanges.length > 0 ? "CHANGED" : "STABLE";
      this.query(
        "MATCH (s:MCPServer {id: $id, discovered: true}) SET s += $props",
        {
          id: outcome.serverId,
          props: {
            schemaInventoryFingerprint: currentInventoryFingerprint,
            schemaDriftStatus: driftStatus,
            schemaDriftCount: driftChanges.length,
            lastSchemaCheckedAt: inspectedAt,
            ...(driftChanges.length > 0 ? { lastSchemaDriftAt: inspectedAt } : {})
          }
        }
      );

      if (driftChanges.length > 0) {
        const driftEvidenceId = "evidence-drift-" + createHash("sha256")
          .update(outcome.serverId + "\0" + inspectedAt + "\0" + currentInventoryFingerprint)
          .digest("hex").slice(0, 20);
        const highImpactDrift = driftChanges.some((change) =>
          change.changeType === "REMOVED" || change.changedFields.includes("annotations")
        );
        this.query(
          "MERGE (e:Evidence {id: $id}) SET e += $props",
          {
            id: driftEvidenceId,
            props: {
              id: driftEvidenceId,
              kind: "MCP_SCHEMA_DRIFT",
              title: "MCP tool schema drift: " + outcome.serverName,
              result: "CHANGED",
              severity: highImpactDrift ? "HIGH" : "MEDIUM",
              source: "Successful MCP inspection comparison",
              age: "just now",
              serverId: outcome.serverId,
              serverName: outcome.serverName,
              inspectedAt,
              changeCount: driftChanges.length,
              changesJson: JSON.stringify(driftChanges),
              previousInventoryFingerprint: String(server.server.schemaInventoryFingerprint ?? ""),
              currentInventoryFingerprint
            }
          }
        );
        this.query(
          "MATCH (e:Evidence {id: $evidenceId}), (s:MCPServer {id: $serverId}) MERGE (e)-[:DETECTS_DRIFT_ON]->(s)",
          { evidenceId: driftEvidenceId, serverId: outcome.serverId }
        );
        for (const change of driftChanges) {
          const currentToolId = "mcp-tool-" + createHash("sha256")
            .update(outcome.serverId + "\0" + change.toolName)
            .digest("hex").slice(0, 20);
          this.query(
            "MATCH (e:Evidence {id: $evidenceId}), (t:Tool {id: $toolId}) MERGE (e)-[:AFFECTS]->(t)",
            { evidenceId: driftEvidenceId, toolId: currentToolId }
          );
        }
      }

      // Refresh inferred capabilities and exposure against the newly inspected tool inventory.
      this.analyzeMcpCapabilities(outcome.serverId);
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
    const capabilityDriftEvents: Array<Record<string, unknown>> = [];
    const exposureByServer = new Map<string, number[]>();
    const previousServerStates = new Map(
      (this.query("MATCH (s:MCPServer {discovered: true}) RETURN properties(s) AS server").rows as Array<{ server: Record<string, unknown> }>)
        .map((row) => [String(row.server.id ?? ""), row.server] as const)
    );
    // A successful tools/list response with zero tools is still a valid inventory.
    // Keep the server in the comparison set so removal of its final tool/permission
    // is recorded rather than silently skipped because there are no tool rows.
    for (const [id] of previousServerStates) {
      if ((!serverId || serverId === id) && !exposureByServer.has(id)) exposureByServer.set(id, []);
    }

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
      const previousFindingsValue = this.parseStoredJson(tool.inferredCapabilitiesJson);
      const previousFindings = Array.isArray(previousFindingsValue) ? previousFindingsValue as Array<Record<string, unknown>> : [];
      const previousKeys = [...new Set(previousFindings.map((finding) => String(finding.key ?? "")).filter(Boolean))].sort();
      const currentKeys = analysis.capabilities.map((finding) => finding.key).sort();
      const previousRiskLevel = String(tool.riskLevel ?? "UNKNOWN");
      const previousRiskScore = Number(tool.riskScore ?? 0);
      const previousPermissionMode = String(tool.permissionMode ?? "UNKNOWN");
      const hasPreviousAnalysis = typeof tool.capabilityAnalysisVersion === "string";
      const newlyAddedTool = tool.schemaAddedAfterBaseline === true;
      const addedCapabilityKeys = currentKeys.filter((key) => !previousKeys.includes(key));
      const removedCapabilityKeys = previousKeys.filter((key) => !currentKeys.includes(key));
      const riskRank: Record<string, number> = { UNKNOWN: -1, LOW: 0, MEDIUM: 1, HIGH: 2, CRITICAL: 3 };
      const permissionRank: Record<string, number> = { UNKNOWN: -1, READ: 0, WRITE: 1, MIXED: 2, EXECUTE: 3, DESTRUCTIVE: 4 };
      const riskEscalated = (riskRank[analysis.riskLevel] ?? -1) > (riskRank[previousRiskLevel] ?? -1);
      const modeEscalated = (permissionRank[analysis.permissionMode] ?? -1) > (permissionRank[previousPermissionMode] ?? -1);
      const permissionEscalation = addedCapabilityKeys.length > 0 || riskEscalated || modeEscalated;
      const hasCapabilityDrift = addedCapabilityKeys.length > 0 || removedCapabilityKeys.length > 0 ||
        (hasPreviousAnalysis && (riskEscalated || modeEscalated ||
          Boolean(tool.destructiveObserved) !== analysis.destructiveObserved ||
          Boolean(tool.openWorldObserved) !== analysis.openWorldObserved));
      if ((hasPreviousAnalysis && hasCapabilityDrift) || (newlyAddedTool && currentKeys.length > 0)) {
        const introduced = analysis.capabilities.filter((finding) => addedCapabilityKeys.includes(finding.key));
        const criticalIntroduction = introduced.some((finding) => finding.sensitivity === "CRITICAL");
        const highIntroduction = introduced.some((finding) => finding.sensitivity === "HIGH");
        const severity = criticalIntroduction ? "CRITICAL" : (permissionEscalation || highIntroduction ? "HIGH" : "MEDIUM");
        const driftFingerprint = JSON.stringify({
          previousKeys, currentKeys, previousRiskLevel, currentRiskLevel: analysis.riskLevel,
          previousPermissionMode, currentPermissionMode: analysis.permissionMode,
          destructiveObserved: analysis.destructiveObserved, openWorldObserved: analysis.openWorldObserved
        });
        const driftEvidenceId = "evidence-capability-drift-" + createHash("sha256")
          .update(toolId + "\0" + analyzedAt + "\0" + driftFingerprint)
          .digest("hex").slice(0, 20);
        const driftProperties = {
          id: driftEvidenceId,
          kind: "MCP_CAPABILITY_DRIFT",
          title: "Inferred capability change: " + String(tool.name ?? toolId),
          result: permissionEscalation ? "PERMISSION_ESCALATION" : "CAPABILITIES_CHANGED",
          severity,
          source: "Deterministic schema-derived capability comparison",
          assessmentBasis: "heuristic",
          age: "just now",
          analyzedAt,
          toolId,
          toolName: String(tool.name ?? toolId),
          serverId: toolServerId,
          previousCapabilityKeys: previousKeys,
          currentCapabilityKeys: currentKeys,
          addedCapabilityKeys,
          removedCapabilityKeys,
          permissionEscalation,
          previousRiskLevel,
          currentRiskLevel: analysis.riskLevel,
          previousRiskScore,
          currentRiskScore: analysis.riskScore,
          previousPermissionMode,
          currentPermissionMode: analysis.permissionMode,
          destructiveObserved: analysis.destructiveObserved,
          openWorldObserved: analysis.openWorldObserved,
          summary: "Heuristic capability inference changed; this is not proof of tool use or exploitability."
        };
        this.query("MERGE (e:Evidence {id: $id}) SET e += $props", { id: driftEvidenceId, props: driftProperties });
        this.query(
          "MATCH (e:Evidence {id: $evidenceId}), (t:Tool {id: $toolId}) MERGE (e)-[:DETECTS_CAPABILITY_DRIFT_ON]->(t)",
          { evidenceId: driftEvidenceId, toolId }
        );
        for (const finding of introduced) {
          this.query(
            "MATCH (e:Evidence {id: $evidenceId}), (c:Capability {id: $capabilityId}) MERGE (e)-[:INTRODUCES_INFERENCE]->(c)",
            { evidenceId: driftEvidenceId, capabilityId: finding.graphId }
          );
        }
        capabilityDriftEvents.push(driftProperties);
      }

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
            capabilityCount: analysis.capabilities.length,
            schemaAddedAfterBaseline: false,
            capabilityFingerprint: createHash("sha256").update(JSON.stringify({
              keys: currentKeys,
              riskLevel: analysis.riskLevel,
              permissionMode: analysis.permissionMode,
              destructiveObserved: analysis.destructiveObserved,
              openWorldObserved: analysis.openWorldObserved
            })).digest("hex")
          }
        }
      );
      const scores = exposureByServer.get(toolServerId) ?? [];
      scores.push(analysis.riskLevel === "UNKNOWN" ? -1 : analysis.riskScore);
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
      const previousServer = previousServerStates.get(id);
      const previousServerKeys = previousServer && Array.isArray(previousServer.observedCapabilityKeys)
        ? [...new Set(previousServer.observedCapabilityKeys.map(String))].sort()
        : null;
      const removedServerKeys = previousServerKeys
        ? previousServerKeys.filter((key) => !uniqueCapabilities.includes(key))
        : [];
      if (removedServerKeys.length > 0) {
        const removedFingerprint = JSON.stringify({ previousServerKeys, uniqueCapabilities, removedServerKeys });
        const driftEvidenceId = "evidence-capability-drift-" + createHash("sha256")
          .update(id + "\0" + analyzedAt + "\0" + removedFingerprint)
          .digest("hex").slice(0, 20);
        const driftProperties = {
          id: driftEvidenceId,
          kind: "MCP_CAPABILITY_DRIFT",
          title: "Inferred server capabilities removed: " + String(previousServer?.name ?? id),
          result: "PERMISSIONS_REDUCED",
          severity: "INFO",
          source: "Deterministic schema-derived capability comparison",
          assessmentBasis: "heuristic",
          age: "just now",
          analyzedAt,
          serverId: id,
          previousCapabilityKeys: previousServerKeys,
          currentCapabilityKeys: uniqueCapabilities,
          addedCapabilityKeys: [],
          removedCapabilityKeys: removedServerKeys,
          permissionEscalation: false,
          summary: "Previously inferred capability classes are no longer present in the inspected tool catalogue."
        };
        this.query("MERGE (e:Evidence {id: $id}) SET e += $props", { id: driftEvidenceId, props: driftProperties });
        this.query(
          "MATCH (e:Evidence {id: $evidenceId}), (s:MCPServer {id: $serverId}) MERGE (e)-[:DETECTS_CAPABILITY_DRIFT_ON]->(s)",
          { evidenceId: driftEvidenceId, serverId: id }
        );
        capabilityDriftEvents.push(driftProperties);
      }
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
    for (const id of exposureByServer.keys()) this.captureBlastRadiusSnapshot(id, analyzedAt);
    this.checkpoint();
    return {
      inferenceVersion: INFERENCE_VERSION,
      analyzedAt,
      analyzedTools: analyses.length,
      findings: analyses,
      capabilityDriftEvents,
      summary: this.getCapabilityIntelligence().summary
    };
  }

  recordMonitorRun(run: {
    startedAt: string;
    completedAt: string;
    discoveredServers: number;
    inspectedServers: number;
    failedServers: number;
    skippedStdioServers: number;
    skippedUnsupportedServers: number;
    skippedBusyServers: number;
    errors: number;
  }) {
    const id = "evidence-monitor-run-" + createHash("sha256")
      .update(run.startedAt + "\0" + run.completedAt)
      .digest("hex").slice(0, 20);
    const properties = {
      id,
      kind: "MCP_MONITOR_RUN",
      title: "Continuous MCP security scan",
      result: run.failedServers > 0 || run.errors > 0 ? "PARTIAL" : "COMPLETED",
      severity: run.failedServers > 0 || run.errors > 0 ? "MEDIUM" : "INFO",
      source: "Scheduled MCP inspection monitor",
      assessmentBasis: "read-only protocol and graph inspection",
      age: "just now",
      ...run
    };
    this.query("MERGE (e:Evidence {id: $id}) SET e += $props", { id, props: properties });
    this.query(
      "MERGE (m:MCPMonitor {id: 'mcp-monitor'}) SET m += $props",
      {
        id: "mcp-monitor",
        props: {
          lastRunId: id,
          lastRunStartedAt: run.startedAt,
          lastRunCompletedAt: run.completedAt,
          lastRunResult: properties.result,
          lastDiscoveredServers: run.discoveredServers,
          lastInspectedServers: run.inspectedServers,
          lastFailedServers: run.failedServers,
          lastSkippedStdioServers: run.skippedStdioServers,
          lastSkippedUnsupportedServers: run.skippedUnsupportedServers,
          lastSkippedBusyServers: run.skippedBusyServers,
          lastErrors: run.errors
        }
      }
    );
    this.query(
      "MATCH (e:Evidence {id: $evidenceId}), (m:MCPMonitor {id: 'mcp-monitor'}) MERGE (e)-[:RECORDED_BY]->(m)",
      { evidenceId: id }
    );
    return properties;
  }

  getMonitorStatus() {
    const row = this.query(
      "MATCH (m:MCPMonitor {id: 'mcp-monitor'}) RETURN properties(m) AS monitor"
    ).rows[0] as { monitor: Record<string, unknown> } | undefined;
    return row?.monitor ?? null;
  }

  recordRuntimeEvent(input: unknown, sourceKind: RuntimeEvidenceSource = "adapter_reported") {
    const validation = validateRuntimeEvent(input);
    if (!validation.ok) return { ok: false as const, status: 400, error: validation.error };
    const event = validation.event;
    const serverRow = this.query(
      "MATCH (s:MCPServer {id: $id, discovered: true}) RETURN properties(s) AS server",
      { id: event.serverId }
    ).rows[0] as { server: Record<string, unknown> } | undefined;
    if (!serverRow) return { ok: false as const, status: 404, error: "Discovered MCP server not found." };

    const toolRow = this.query(
      "MATCH (s:MCPServer {id: $serverId})-[:EXPOSES]->(t:Tool {mcpDiscovered: true, name: $toolName}) RETURN properties(t) AS tool",
      { serverId: event.serverId, toolName: event.toolName }
    ).rows[0] as { tool: Record<string, unknown> } | undefined;
    if (!toolRow) return { ok: false as const, status: 404, error: "Tool is not present in the latest inspected inventory." };

    let agentName: string | undefined;
    if (event.agentId) {
      const agentRow = this.query(
        "MATCH (a:Agent {id: $id}) RETURN a.name AS name",
        { id: event.agentId }
      ).rows[0] as { name?: string } | undefined;
      if (!agentRow) return { ok: false as const, status: 404, error: "Agent not found." };
      agentName = agentRow.name;
    }

    const evidenceId = "evidence-runtime-" + createHash("sha256")
      .update(event.serverId + "\0" + event.eventId)
      .digest("hex").slice(0, 24);
    const eventPayloadHash = createHash("sha256").update(JSON.stringify(event)).digest("hex");
    const existing = this.query(
      "MATCH (e:Evidence {id: $id, kind: 'MCP_RUNTIME_EVENT'}) RETURN properties(e) AS event",
      { id: evidenceId }
    ).rows[0] as { event: Record<string, unknown> } | undefined;
    if (existing) {
      if (existing.event.eventPayloadHash !== eventPayloadHash) {
        return { ok: false as const, status: 409, error: "eventId was already used for a different event payload." };
      }
      return { ok: true as const, duplicate: true, evidenceId, eventType: event.eventType };
    }

    const highImpact = isHighImpactEffect(event.effect);
    const severity = event.eventType === "SIDE_EFFECT_OBSERVED"
      ? (highImpact ? "HIGH" : "MEDIUM")
      : event.eventType === "CALL_FAILED" ? "LOW" : "INFO";
    const result = event.eventType === "POLICY_DENIED" ? "PASS" : "OBSERVED";
    const eventProperties = {
      id: evidenceId,
      kind: "MCP_RUNTIME_EVENT",
      title: event.eventType + ": " + event.toolName,
      result,
      severity,
      sourceKind,
      source: sourceKind === "gateway_observed"
        ? "AgentTrellis MCP runtime gateway (protocol-hop observation)"
        : "Authenticated runtime adapter",
      age: "just now",
      eventId: event.eventId,
      executionId: event.executionId,
      eventType: event.eventType,
      observedAt: event.observedAt,
      receivedAt: new Date().toISOString(),
      serverId: event.serverId,
      serverName: String(serverRow.server.name ?? ""),
      toolId: String(toolRow.tool.id ?? ""),
      toolName: event.toolName,
      ...(event.agentId ? { agentId: event.agentId, agentName: agentName ?? "" } : {}),
      ...(event.durationMs !== undefined ? { durationMs: event.durationMs } : {}),
      ...(event.effect ? { effect: event.effect } : {}),
      ...(event.policyName ? { policyName: event.policyName } : {}),
      ...(event.errorCode ? { errorCode: event.errorCode } : {}),
      eventPayloadHash
    };
    this.query("CREATE (e:Evidence {id: $id}) SET e += $props", {
      id: evidenceId,
      props: eventProperties
    });
    this.query(
      "MATCH (e:Evidence {id: $evidenceId}), (s:MCPServer {id: $serverId}) MERGE (e)-[:OBSERVED_ON]->(s)",
      { evidenceId, serverId: event.serverId }
    );
    this.query(
      "MATCH (e:Evidence {id: $evidenceId}), (t:Tool {id: $toolId}) MERGE (e)-[:OBSERVES]->(t)",
      { evidenceId, toolId: String(toolRow.tool.id ?? "") }
    );
    if (event.agentId) {
      this.query(
        "MATCH (a:Agent {id: $agentId}), (e:Evidence {id: $evidenceId}) MERGE (a)-[:HAS_RUNTIME_EVIDENCE]->(e)",
        { agentId: event.agentId, evidenceId }
      );
    }
    this.checkpoint();
    return { ok: true as const, duplicate: false, evidenceId, eventType: event.eventType, severity, result };
  }

  getRuntimeMonitoring(limit = 50) {
    const boundedLimit = Math.max(1, Math.min(200, Math.floor(limit)));
    const eventRows = this.query(
      "MATCH (e:Evidence {kind: 'MCP_RUNTIME_EVENT'}) RETURN properties(e) AS event ORDER BY e.observedAt DESC LIMIT $limit",
      { limit: boundedLimit }
    ).rows as Array<{ event: Record<string, unknown> }>;
    const driftRows = this.query(
      "MATCH (e:Evidence {kind: 'MCP_SCHEMA_DRIFT'}) RETURN properties(e) AS event ORDER BY e.inspectedAt DESC LIMIT $limit",
      { limit: boundedLimit }
    ).rows as Array<{ event: Record<string, unknown> }>;
    const capabilityDriftRows = this.query(
      "MATCH (e:Evidence {kind: 'MCP_CAPABILITY_DRIFT'}) RETURN properties(e) AS event ORDER BY e.analyzedAt DESC LIMIT $limit",
      { limit: boundedLimit }
    ).rows as Array<{ event: Record<string, unknown> }>;
    const blastRadiusRows = this.query(
      "MATCH (e:Evidence {kind: 'MCP_BLAST_RADIUS_CHANGE'}) RETURN properties(e) AS event ORDER BY e.observedAt DESC LIMIT $limit",
      { limit: boundedLimit }
    ).rows as Array<{ event: Record<string, unknown> }>;
    const monitorRunRows = this.query(
      "MATCH (e:Evidence {kind: 'MCP_MONITOR_RUN'}) RETURN properties(e) AS event ORDER BY e.completedAt DESC LIMIT $limit",
      { limit: boundedLimit }
    ).rows as Array<{ event: Record<string, unknown> }>;
    const count = (kind: string, eventType?: string) => {
      const row = this.query(
        "MATCH (e:Evidence {kind: $kind" + (eventType ? ", eventType: $eventType" : "") + "}) RETURN count(e) AS total",
        eventType ? { kind, eventType } : { kind }
      ).rows[0] as { total?: number } | undefined;
      return Number(row?.total ?? 0);
    };
    const countBySource = (sourceKind: RuntimeEvidenceSource) => Number((this.query(
      "MATCH (e:Evidence {kind: 'MCP_RUNTIME_EVENT', sourceKind: $sourceKind}) RETURN count(e) AS total",
      { sourceKind }
    ).rows[0] as { total?: number } | undefined)?.total ?? 0);
    const countLegacyAdapterEvents = () => Number((this.query(
      "MATCH (e:Evidence {kind: 'MCP_RUNTIME_EVENT'}) WHERE e.sourceKind IS NULL RETURN count(e) AS total"
    ).rows[0] as { total?: number } | undefined)?.total ?? 0);
    const highSeveritySideEffects = this.query(
      "MATCH (e:Evidence {kind: 'MCP_RUNTIME_EVENT', eventType: 'SIDE_EFFECT_OBSERVED', severity: 'HIGH'}) RETURN count(e) AS total"
    ).rows[0] as { total?: number } | undefined;
    return {
      summary: {
        totalEvents: count("MCP_RUNTIME_EVENT"),
        callsStarted: count("MCP_RUNTIME_EVENT", "CALL_STARTED"),
        callsSucceeded: count("MCP_RUNTIME_EVENT", "CALL_SUCCEEDED"),
        callsFailed: count("MCP_RUNTIME_EVENT", "CALL_FAILED"),
        policyDenials: count("MCP_RUNTIME_EVENT", "POLICY_DENIED"),
        sideEffects: count("MCP_RUNTIME_EVENT", "SIDE_EFFECT_OBSERVED"),
        highSeveritySideEffects: Number(highSeveritySideEffects?.total ?? 0),
        gatewayObservedEvents: countBySource("gateway_observed"),
        adapterReportedEvents: countBySource("adapter_reported") + countLegacyAdapterEvents()
      },
      provenance: {
        gatewayObserved: countBySource("gateway_observed"),
        adapterReported: countBySource("adapter_reported") + countLegacyAdapterEvents()
      },
      events: eventRows.map((row) => row.event),
      drift: {
        total: count("MCP_SCHEMA_DRIFT"),
        events: driftRows.map((row) => row.event)
      },
      capabilityDrift: {
        total: count("MCP_CAPABILITY_DRIFT"),
        permissionEscalations: Number((this.query("MATCH (e:Evidence {kind: 'MCP_CAPABILITY_DRIFT', result: 'PERMISSION_ESCALATION'}) RETURN count(e) AS total").rows[0] as { total?: number } | undefined)?.total ?? 0),
        events: capabilityDriftRows.map((row) => row.event)
      },
      blastRadius: {
        total: count("MCP_BLAST_RADIUS_CHANGE"),
        expanded: Number((this.query("MATCH (e:Evidence {kind: 'MCP_BLAST_RADIUS_CHANGE', result: 'EXPANDED'}) RETURN count(e) AS total").rows[0] as { total?: number } | undefined)?.total ?? 0),
        events: blastRadiusRows.map((row) => row.event)
      },
      monitorRuns: {
        total: count("MCP_MONITOR_RUN"),
        latest: this.getMonitorStatus(),
        events: monitorRunRows.map((row) => row.event)
      }
    };
  }

  private captureBlastRadiusSnapshot(serverId: string, observedAt = new Date().toISOString()) {
    const serverRow = this.query(
      "MATCH (s:MCPServer {id: $id, discovered: true}) RETURN properties(s) AS server",
      { id: serverId }
    ).rows[0] as { server: Record<string, unknown> } | undefined;
    if (!serverRow) return null;

    const toolRows = this.query(
      "MATCH (s:MCPServer {id: $id})-[:EXPOSES]->(t:Tool {mcpDiscovered: true}) RETURN properties(t) AS tool ORDER BY t.id",
      { id: serverId }
    ).rows as Array<{ tool: Record<string, unknown> }>;
    const agentRows = this.query(
      "MATCH (a:Agent)-[:CONNECTS_TO|USER_ASSOCIATED_WITH]->(s:MCPServer {id: $id}) RETURN DISTINCT a.id AS id",
      { id: serverId }
    ).rows as Array<{ id: string }>;
    const agentIds = [...new Set(agentRows.map((row) => String(row.id)))].sort();
    const capabilityKeys = [...new Set(toolRows.flatMap(({ tool }) => {
      const value = this.parseStoredJson(tool.inferredCapabilitiesJson);
      return Array.isArray(value) ? value.map((finding) => String((finding as Record<string, unknown>).key ?? "")).filter(Boolean) : [];
    }))].sort();
    const highSensitivityKeys = capabilityKeys.filter((key) => {
      const definition = CAPABILITY_DEFINITIONS.find((item) => item.key === key);
      return definition?.sensitivity === "HIGH" || definition?.sensitivity === "CRITICAL";
    });
    const highRiskToolCount = toolRows.filter(({ tool }) => ["HIGH", "CRITICAL"].includes(String(tool.riskLevel ?? ""))).length;
    const criticalToolCount = toolRows.filter(({ tool }) => tool.riskLevel === "CRITICAL").length;
    const snapshot = {
      agentIds,
      affectedAgentCount: agentIds.length,
      toolIds: toolRows.map(({ tool }) => String(tool.id ?? "")).sort(),
      toolCount: toolRows.length,
      highRiskToolCount,
      criticalToolCount,
      capabilityKeys,
      highSensitivityCapabilityKeys: highSensitivityKeys,
      exposureScore: Number(serverRow.server.exposureScore ?? 0),
      exposureLevel: String(serverRow.server.exposureLevel ?? "UNKNOWN")
    };
    const fingerprint = createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
    const previousFingerprint = String(serverRow.server.blastRadiusFingerprint ?? "");
    const previousValue = this.parseStoredJson(serverRow.server.blastRadiusSnapshotJson);
    const previous = previousValue !== null && typeof previousValue === "object" && !Array.isArray(previousValue)
      ? previousValue as Record<string, unknown>
      : null;

    if (previousFingerprint && previousFingerprint !== fingerprint && previous) {
      const previousAgents = Array.isArray(previous.agentIds) ? previous.agentIds.map(String) : [];
      const previousCapabilities = Array.isArray(previous.capabilityKeys) ? previous.capabilityKeys.map(String) : [];
      const addedAgents = agentIds.filter((id) => !previousAgents.includes(id));
      const removedAgents = previousAgents.filter((id) => !agentIds.includes(id));
      const addedCapabilities = capabilityKeys.filter((key) => !previousCapabilities.includes(key));
      const removedCapabilities = previousCapabilities.filter((key) => !capabilityKeys.includes(key));
      const previousHighRisk = Number(previous.highRiskToolCount ?? 0);
      const previousCritical = Number(previous.criticalToolCount ?? 0);
      const previousScore = Number(previous.exposureScore ?? 0);
      const expanded = addedAgents.length > 0 || addedCapabilities.length > 0 ||
        highRiskToolCount > previousHighRisk || criticalToolCount > previousCritical ||
        snapshot.toolCount > Number(previous.toolCount ?? 0) || snapshot.exposureScore > previousScore;
      const evidenceId = "evidence-blast-radius-" + createHash("sha256")
        .update(serverId + "\0" + observedAt + "\0" + fingerprint)
        .digest("hex").slice(0, 20);
      const evidenceProperties = {
        id: evidenceId,
        kind: "MCP_BLAST_RADIUS_CHANGE",
        title: "MCP blast radius changed: " + String(serverRow.server.name ?? serverId),
        result: expanded ? "EXPANDED" : "CHANGED",
        severity: highRiskToolCount > previousHighRisk || criticalToolCount > previousCritical ||
          snapshot.exposureScore > previousScore || addedCapabilities.some((key) =>
            CAPABILITY_DEFINITIONS.find((item) => item.key === key)?.sensitivity === "CRITICAL"
          ) ? "HIGH" : "MEDIUM",
        source: "Graph relationship and capability snapshot comparison",
        assessmentBasis: "graph-derived exposure",
        age: "just now",
        observedAt,
        serverId,
        serverName: String(serverRow.server.name ?? serverId),
        addedAgents,
        removedAgents,
        addedCapabilities,
        removedCapabilities,
        previousSnapshotJson: JSON.stringify(previous),
        currentSnapshotJson: JSON.stringify(snapshot),
        summary: "The set of connected agents, inferred permissions, or exposed tools changed. This is a graph exposure comparison, not evidence of exploitation."
      };
      this.query("MERGE (e:Evidence {id: $id}) SET e += $props", {
        id: evidenceId,
        props: evidenceProperties
      });
      this.query(
        "MATCH (e:Evidence {id: $evidenceId}), (s:MCPServer {id: $serverId}) MERGE (e)-[:TRACKS_BLAST_RADIUS_ON]->(s)",
        { evidenceId, serverId }
      );
      for (const agentId of [...new Set([...previousAgents, ...agentIds])]) {
        this.query(
          "MATCH (e:Evidence {id: $evidenceId}), (a:Agent {id: $agentId}) MERGE (e)-[:AFFECTS_AGENT]->(a)",
          { evidenceId, agentId }
        );
      }
      this.query(
        "MATCH (s:MCPServer {id: $id}) SET s.lastBlastRadiusChangeAt = $observedAt",
        { id: serverId, observedAt }
      );
    }

    this.query(
      "MATCH (s:MCPServer {id: $id}) SET s.blastRadiusFingerprint = $fingerprint, s.blastRadiusSnapshotJson = $snapshot, s.blastRadiusSnapshotAt = $observedAt",
      { id: serverId, fingerprint, snapshot: JSON.stringify(snapshot), observedAt }
    );
    return snapshot;
  }

  private recalculateAgentExposure() {
    const agents = this.query("MATCH (a:Agent) RETURN a.id AS id").rows as Array<{ id: string }>;
    for (const agent of agents) {
      const links = this.query(
        "MATCH (a:Agent {id: $id})-[:CONNECTS_TO|USER_ASSOCIATED_WITH]->(s:MCPServer {discovered: true}) RETURN properties(s) AS server",
        { id: agent.id }
      ).rows as Array<{ server: Record<string, unknown> }>;
      const exposure = aggregateExposure(links.map((item) => Number(item.server.exposureScore ?? -1)));
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
    this.captureBlastRadiusSnapshot(serverId);
    this.checkpoint();
    return { ok: true as const, agentId, serverId };
  }

  removeAgentMcpAssociation(agentId: string, serverId: string) {
    this.query(
      "MATCH (a:Agent {id: $agentId})-[r:USER_ASSOCIATED_WITH]->(s:MCPServer {id: $serverId, discovered: true}) DELETE r",
      { agentId, serverId }
    );
    this.recalculateAgentExposure();
    this.captureBlastRadiusSnapshot(serverId);
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
