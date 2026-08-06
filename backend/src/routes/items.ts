import type { FastifyInstance } from "fastify";
import { db } from "../db.js";
import { scoreItem, type ItemRow } from "../signals.js";
import { fetchTimeseries, fetchAllTimeHistory, type Lookback } from "../wiki.js";
import { getWarehouseStatus } from "../warehouse.js";
import { getSidecarStatus } from "../sidecar.js";
import { computeForecast } from "../forecast.js";
import { getPricePollTiming } from "../poller.js";

export async function itemsRoutes(app: FastifyInstance) {
  app.get("/api/items", async (req) => {
    const query = req.query as {
      minVolume?: string;
      membersOnly?: string;
      search?: string;
      ids?: string;
    };

    const rows = db
      .prepare(
        `
      SELECT i.id, i.name, i.members, i.buy_limit, i.icon,
             s.high, s.low, s.vol_high_5m, s.vol_low_5m, s.vol_high_1h, s.vol_low_1h, s.updated_at
      FROM items i
      JOIN latest_snapshot s ON s.item_id = i.id
      WHERE s.high IS NOT NULL AND s.low IS NOT NULL
    `,
      )
      .all() as ItemRow[];

    let scored = rows.map(scoreItem).filter((r) => r.net_margin != null);

    // Explicit id lookup (e.g. watchlist) bypasses the liquidity/search filters below --
    // a pinned illiquid item shouldn't vanish just because it fails the Market tab's filter.
    if (query.ids) {
      const idSet = new Set(query.ids.split(",").map(Number));
      const wanted = scored.filter((r) => idSet.has(r.id));
      wanted.sort((a, b) => b.score - a.score);
      return { count: wanted.length, items: wanted };
    }

    const minVolume = query.minVolume ? Number(query.minVolume) : 0;
    if (minVolume > 0) {
      scored = scored.filter((r) => r.liquidity >= minVolume);
    }
    if (query.membersOnly === "false") {
      scored = scored.filter((r) => r.members === 0);
    }
    if (query.search) {
      const needle = query.search.toLowerCase();
      scored = scored.filter((r) => r.name.toLowerCase().includes(needle));
    }

    scored.sort((a, b) => b.score - a.score);

    return { count: scored.length, items: scored.slice(0, 300) };
  });

  app.get("/api/items/:id/history", async (req) => {
    const { id } = req.params as { id: string };
    const rows = db
      .prepare(
        `SELECT ts, high, low, avg_high_5m, avg_low_5m FROM price_history WHERE item_id = ? ORDER BY ts ASC LIMIT 2000`,
      )
      .all(Number(id));
    return { itemId: Number(id), history: rows };
  });

  // Longer-range chart data than our own local polling has accumulated so far --
  // proxies the Wiki API directly rather than waiting for local history to build up.
  const VALID_LOOKBACKS: Lookback[] = ["6h", "24h", "7d", "30d", "6m", "1y", "all"];
  app.get("/api/items/:id/timeseries", async (req, reply) => {
    const { id } = req.params as { id: string };
    const query = req.query as { lookback?: string };
    const lookback = (query.lookback ?? "24h") as Lookback;
    if (!VALID_LOOKBACKS.includes(lookback)) {
      return reply.code(400).send({ error: "invalid lookback" });
    }
    try {
      // "all" isn't a real Wiki Real-time Prices lookback (that API caps at 1y) -- it's
      // served from weirdgloop's separate long-range history instead, and reshaped into the
      // same point shape the frontend chart already expects (see fetchAllTimeHistory's docs).
      if (lookback === "all") {
        const longRange = await fetchAllTimeHistory(Number(id));
        const points = longRange.map((p) => ({
          timestamp: p.timestamp,
          avgHighPrice: p.price,
          avgLowPrice: p.price,
          highPriceVolume: p.volume ?? 0,
          lowPriceVolume: 0,
        }));
        return { itemId: Number(id), lookback, points, blended: true };
      }
      const points = await fetchTimeseries(Number(id), lookback);
      return { itemId: Number(id), lookback, points };
    } catch (err) {
      req.log.error(err);
      return reply.code(502).send({ error: "failed to fetch timeseries" });
    }
  });

  // DESIGN.md §14.12: IQR prediction bands -- deterministic quantile forecast, see forecast.ts.
  app.get("/api/items/:id/forecast", async (req, reply) => {
    const { id } = req.params as { id: string };
    const itemId = Number(id);
    const snapshot = db
      .prepare(`SELECT high FROM latest_snapshot WHERE item_id = ?`)
      .get(itemId) as { high: number | null } | undefined;
    if (!snapshot || snapshot.high == null) {
      return reply.code(400).send({ error: "item not currently tradeable" });
    }
    const forecast = computeForecast(itemId, snapshot.high);
    if (!forecast) {
      return reply.code(200).send({ itemId, points: [], historicalSamples: 0 });
    }
    return { itemId, ...forecast };
  });

  // Item lookup independent of the Market tab's tradeability/liquidity filters --
  // used by the global search box, and by bank-value lookups for items that may
  // have thin/no recent trade data.
  app.get("/api/lookup", async (req) => {
    const query = req.query as { q?: string };
    if (!query.q || query.q.trim().length < 2) return { items: [] };
    const needle = `%${query.q.toLowerCase()}%`;
    const rows = db
      .prepare(
        `
      SELECT i.id, i.name, i.members, i.buy_limit, i.icon, i.value,
             s.high, s.low, s.vol_high_5m, s.vol_low_5m, s.vol_high_1h, s.vol_low_1h, s.updated_at
      FROM items i
      LEFT JOIN latest_snapshot s ON s.item_id = i.id
      WHERE LOWER(i.name) LIKE ?
      ORDER BY i.name
      LIMIT 20
    `,
      )
      .all(needle) as (ItemRow & { value: number })[];

    return {
      items: rows.map((r) => ({
        ...r,
        ...scoreItem(r),
      })),
    };
  });

  app.get("/api/status", async () => {
    const itemCount = (db.prepare("SELECT COUNT(*) as c FROM items").get() as { c: number }).c;
    const lastUpdate = db.prepare("SELECT MAX(updated_at) as t FROM latest_snapshot").get() as {
      t: number | null;
    };
    const [warehouse, sidecar] = await Promise.all([getWarehouseStatus(), getSidecarStatus()]);
    const { nextPricePollAt } = getPricePollTiming();
    return { itemCount, lastUpdate: lastUpdate.t, warehouse, sidecar, nextPricePollAt };
  });
}
