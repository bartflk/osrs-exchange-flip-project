import type { FastifyInstance } from "fastify";
import { getRecentEvents } from "../warehouse.js";

export async function newsRoutes(app: FastifyInstance) {
  app.get("/api/news", async () => {
    const events = await getRecentEvents(50);
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
}
