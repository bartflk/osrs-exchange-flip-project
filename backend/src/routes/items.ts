import type { FastifyInstance } from "fastify";
import { db } from "../db.js";
import { scoreItem, type ItemRow, type ScoredItem } from "../signals.js";
import { scoreFlip } from "../flipScore.js";
import { fetchTimeseries, fetchAllTimeHistory, type Lookback } from "../wiki.js";
import { getWarehouseStatus } from "../warehouse.js";
import { getSidecarStatus } from "../sidecar.js";
import { computeForecast } from "../forecast.js";
import { getPricePollTiming } from "../poller.js";
import { getLinkedEventsForItem } from "../eventItemLinking.js";

/** When this process came up. A change in it means the backend restarted under the client. */
const STARTED_AT = Date.now();

// How many rows each ranking contributes to the page the table receives.
const PER_RANKING = 250;

/**
 * The union of the leaders under every ranking the table can sort by.
 *
 * The old cut was the top 300 by score alone, and that quietly broke every other column: the table
 * sorts what it was given, so "sort by volume" ranked the 300 highest-margin items by volume and
 * Air rune, the single most traded item in the game, was never in the payload to be found. Any one
 * ranking is a bad sample for the others, because margin and volume are close to opposites.
 *
 * Descending only, which is the honest limit of this: sorting a column ASCENDING still sees only
 * the union, so "worst margin in the game" is not answerable from here. Nobody sorts for that.
 */
function topUnion(scored: ScoredItem[]): ScoredItem[] {
  const rankings: ((r: ScoredItem) => number | null)[] = [
    (r) => r.flip?.score ?? null,
    (r) => r.net_margin,
    (r) => r.roi_pct,
    (r) => r.daily_volume,
    (r) => r.margin_x_volume,
    (r) => r.limit_adjusted_profit,
    (r) => r.liquidity,
  ];
  const picked = new Map<number, ScoredItem>();
  for (const key of rankings) {
    const ranked = scored
      .filter((r) => key(r) != null && Number.isFinite(key(r) as number))
      .sort((a, b) => (key(b) as number) - (key(a) as number))
      .slice(0, PER_RANKING);
    for (const r of ranked) picked.set(r.id, r);
  }
  return [...picked.values()];
}

const SPARK_HOURS = 24;
const SPARK_BUCKET_SECONDS = 2 * 60 * 60;

const sparkStmt = db.prepare(`
  SELECT item_id, CAST(ts / ${SPARK_BUCKET_SECONDS} AS INTEGER) AS bucket, MAX(ts) AS last_ts, high
  FROM price_history
  WHERE ts >= ? AND high IS NOT NULL
  GROUP BY item_id, bucket
  ORDER BY item_id, bucket
`);

/**
 * A twelve-point price trace over the last day, attached in place.
 *
 * Shape, not scale: the row already carries the price. What a number cannot show is whether the
 * item is drifting down into the spread you are about to buy, which is the thing worth seeing
 * before clicking into a chart. Sourced from local price_history, so an item this install has not
 * been watching long gets a short line or none, and the UI draws nothing rather than a flat line
 * that would read as a stable price.
 */
function attachSparklines(items: ScoredItem[]) {
  const since = Math.floor(Date.now() / 1000) - SPARK_HOURS * 3600;
  const rows = sparkStmt.all(since) as unknown as { item_id: number; high: number }[];
  const byItem = new Map<number, number[]>();
  for (const r of rows) {
    const list = byItem.get(r.item_id);
    if (list) list.push(r.high);
    else byItem.set(r.item_id, [r.high]);
  }
  for (const item of items) item.spark = byItem.get(item.id) ?? [];
}

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
             s.high, s.low, s.vol_high_5m, s.vol_low_5m, s.vol_high_1h, s.vol_low_1h, s.updated_at,
             s.high_time, s.low_time, i.daily_volume
      FROM items i
      JOIN latest_snapshot s ON s.item_id = i.id
      WHERE s.high IS NOT NULL AND s.low IS NOT NULL
    `,
      )
      .all() as unknown as ItemRow[];

    let scored = rows.map(scoreItem).filter((r) => r.net_margin != null);
    for (const item of scored) item.flip = scoreFlip(item);

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

    const page = topUnion(scored);
    attachSparklines(page);
    return { count: scored.length, items: page };
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

  // DESIGN.md §10 item 57: news/Reddit events already linked to this item, via eventItemLinking.ts.
  app.get("/api/items/:id/mentions", async (req) => {
    const { id } = req.params as { id: string };
    const events = getLinkedEventsForItem(Number(id), 10);
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
             s.high, s.low, s.vol_high_5m, s.vol_low_5m, s.vol_high_1h, s.vol_low_1h, s.updated_at,
             s.high_time, s.low_time, i.daily_volume
      FROM items i
      LEFT JOIN latest_snapshot s ON s.item_id = i.id
      WHERE LOWER(i.name) LIKE ?
      ORDER BY i.name
      LIMIT 20
    `,
      )
      .all(needle) as unknown as (ItemRow & { value: number })[];

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
    // startedAt lets the UI tell "the backend restarted" apart from "the network hiccuped". They
    // look identical from a failed fetch and they mean completely different things.
    return {
      itemCount,
      lastUpdate: lastUpdate.t,
      warehouse,
      sidecar,
      nextPricePollAt,
      startedAt: STARTED_AT,
    };
  });
}
