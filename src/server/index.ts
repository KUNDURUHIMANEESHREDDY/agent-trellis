import "dotenv/config";
import { createApp } from "./api";
import { AgentGraph } from "./graph";
import { MCPContinuousMonitor } from "./monitor";

async function main() {
  const graph = new AgentGraph();
  await graph.initialize();
  const monitor = new MCPContinuousMonitor(graph);
  const app = createApp(graph, monitor);
  const port = Number(process.env.PORT || 8787);
  const server = app.listen(port, "127.0.0.1", () => {
    console.log("AgentTrellis API listening on http://localhost:" + port);
    console.log("Relate graph ready; persistent storage enabled.");
    console.log(
      "Continuous MCP monitor " + (monitor.getStatus().enabled ? "enabled" : "disabled") +
      " · interval " + monitor.getStatus().intervalMs + "ms" +
      " · stdio auto-inspection " + (monitor.getStatus().includeStdio ? "enabled" : "disabled")
    );
    monitor.start();
  });

  const shutdown = () => {
    monitor.stop();
    server.close(() => {
      graph.checkpoint();
      process.exit(0);
    });
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}
main().catch((error) => {
  console.error("Failed to start AgentTrellis:", error);
  process.exit(1);
});
