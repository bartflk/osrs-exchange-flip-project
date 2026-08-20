import { db } from "./db.js";
import { getPriceDailyAsOf } from "./warehouse.js";

// DESIGN.md §10 item 45: "rank items by how much a given patch moved their price, before/after."
// The pieces already existed by the time this was picked up -- `events` (official patch notes +
// Reddit, §14.35) has real dated events, and `price_daily` (DuckDB, indefinite retention, unlike
// SQLite's few-day price_history) has the daily closes to diff around any event date. This is
// just the join nothing had made yet.
//
// Deliberately no attempt to classify "is this actually a gameplay update" (a podcast episode and
// a genuine skilling rework both come through as `source: "official"`) -- that needs judgment this
// app doesn't have data to back, and would violate the "never invent data" rule. Every official
// event is selectable; a podcast/charity-stream event will just show near-zero price movement
// across the board, which is itself an honest (if unexciting) result, not a bug to filter away.

const MIN_PRICE = 1000; // same floor as trends.ts -- a few-gp tick swing reads as a huge % move
const MIN_LIQUIDITY = 20; // matches trends.ts / the Market tab's own default filter
const MAX_SANE_PCT = 3.0; // +/-300% -- past this it's a data artifact, not a real move

export interface UpdateSensitivityEntry {
  itemId: number;
  name: string;
  icon: string;
  beforePrice: number;
  afterPrice: number;
  changePct: number;
}

export interface UpdateSensitivityResult {
  eventDate: string;
  beforeDate: string;
  afterDate: string;
  windowDays: number;
  gainers: UpdateSensitivityEntry[];
  losers: UpdateSensitivityEntry[];
  itemsCompared: number;
}

const itemLookupStmt = db.prepare(
  `SELECT i.id, i.name, i.icon, MIN(s.vol_high_1h, s.vol_low_1h) AS liquidity
   FROM items i JOIN latest_snapshot s ON s.item_id = i.id`,
);

function buildItemMap(): Map<number, { name: string; icon: string; liquidity: number }> {
  const rows = itemLookupStmt.all() as unknown as {
    id: number;
    name: string;
    icon: string;
    liquidity: number | null;
  }[];
  return new Map(rows.map((r) => [r.id, { name: r.name, icon: r.icon, liquidity: r.liquidity ?? 0 }]));
}

function addDays(day: string, delta: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

// windowDays on each side -- e.g. windowDays=3 compares the daily close ~3 days before the event
// against the daily close ~3 days after (both "as of" lookups, so a thinly-traded item's nearest
// actual trading day either side is used rather than requiring an exact date match).
export async function computeUpdateSensitivity(
  eventDate: string,
  windowDays = 3,
  limit = 15,
): Promise<UpdateSensitivityResult> {
  const beforeDate = addDays(eventDate, -windowDays);
  const afterDate = addDays(eventDate, windowDays);

  const [beforeRows, afterRows] = await Promise.all([
    getPriceDailyAsOf(beforeDate),
    getPriceDailyAsOf(afterDate),
  ]);
  const beforeMap = new Map(
    beforeRows.filter((r) => r.close_high != null).map((r) => [r.item_id, r.close_high!]),
  );
  const itemMap = buildItemMap();

  const entries: UpdateSensitivityEntry[] = [];
  for (const r of afterRows) {
    if (r.close_high == null) continue;
    const beforePrice = beforeMap.get(r.item_id);
    if (beforePrice == null || beforePrice < MIN_PRICE) continue;
    const item = itemMap.get(r.item_id);
    if (!item || item.liquidity < MIN_LIQUIDITY) continue;
    const changePct = (r.close_high - beforePrice) / beforePrice;
    if (Math.abs(changePct) > MAX_SANE_PCT) continue;
    entries.push({
      itemId: r.item_id,
      name: item.name,
      icon: item.icon,
      beforePrice,
      afterPrice: r.close_high,
      changePct,
    });
  }

  const gainers = [...entries].filter((e) => e.changePct > 0).sort((a, b) => b.changePct - a.changePct).slice(0, limit);
  const losers = [...entries].filter((e) => e.changePct < 0).sort((a, b) => a.changePct - b.changePct).slice(0, limit);

  return { eventDate, beforeDate, afterDate, windowDays, gainers, losers, itemsCompared: entries.length };
}
