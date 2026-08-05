import type { FastifyInstance } from "fastify";
import { getTrackRecord } from "../scorekeeping.js";

export async function scorekeepingRoutes(app: FastifyInstance) {
  app.get("/api/track-record", async () => getTrackRecord());
}
