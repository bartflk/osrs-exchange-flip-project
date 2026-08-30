import type { FastifyInstance } from "fastify";
import { computeHighlights, HIGHLIGHT_WINDOWS, type HighlightWindow } from "../highlights.js";

export async function highlightsRoutes(app: FastifyInstance) {
  app.get("/api/highlights", async (req, reply) => {
    const query = req.query as { window?: string };
    const window = (query.window ?? "1d") as HighlightWindow;
    if (!HIGHLIGHT_WINDOWS.includes(window)) {
      return reply.code(400).send({ error: "invalid window" });
    }
    return computeHighlights(window);
  });
}
