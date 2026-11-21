import express from "express";
import cors from "cors";
import fs from "node:fs";
import path from "node:path";
import { timingSafeEqual } from "node:crypto";
import { AgentGraph } from "./graph";
import { discoverMcpConfigurations, resolveMcpServerConfig } from "./discovery";
import { inspectMcpServer } from "./mcp-inspector";

export function createApp(graph: AgentGraph) {
  const app = express();
  const apiPort = Number(process.env.PORT || 8787);
  const allowedOrigins = new Set([
    "http://localhost:5173",
    "http://127.0.0.1:5173",
    "http://localhost:" + apiPort,
    "http://127.0.0.1:" + apiPort
  ]);
  app.use(cors({
    origin(origin, callback) {
      callback(null, !origin || allowedOrigins.has(origin));
    }
  }));
  app.use(express.json({ limit: "1mb" }));

  app.get("/api/health", (_req, res) => res.json({ status: "ok", graph: "relate", persistent: true }));
  app.get("/api/overview", (_req, res) => res.json(graph.getOverview()));
  app.get("/api/graph", (_req, res) => res.json(graph.getGraph()));
  app.get("/api/agents", (_req, res) => res.json(graph.getAgents()));
  app.get("/api/evidence", (_req, res) => res.json(graph.getEvidence()));
  app.get("/api/discovery/mcp", (_req, res) => res.json(graph.getDiscoveredMcpServers()));
  app.get("/api/inspection/mcp", (_req, res) => res.json(graph.getMcpInspections()));
  app.get("/api/runtime/monitoring", (_req, res) => res.json({
    ...graph.getRuntimeMonitoring(),
    telemetryConfigured: Boolean(process.env.AGENT_TRELLIS_RUNTIME_TOKEN)
  }));
  app.post("/api/runtime/events", (req, res) => {
    const configuredToken = process.env.AGENT_TRELLIS_RUNTIME_TOKEN;
    if (!configuredToken) {
      return res.status(503).json({ error: "Runtime telemetry ingestion is disabled. Configure AGENT_TRELLIS_RUNTIME_TOKEN and restart the API." });
    }
    const suppliedToken = req.header("x-agent-trellis-token") ?? "";
    const expectedBytes = Buffer.from(configuredToken);
    const suppliedBytes = Buffer.from(suppliedToken);
    const authorized = expectedBytes.length === suppliedBytes.length && timingSafeEqual(expectedBytes, suppliedBytes);
    if (!authorized) return res.status(401).json({ error: "Invalid runtime telemetry token." });

    const result = graph.recordRuntimeEvent(req.body);
    if (!result.ok) return res.status(result.status).json({ error: result.error });
    return res.status(result.duplicate ? 200 : 201).json(result);
  });
  app.get("/api/capabilities/intelligence", (_req, res) => res.json(graph.getCapabilityIntelligence()));
  app.post("/api/capabilities/analyze", (req, res) => {
    const serverId = typeof req.body?.serverId === "string" ? req.body.serverId : undefined;
    if (serverId && !graph.getDiscoveredMcpServers().some((server) => server.id === serverId)) {
      return res.status(404).json({ error: "Discovered MCP server not found." });
    }
    return res.json(graph.analyzeMcpCapabilities(serverId));
  });
  app.post("/api/agents/:agentId/mcp-servers/:serverId", (req, res) => {
    const result = graph.associateAgentWithMcpServer(req.params.agentId, req.params.serverId);
    if (!result.ok) return res.status(result.status).json({ error: result.error });
    return res.status(201).json(result);
  });
  app.delete("/api/agents/:agentId/mcp-servers/:serverId", (req, res) => {
    return res.json(graph.removeAgentMcpAssociation(req.params.agentId, req.params.serverId));
  });

  const activeInspections = new Set<string>();
  app.get("/api/inspection/mcp/:serverId/approval-preview", (req, res) => {
    const server = graph.getDiscoveredMcpServers().find((item) => item.id === req.params.serverId);
    if (!server) return res.status(404).json({ error: "Discovered MCP server not found." });
    if (server.transport !== "stdio") return res.status(400).json({ error: "Only stdio servers require a process preview." });

    const roots = (process.env.AGENT_TRELLIS_WORKSPACES || "")
      .split(path.delimiter).map((item) => item.trim()).filter(Boolean);
    const target = resolveMcpServerConfig(server.id, { workspaceRoots: [process.cwd(), ...roots] });
    if (!target) return res.status(409).json({ error: "Configuration changed after discovery. Run discovery again." });

    const command = typeof target.config.command === "string" ? target.config.command : "";
    if (!command) return res.status(409).json({ error: "Configured stdio command is missing." });
    const rawArgs = target.config.args ?? [];
    if (!Array.isArray(rawArgs) || rawArgs.some((item) => typeof item !== "string")) {
      return res.status(409).json({ error: "Configured stdio arguments are invalid." });
    }

    const sensitiveOption = /^--?(?:token|secret|password|api[-_]?key|authorization|credential)$/i;
    const sensitiveAssignment = /^((?:--?)?(?:token|secret|password|api[-_]?key|authorization|credential))=/i;
    const sensitiveUrlPart = /([?&](?:access_token|api[-_]?key|token|secret|password)=)[^&#\s]+/gi;
    let redactNext = false;
    const args = (rawArgs as string[]).map((argument) => {
      if (redactNext) {
        redactNext = false;
        return "[REDACTED]";
      }
      const assignment = sensitiveAssignment.exec(argument);
      if (assignment) return assignment[1] + "=[REDACTED]";
      if (sensitiveOption.test(argument)) {
        redactNext = true;
        return argument.slice(0, 500);
      }
      return argument
        .replace(/(https?:\/\/)[^/@\s]+@/gi, "$1[REDACTED]@")
        .replace(sensitiveUrlPart, "$1[REDACTED]")
        .replace(/(?:authorization|bearer)\s*[:=]?\s+[^\s,;]+/gi, "[REDACTED AUTHORIZATION]")
        .slice(0, 500);
    });

    const cwd = typeof target.config.cwd === "string" && target.config.cwd.trim().length > 0
      ? path.resolve(path.dirname(server.configPath), target.config.cwd)
      : path.dirname(server.configPath);
    const env = target.config.env && typeof target.config.env === "object" && !Array.isArray(target.config.env)
      ? target.config.env as Record<string, unknown>
      : {};
    return res.json({
      command: command.slice(0, 500),
      args,
      argumentCount: args.length,
      cwd,
      environmentKeys: Object.keys(env).sort(),
      sensitiveValuesRedacted: true
    });
  });

  app.post("/api/inspection/mcp/:serverId", async (req, res) => {
    const serverId = req.params.serverId;
    const server = graph.getDiscoveredMcpServers().find((item) => item.id === serverId);
    if (!server) return res.status(404).json({ error: "Discovered MCP server not found. Run discovery again." });
    if (server.transport === "stdio" && req.body?.approveStdio !== true) {
      return res.status(428).json({ error: "Local stdio process execution requires explicit approval." });
    }
    if (activeInspections.has(serverId)) {
      return res.status(409).json({ error: "An inspection for this MCP server is already running." });
    }

    const configuredRoots = (process.env.AGENT_TRELLIS_WORKSPACES || "")
      .split(path.delimiter)
      .map((value) => value.trim())
      .filter(Boolean);
    const target = resolveMcpServerConfig(serverId, {
      workspaceRoots: [process.cwd(), ...configuredRoots]
    });
    if (!target) {
      return res.status(409).json({ error: "The MCP configuration changed after discovery. Run discovery again." });
    }

    activeInspections.add(serverId);
    try {
      const outcome = await inspectMcpServer(target);
      const recorded = graph.recordMcpInspection(outcome);
      if (!recorded) return res.status(404).json({ error: "MCP server disappeared during inspection." });
      return res.json({
        ...recorded,
        protocolEra: outcome.protocolEra,
        protocolVersion: outcome.protocolVersion,
        serverInfo: outcome.serverInfo,
        declaredCapabilities: outcome.declaredCapabilities,
        observedCapabilities: outcome.observedCapabilities
      });
    } finally {
      activeInspections.delete(serverId);
    }
  });
  app.post("/api/discovery/mcp", (_req, res) => {
    const configuredRoots = (process.env.AGENT_TRELLIS_WORKSPACES || "")
      .split(path.delimiter)
      .map((value) => value.trim())
      .filter(Boolean);
    const discovery = discoverMcpConfigurations({
      workspaceRoots: [process.cwd(), ...configuredRoots]
    });
    graph.syncMcpDiscovery(discovery);
    return res.json({
      scannedConfigFiles: discovery.scannedConfigPaths.length,
      discoveredServers: discovery.servers.length,
      diagnostics: discovery.diagnostics,
      servers: graph.getDiscoveredMcpServers()
    });
  });
  app.get("/api/impact/:toolId", (req, res) => {
    const impact = graph.getImpact(req.params.toolId);
    if (!impact) return res.status(404).json({ error: "Tool not found" });
    return res.json(impact);
  });
  app.post("/api/simulations/:toolId/compromise", (req, res) => {
    const impact = graph.simulateCompromise(req.params.toolId);
    if (!impact) return res.status(404).json({ error: "Tool not found" });
    return res.status(201).json(impact);
  });
  app.post("/api/demo/reset", (_req, res) => {
    graph.reset();
    return res.json({ status: "reset", overview: graph.getOverview() });
  });

  const clientDir = path.resolve("dist/client");
  if (fs.existsSync(clientDir)) {
    app.use(express.static(clientDir));
    app.get("*", (_req, res) => res.sendFile(path.join(clientDir, "index.html")));
  }

  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const message = error instanceof Error ? error.message : "Unexpected server error";
    res.status(500).json({ error: message });
  });
  return app;
}
