import type { FastifyInstance } from "fastify";
import { getRecentEvents } from "../db.js";
import { computeUpdateSensitivity } from "../updateSensitivity.js";
import { scanChatter, scanForHeldItems } from "../nerfWatch.js";
import { backfillEventBodies } from "../newsArticles.js";

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

  // Drain the article-body backlog on demand instead of waiting out the poller's half-hourly
  // passes. Same shape as the money-maker, indices and item-of-the-hour refresh endpoints: fire
  // and forget, because a full archive pass is dozens of outbound fetches and the caller has no
  // reason to hold a connection open for it.
  app.post("/api/news/backfill-bodies", async (req) => {
    const { budget } = (req.body ?? {}) as { budget?: unknown };
    const n =
      typeof budget === "number" && Number.isFinite(budget)
        ? Math.min(60, Math.max(1, Math.round(budget)))
        : undefined;
    backfillEventBodies(n).catch((err) => req.log.error({ err }, "news body backfill failed"));
    return { started: true };
  });

  // Official changelogs that name something you are holding, nerfs first.
  //
  // POST, and a body rather than a query string, because the caller sends its whole bank -- a few
  // hundred ids after a real import, which is past what a URL should be asked to carry. It also
  // keeps holdings out of request logs, which a GET would write down on every poll.
  //
  // Holdings stay in the browser either way: they live in localStorage (bankHoldings.ts) and are
  // sent here per-request to be matched, never stored server-side. This endpoint reads the ids
  // and forgets them.
  app.post("/api/nerf-watch", async (req, reply) => {
    const { itemIds, lookbackDays } = (req.body ?? {}) as {
      itemIds?: unknown;
      lookbackDays?: unknown;
    };
    if (!Array.isArray(itemIds)) {
      return reply.code(400).send({ error: "itemIds: number[] required" });
    }
    const ids = itemIds.filter((v): v is number => typeof v === "number" && Number.isFinite(v));
    const days =
      typeof lookbackDays === "number" && Number.isFinite(lookbackDays)
        ? Math.min(180, Math.max(1, Math.round(lookbackDays)))
        : undefined;
    // Two lists, not one merged feed. Changelogs state facts about the game; Reddit states facts
    // about a conversation, and the caller renders them at different weights precisely because
    // they are worth different amounts. Merging here would throw that distinction away before the
    // UI ever got the chance to honour it.
    return { matches: scanForHeldItems(ids, days), chatter: scanChatter(ids) };
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
