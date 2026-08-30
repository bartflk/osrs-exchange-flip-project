import type { FastifyInstance } from "fastify";
import { getRecentEvents } from "../db.js";
import { computeUpdateSensitivity } from "../updateSensitivity.js";

export async function newsRoutes(app: FastifyInstance) {
  app.get("/api/news", async () => {
    // 150, not 50. The tab splits these into a Game news section and a Reddit section, and the
    // two sources arrive at very different rates -- a single chronological cut of 50 is mostly
    // the faster one, which would leave the official section near-empty however many patch notes
    // are actually stored.
    const events = getRecentEvents(150);
    return {
      events: events.map((e) => ({
        id: e.id,
        eventDate: e.event_date,
        title: e.title,
        summary: e.summary,
        source: e.source,
        link: e.link,
        tags: e.tags,
      })),
    };
  });

  // DESIGN.md §10 item 45: rank items by how much a given patch moved their price, before/after.
  app.get("/api/update-sensitivity", async (req, reply) => {
    const { eventDate, windowDays } = req.query as { eventDate?: string; windowDays?: string };
    if (!eventDate || !/^\d{4}-\d{2}-\d{2}$/.test(eventDate)) {
      return reply.code(400).send({ error: "eventDate=YYYY-MM-DD required" });
    }
    const days = Number(windowDays);
    const window = Number.isFinite(days) ? Math.min(14, Math.max(1, Math.round(days))) : 3;
    return computeUpdateSensitivity(eventDate, window);
  });
}
