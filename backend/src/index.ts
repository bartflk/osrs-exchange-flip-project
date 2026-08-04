import Fastify from "fastify";
import cors from "@fastify/cors";
import { itemsRoutes } from "./routes/items.js";
import { bankRoutes } from "./routes/bank.js";
import { startPolling } from "./poller.js";

const app = Fastify({ logger: true });

await app.register(cors, { origin: true });
await app.register(itemsRoutes);
await app.register(bankRoutes);

startPolling();

const PORT = 3001;
app.listen({ port: PORT, host: "127.0.0.1" }).then(() => {
  console.log(`OSRS flip backend listening on http://127.0.0.1:${PORT}`);
});
