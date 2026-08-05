import type { FastifyInstance } from "fastify";
import { computeSetArbitrage } from "../setArbitrage.js";
import { computeBarrowsRepairFlips } from "../barrowsRepair.js";

export async function setsRoutes(app: FastifyInstance) {
  app.get("/api/sets/arbitrage", async () => ({ sets: computeSetArbitrage() }));
  app.get("/api/sets/barrows-repair", async () => ({ flips: computeBarrowsRepairFlips() }));
}
