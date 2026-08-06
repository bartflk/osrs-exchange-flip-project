import Fastify from "fastify";
import cors from "@fastify/cors";
import { itemsRoutes } from "./routes/items.js";
import { bankRoutes } from "./routes/bank.js";
import { alertsRoutes } from "./routes/alerts.js";
import { scorekeepingRoutes } from "./routes/scorekeeping.js";
import { llmRoutes } from "./routes/llm.js";
import { newsRoutes } from "./routes/news.js";
import { setsRoutes } from "./routes/sets.js";
import { playerRoutes } from "./routes/player.js";
import { trendsRoutes } from "./routes/trends.js";
import { substitutionsRoutes } from "./routes/substitutions.js";
import { researchReportRoutes } from "./routes/researchReport.js";
import { startPolling } from "./poller.js";
import { closeWarehouse } from "./warehouse.js";

const app = Fastify({ logger: true });

await app.register(cors, { origin: true });
await app.register(itemsRoutes);
await app.register(bankRoutes);
await app.register(alertsRoutes);
await app.register(scorekeepingRoutes);
await app.register(llmRoutes);
await app.register(newsRoutes);
await app.register(setsRoutes);
await app.register(playerRoutes);
await app.register(trendsRoutes);
await app.register(substitutionsRoutes);
await app.register(researchReportRoutes);

startPolling();

const PORT = 3001;
app.listen({ port: PORT, host: "127.0.0.1" }).then(() => {
  console.log(`OSRS flip backend listening on http://127.0.0.1:${PORT}`);
});

// DESIGN.md §14.9: checkpoint + cleanly close the DuckDB warehouse on shutdown so a tsx-watch
// hot-reload restart doesn't leave its WAL in a state the next process can't replay.
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    closeWarehouse().finally(() => process.exit(0));
  });
}
