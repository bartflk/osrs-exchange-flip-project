import type { FastifyInstance } from "fastify";
import { computeTrend, type TrendWindow } from "../trends.js";

const VALID_WINDOWS: TrendWindow[] = ["1h", "4h", "12h", "24h", "7d", "30d"];

export async function trendsRoutes(app: FastifyInstance) {
  app.get("/api/trends", async (req, reply) => {
    const query = req.query as { window?: string };
    const window = (query.window ?? "24h") as TrendWindow;
    if (!VALID_WINDOWS.includes(window)) {
      return reply.code(400).send({ error: "invalid window" });
    }
    const entries = await computeTrend(window);
    return { window, entries };
  });
}
