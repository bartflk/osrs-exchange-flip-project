import type { FastifyInstance } from "fastify";
import { computeTradingHours } from "../tradingHours.js";
import { generateTradingHoursSummary } from "../llm.js";
import { db, kvGetFresh, kvSet } from "../db.js";

// DESIGN.md §14.43: when to trade a given item, by hour of day.

const itemNameStmt = db.prepare(`SELECT name FROM items WHERE id = ?`);
const SUMMARY_TTL_MS = 12 * 60 * 60 * 1000;

function fmtHour(h: number | null): string | null {
  if (h == null) return null;
  return `${String(h).padStart(2, "0")}:00 UTC`;
}
function fmtPct(v: number | null | undefined): string | null {
  if (v == null) return null;
  return `${(v * 100).toFixed(2)}%`;
}

export async function tradingHoursRoutes(app: FastifyInstance) {
  app.get("/api/items/:id/trading-hours", async (req, reply) => {
    const { id } = req.params as { id: string };
    const itemId = Number(id);
    if (!Number.isFinite(itemId)) return reply.code(400).send({ error: "bad item id" });
    try {
      return await computeTradingHours(itemId);
    } catch (err) {
      req.log.error(err, "trading hours failed");
      return reply.code(502).send({ error: "Could not fetch hourly history for this item." });
    }
  });

  // The narrated version. Split from the data route so the chart/table render instantly and
  // don't wait on a 10-30s local LLM generation -- same split as the item "explain the pick" flow.
  app.get("/api/items/:id/trading-hours/summary", async (req, reply) => {
    const { id } = req.params as { id: string };
    const { refresh } = req.query as { refresh?: string };
    const itemId = Number(id);
    if (!Number.isFinite(itemId)) return reply.code(400).send({ error: "bad item id" });

    const cacheKey = `tradingHoursSummary:${itemId}`;
    if (refresh !== "true") {
      const cached = kvGetFresh<{ summary: string }>(cacheKey, SUMMARY_TTL_MS);
      if (cached) return cached;
    }

    try {
      const data = await computeTradingHours(itemId);
      const meta = itemNameStmt.get(itemId) as { name: string } | undefined;

      const buyDev = data.bestBuyHourUtc != null ? data.hours[data.bestBuyHourUtc].buyDeviation : null;
      const sellDev =
        data.bestSellHourUtc != null ? data.hours[data.bestSellHourUtc].sellDeviation : null;

      // Every number is formatted to a display string here, before the model sees it. §14.30:
      // handing over a raw 0.481 and asking for a percentage produced "0.48%" in a live test.
      const summary = await generateTradingHoursSummary({
        itemName: meta?.name ?? `Item ${itemId}`,
        bestBuyHour: fmtHour(data.bestBuyHourUtc),
        bestSellHour: fmtHour(data.bestSellHourUtc),
        buyDiscount: fmtPct(buyDev),
        sellPremium: fmtPct(sellDev),
        timingEdge: fmtPct(data.timingEdgePct),
        holdHours: data.holdHours,
        busiestHour: fmtHour(data.busiestHourUtc),
        quietestHour: fmtHour(data.quietestHourUtc),
        daysCovered: data.daysCovered,
        reliable: data.reliable,
        caveat: data.caveat,
      });

      const payload = { summary };
      kvSet(cacheKey, JSON.stringify(payload));
      return payload;
    } catch (err) {
      req.log.error(err, "trading hours summary failed");
      return reply.code(502).send({ error: "Could not generate a summary (is Ollama running?)" });
    }
  });
}
