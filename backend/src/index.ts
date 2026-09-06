import Fastify from "fastify";
import cors from "@fastify/cors";
import { itemsRoutes } from "./routes/items.js";
import { bankRoutes } from "./routes/bank.js";
import { alertsRoutes } from "./routes/alerts.js";
import { scorekeepingRoutes } from "./routes/scorekeeping.js";
import { llmRoutes } from "./routes/llm.js";
import { visionRoutes } from "./routes/vision.js";
import { newsRoutes } from "./routes/news.js";
import { setsRoutes } from "./routes/sets.js";
import { playerRoutes } from "./routes/player.js";
import { trendsRoutes } from "./routes/trends.js";
import { substitutionsRoutes } from "./routes/substitutions.js";
import { researchReportRoutes } from "./routes/researchReport.js";
import { sectorsRoutes } from "./routes/sectors.js";
import { indicesRoutes } from "./routes/indices.js";
import { indicatorsRoutes } from "./routes/indicators.js";
import { ledgerRoutes } from "./routes/ledger.js";
import { tradingHoursRoutes } from "./routes/tradingHours.js";
import { itemOfTheHourRoutes } from "./routes/itemOfTheHour.js";
import { bossingRoutes } from "./routes/bossing.js";
import { highlightsRoutes } from "./routes/highlights.js";
import { skillingRoutes } from "./routes/skilling.js";
import { startPolling } from "./poller.js";
import { closeWarehouse } from "./warehouse.js";

// Default 1MB body limit is too small for a base64-encoded GE screenshot upload (vision.ts) --
// a full-window PNG easily runs several MB once base64-inflated (~33% larger than the raw file).
const app = Fastify({ logger: true, bodyLimit: 20 * 1024 * 1024 });

await app.register(cors, { origin: true });
await app.register(itemsRoutes);
await app.register(bankRoutes);
await app.register(alertsRoutes);
await app.register(scorekeepingRoutes);
await app.register(llmRoutes);
await app.register(visionRoutes);
await app.register(newsRoutes);
await app.register(setsRoutes);
await app.register(playerRoutes);
await app.register(trendsRoutes);
await app.register(substitutionsRoutes);
await app.register(researchReportRoutes);
await app.register(sectorsRoutes);
await app.register(indicesRoutes);
await app.register(indicatorsRoutes);
await app.register(ledgerRoutes);
await app.register(tradingHoursRoutes);
await app.register(itemOfTheHourRoutes);
await app.register(bossingRoutes);
await app.register(highlightsRoutes);
await app.register(skillingRoutes);

startPolling();

const PORT = 3001;
app.listen({ port: PORT, host: "127.0.0.1" }).then(() => {
  console.log(`Project Flashwave backend listening on http://127.0.0.1:${PORT}`);
});

// Do not let one stray promise take the whole backend down with it.
//
// Node terminates the process on an unhandled rejection by default. This server is a long-running
// local daemon with a dozen background pollers touching the network, SQLite, DuckDB and a local
// LLM, and every one of those is a place a promise can reject somewhere nobody wrapped. When it
// happens the process exits, every open tab starts failing every request, and the only symptom the
// user gets is an app that "disconnected" with nothing on screen saying why.
//
// Logging loudly and staying up is the right trade for a single-user local tool: a poller that
// failed once will run again on its next tick, and a half-broken app you can still read beats a
// dead one. The stack goes to the console so the actual fault is still recoverable.
process.on("unhandledRejection", (reason) => {
  console.error("[fatal-guard] unhandled promise rejection, staying up:", reason);
});
process.on("uncaughtException", (err) => {
  console.error("[fatal-guard] uncaught exception, staying up:", err);
});

// DESIGN.md §14.9: checkpoint + cleanly close the DuckDB warehouse on shutdown so a tsx-watch
// hot-reload restart doesn't leave its WAL in a state the next process can't replay.
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    closeWarehouse().finally(() => process.exit(0));
  });
}
