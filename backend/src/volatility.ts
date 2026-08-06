import { db } from "./db.js";

// DESIGN.md §8.1: `stability_score` was flagged as "not built yet" -- this closes that gap.
// Coefficient of variation (stddev / mean) of the high price over a trailing window, so it's
// comparable across a 5gp item and a 500m item, unlike raw stddev. Deterministic, no ML: same
// batch-query-into-in-memory-cache shape as alerts.ts's volume-anomaly baseline, refreshed on
// its own poller cadence rather than recomputed per request -- a full price_history scan per
// item on every /api/items call (~4000 items) would be far too slow.
const WINDOW_SECONDS = 24 * 60 * 60;
const MIN_SAMPLES = 10; // don't judge volatility off a handful of ticks

const volatilityCache = new Map<number, number>(); // item_id -> coefficient of variation (>= 0)

const volatilityStmt = db.prepare(`
  SELECT item_id, AVG(high) AS mean_high, AVG(high * high) AS mean_sq
  FROM price_history
  WHERE ts > ? AND high IS NOT NULL
  GROUP BY item_id
  HAVING COUNT(*) >= ?
`);

export function refreshVolatility(): number {
  const cutoff = Math.floor(Date.now() / 1000) - WINDOW_SECONDS;
  const rows = volatilityStmt.all(cutoff, MIN_SAMPLES) as unknown as {
    item_id: number;
    mean_high: number;
    mean_sq: number;
  }[];

  volatilityCache.clear();
  for (const r of rows) {
    if (r.mean_high <= 0) continue;
    const variance = r.mean_sq - r.mean_high * r.mean_high;
    const stddev = Math.sqrt(Math.max(variance, 0));
    volatilityCache.set(r.item_id, stddev / r.mean_high);
  }
  return volatilityCache.size;
}

// null = not enough trailing history to judge yet -- an honest "unknown", not a fake 0 that
// would read as "perfectly stable."
export function getVolatility(itemId: number): number | null {
  return volatilityCache.get(itemId) ?? null;
}
