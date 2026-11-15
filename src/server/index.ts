import "dotenv/config";
import { createApp } from "./api";
import { AgentGraph } from "./graph";

async function main() {
  const graph = new AgentGraph();
  await graph.initialize();
  const app = createApp(graph);
  const port = Number(process.env.PORT || 8787);
  app.listen(port, () => {
    console.log(`AgentTrellis API listening on http://localhost:${port}`);
    console.log("Relate graph ready; persistent storage enabled.");
  });
}
main().catch((error) => {
  console.error("Failed to start AgentTrellis:", error);
  process.exit(1);
});
