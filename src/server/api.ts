import express from "express";
import cors from "cors";
import fs from "node:fs";
import path from "node:path";
import { AgentGraph } from "./graph";

export function createApp(graph: AgentGraph) {
  const app = express();
  app.use(cors());
  app.use(express.json({ limit: "1mb" }));

  app.get("/api/health", (_req, res) => res.json({ status: "ok", graph: "relate", persistent: true }));
  app.get("/api/overview", (_req, res) => res.json(graph.getOverview()));
  app.get("/api/graph", (_req, res) => res.json(graph.getGraph()));
  app.get("/api/agents", (_req, res) => res.json(graph.getAgents()));
  app.get("/api/evidence", (_req, res) => res.json(graph.getEvidence()));
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
