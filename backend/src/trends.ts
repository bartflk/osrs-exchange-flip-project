import { db } from "./db.js";
import { getPriceDailyAsOf } from "./warehouse.js";

// DESIGN.md §10 item 9: multi-window trend leaderboards -- a browsable ranked view of biggest
// movers, distinct from alerts.ts's event-triggered crash/spike detector (fires once per
// crossing). This is checkable any time, not waiting for a threshold to trip.
export type TrendWindow = "1h" | "4h" | "12h" | "24h" | "7d" | "30d";

const SHORT_WINDOW_SECONDS: Record<string, number> = {
  "1h": 3600,
  "4h": 4 * 3600,
  "12h": 12 * 3600,
  "24h": 24 * 3600,
};

export interface TrendEntry {
  itemId: number;
  name: string;
  icon: string;
  fromPrice: number;
  toPrice: number;
  changePct: number;
}

// Same guards as alerts.ts, same reasons: a raw % change with no floor lets a single
// stale/glitched tick on a thin item dominate the leaderboard (found live: "Hosidius banner"
// read as a +9,634% mover off one bad historical tick before these were added).
const MIN_PRICE = 1000;
const MIN_LIQUIDITY = 20; // matches alerts.ts / the Market tab's own default min-liquidity filter
const MAX_SANE_PCT = 3.0; // ±300% -- past this it's a data artifact, not a real GE move

const itemLookupStmt = db.prepare(`SELECT id, name, icon FROM items`);

function buildItemMap(): Map<number, { name: string; icon: string }> {
  const rows = itemLookupStmt.all() as unknown as { id: number; name: string; icon: string }[];
  return new Map(rows.map((r) => [r.id, { name: r.name, icon: r.icon }]));
}

// 1h/4h/12h/24h: price_history (SQLite) retains RAW_RETENTION_DAYS (3) of raw ticks, comfortably
// covering all four short windows. "As-of" join: the most recent tick at or before the cutoff,
// per item, compared against the current live price.
function computeShortTrend(window: "1h" | "4h" | "12h" | "24h"): TrendEntry[] {
  const cutoff = Math.floor(Date.now() / 1000) - SHORT_WINDOW_SECONDS[window];
  const rows = db
    .prepare(
      `
    SELECT ph.item_id AS item_id, ph.high AS from_high, s.high AS to_high,
           MIN(s.vol_high_1h, s.vol_low_1h) AS liquidity
    FROM price_history ph
    JOIN (
      SELECT item_id, MAX(ts) AS max_ts FROM price_history WHERE ts <= ? GROUP BY item_id
    ) latest ON ph.item_id = latest.item_id AND ph.ts = latest.max_ts
    JOIN latest_snapshot s ON s.item_id = ph.item_id
    WHERE ph.high IS NOT NULL AND s.high IS NOT NULL
  `,
    )
    .all(cutoff) as unknown as {
    item_id: number;
    from_high: number;
    to_high: number;
    liquidity: number;
  }[];

  const itemMap = buildItemMap();
  return buildEntries(rows, itemMap);
}

// 7d/30d: raw ticks are long gone by then -- use the DuckDB daily rollup instead (warehouse.ts).
async function computeLongTrend(window: "7d" | "30d"): Promise<TrendEntry[]> {
  const days = window === "7d" ? 7 : 30;
  const cutoffDate = new Date(Date.now() - days * 86400 * 1000).toISOString().slice(0, 10);
  const dailyRows = await getPriceDailyAsOf(cutoffDate);

  const currentRows = db
    .prepare(
      `SELECT item_id, high, MIN(vol_high_1h, vol_low_1h) AS liquidity FROM latest_snapshot WHERE high IS NOT NULL`,
    )
    .all() as unknown as { item_id: number; high: number; liquidity: number }[];
  const currentMap = new Map(currentRows.map((r) => [r.item_id, r]));

  const rows = dailyRows
    .filter((d) => d.close_high != null && currentMap.has(d.item_id))
    .map((d) => {
      const cur = currentMap.get(d.item_id)!;
      return {
        item_id: d.item_id,
        from_high: d.close_high!,
        to_high: cur.high,
        liquidity: cur.liquidity,
      };
    });

  const itemMap = buildItemMap();
  return buildEntries(rows, itemMap);
}

function buildEntries(
  rows: { item_id: number; from_high: number; to_high: number; liquidity: number }[],
  itemMap: Map<number, { name: string; icon: string }>,
): TrendEntry[] {
  const entries: TrendEntry[] = [];
  for (const r of rows) {
    if (r.from_high < MIN_PRICE || r.from_high <= 0) continue;
    if (r.liquidity < MIN_LIQUIDITY) continue;
    const changePct = (r.to_high - r.from_high) / r.from_high;
    if (Math.abs(changePct) > MAX_SANE_PCT) continue;
    const item = itemMap.get(r.item_id);
    if (!item) continue;
    entries.push({
      itemId: r.item_id,
      name: item.name,
      icon: item.icon,
      fromPrice: r.from_high,
      toPrice: r.to_high,
      changePct,
    });
  }
  return entries;
}

export async function computeTrend(window: TrendWindow): Promise<TrendEntry[]> {
  const entries =
    window === "7d" || window === "30d"
      ? await computeLongTrend(window)
      : computeShortTrend(window);
  entries.sort((a, b) => Math.abs(b.changePct) - Math.abs(a.changePct));
  return entries.slice(0, 50);
}
