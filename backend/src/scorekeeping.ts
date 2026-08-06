import { db } from "./db.js";
import { scoreItem, geTax, type ItemRow, type ScoredItem } from "./signals.js";

// DESIGN.md §10 item 1: "the single best way to know if the signal engine is actually adding
// value versus noise" -- log the top of the Buy Signals list periodically, then check back after
// a fixed horizon and record whether the flip would actually have been profitable. Deterministic,
// no ML, same philosophy as everything else in this app (§8, §11.3 items 5-6).

const TOP_N = 10; // how many top-scored items to snapshot each logging pass
const HORIZON_SECONDS = 4 * 60 * 60; // resolve 4h later -- matches the buy-limit reset cadence,
// and is long enough for a real flip to plausibly fill and be sold, short enough that "current
// price" is still a fair test of the original call rather than a totally different market.
const RELOG_COOLDOWN_SECONDS = 6 * 60 * 60; // don't log a new snapshot for an item that already
// has an open (unresolved) one from within this window -- otherwise a item sitting at #1 for
// hours would get logged every pass and flood the track record with near-duplicate entries.

interface SnapshotRow {
  item_id: number;
  taken_at: number;
}

const openSnapshotStmt = db.prepare(
  `SELECT item_id, taken_at FROM recommendation_snapshots
   WHERE resolved_at IS NULL AND taken_at > ?`,
);

const insertSnapshotStmt = db.prepare(`
  INSERT INTO recommendation_snapshots
    (item_id, name, icon, taken_at, rank, score, buy_price, sell_price, net_margin, roi_pct, resolve_at)
  VALUES (@item_id, @name, @icon, @taken_at, @rank, @score, @buy_price, @sell_price, @net_margin, @roi_pct, @resolve_at)
`);

// Reads the same scored/joined view /api/items builds, kept independent of the route so this
// job doesn't depend on an HTTP round-trip to itself.
const scoredItemsStmt = db.prepare(`
  SELECT i.id, i.name, i.members, i.buy_limit, i.icon,
         s.high, s.low, s.vol_high_5m, s.vol_low_5m, s.vol_high_1h, s.vol_low_1h, s.updated_at
  FROM items i
  JOIN latest_snapshot s ON s.item_id = i.id
  WHERE s.high IS NOT NULL AND s.low IS NOT NULL
`);

export function logRecommendationSnapshots(): number {
  const rows = scoredItemsStmt.all() as unknown as ItemRow[];
  const scored: ScoredItem[] = rows
    .map(scoreItem)
    .filter((r) => r.net_margin != null && r.liquidity >= 20) // same floor as the Market tab's
    // default min-liquidity filter -- no point tracking a call no one could actually fill.
    .sort((a, b) => b.score - a.score)
    .slice(0, TOP_N);

  const now = Math.floor(Date.now() / 1000);
  const cooldownCutoff = now - RELOG_COOLDOWN_SECONDS;
  const openItemIds = new Set(
    (openSnapshotStmt.all(cooldownCutoff) as unknown as SnapshotRow[]).map((r) => r.item_id),
  );

  let logged = 0;
  scored.forEach((item, idx) => {
    if (openItemIds.has(item.id)) return;
    insertSnapshotStmt.run({
      item_id: item.id,
      name: item.name,
      icon: item.icon,
      taken_at: now,
      rank: idx + 1,
      score: item.score,
      buy_price: item.low,
      sell_price: item.high,
      net_margin: item.net_margin,
      roi_pct: item.roi_pct,
      resolve_at: now + HORIZON_SECONDS,
    });
    logged++;
  });
  return logged;
}

interface PendingRow {
  id: number;
  item_id: number;
  buy_price: number;
}

const pendingStmt = db.prepare(
  `SELECT id, item_id, buy_price FROM recommendation_snapshots WHERE resolved_at IS NULL AND resolve_at <= ?`,
);
const latestPriceStmt = db.prepare(`SELECT high, low FROM latest_snapshot WHERE item_id = ?`);
const resolveStmt = db.prepare(`
  UPDATE recommendation_snapshots
  SET resolved_at = @resolved_at, resolved_high = @resolved_high, resolved_low = @resolved_low,
      realized_net_margin = @realized_net_margin, realized_roi_pct = @realized_roi_pct, outcome = @outcome
  WHERE id = @id
`);

export function resolveRecommendationSnapshots(): number {
  const now = Math.floor(Date.now() / 1000);
  const pending = pendingStmt.all(now) as unknown as PendingRow[];
  let resolved = 0;

  for (const snap of pending) {
    const latest = latestPriceStmt.get(snap.item_id) as
      | { high: number | null; low: number | null }
      | undefined;
    if (!latest || latest.high == null || latest.low == null) continue; // no current price -- try again next pass

    // Realized outcome: you bought at the snapshot's buy_price (the low at the time), so what
    // matters now is what you'd get selling into the CURRENT high, taxed at the current rate --
    // not the original planned sell_price, which may no longer be reachable.
    const realizedNetMargin = latest.high - snap.buy_price - geTax(latest.high);
    const realizedRoiPct = snap.buy_price > 0 ? realizedNetMargin / snap.buy_price : 0;
    const outcome = realizedNetMargin > 0 ? "win" : realizedNetMargin < 0 ? "loss" : "flat";

    resolveStmt.run({
      id: snap.id,
      resolved_at: now,
      resolved_high: latest.high,
      resolved_low: latest.low,
      realized_net_margin: realizedNetMargin,
      realized_roi_pct: realizedRoiPct,
      outcome,
    });
    resolved++;
  }
  return resolved;
}

export interface TrackRecordEntry {
  id: number;
  itemId: number;
  name: string;
  icon: string;
  takenAt: number;
  rank: number;
  score: number;
  buyPrice: number;
  sellPrice: number;
  netMargin: number;
  roiPct: number;
  resolveAt: number;
  resolvedAt: number | null;
  resolvedHigh: number | null;
  realizedNetMargin: number | null;
  realizedRoiPct: number | null;
  outcome: "win" | "loss" | "flat" | null;
}

const recentStmt = db.prepare(`
  SELECT id, item_id, name, icon, taken_at, rank, score, buy_price, sell_price, net_margin, roi_pct,
         resolve_at, resolved_at, resolved_high, realized_net_margin, realized_roi_pct, outcome
  FROM recommendation_snapshots
  ORDER BY taken_at DESC
  LIMIT 50
`);
const summaryStmt = db.prepare(`
  SELECT COUNT(*) AS total,
         SUM(CASE WHEN outcome = 'win' THEN 1 ELSE 0 END) AS wins,
         SUM(CASE WHEN outcome = 'loss' THEN 1 ELSE 0 END) AS losses,
         AVG(realized_net_margin) AS avg_net_margin,
         AVG(realized_roi_pct) AS avg_roi_pct
  FROM recommendation_snapshots
  WHERE resolved_at IS NOT NULL
`);

export interface TrackRecordSummary {
  resolvedCount: number;
  pendingCount: number;
  wins: number;
  losses: number;
  winRate: number | null;
  avgNetMargin: number | null;
  avgRoiPct: number | null;
}

// DESIGN.md §14.12: per-item slice of the same track record, for the item detail modal --
// "has this specific item's recommendation actually panned out historically," not just the
// catalogue-wide summary. Grounded in real resolved outcomes (recommendation_snapshots), unlike
// a competitor's unexplained "Success Rate" badge -- most items simply won't have any history
// yet, and that's surfaced honestly (null) rather than faked.
export interface ItemTrackRecord {
  resolvedCount: number;
  wins: number;
  losses: number;
  winRate: number | null;
  avgRealizedNetMargin: number | null;
}

const itemSummaryStmt = db.prepare(`
  SELECT COUNT(*) AS total,
         SUM(CASE WHEN outcome = 'win' THEN 1 ELSE 0 END) AS wins,
         SUM(CASE WHEN outcome = 'loss' THEN 1 ELSE 0 END) AS losses,
         AVG(realized_net_margin) AS avg_net_margin
  FROM recommendation_snapshots
  WHERE resolved_at IS NOT NULL AND item_id = ?
`);

export function getItemTrackRecord(itemId: number): ItemTrackRecord {
  const row = itemSummaryStmt.get(itemId) as {
    total: number;
    wins: number | null;
    losses: number | null;
    avg_net_margin: number | null;
  };
  return {
    resolvedCount: row.total,
    wins: row.wins ?? 0,
    losses: row.losses ?? 0,
    winRate: row.total > 0 ? (row.wins ?? 0) / row.total : null,
    avgRealizedNetMargin: row.avg_net_margin,
  };
}

export function getTrackRecord(): { summary: TrackRecordSummary; recent: TrackRecordEntry[] } {
  const row = summaryStmt.get() as {
    total: number;
    wins: number | null;
    losses: number | null;
    avg_net_margin: number | null;
    avg_roi_pct: number | null;
  };
  const pendingRow = db
    .prepare(`SELECT COUNT(*) AS c FROM recommendation_snapshots WHERE resolved_at IS NULL`)
    .get() as { c: number };

  const rows = recentStmt.all() as unknown as {
    id: number;
    item_id: number;
    name: string;
    icon: string;
    taken_at: number;
    rank: number;
    score: number;
    buy_price: number;
    sell_price: number;
    net_margin: number;
    roi_pct: number;
    resolve_at: number;
    resolved_at: number | null;
    resolved_high: number | null;
    realized_net_margin: number | null;
    realized_roi_pct: number | null;
    outcome: "win" | "loss" | "flat" | null;
  }[];

  return {
    summary: {
      resolvedCount: row.total,
      pendingCount: pendingRow.c,
      wins: row.wins ?? 0,
      losses: row.losses ?? 0,
      winRate: row.total > 0 ? (row.wins ?? 0) / row.total : null,
      avgNetMargin: row.avg_net_margin,
      avgRoiPct: row.avg_roi_pct,
    },
    recent: rows.map((r) => ({
      id: r.id,
      itemId: r.item_id,
      name: r.name,
      icon: r.icon,
      takenAt: r.taken_at,
      rank: r.rank,
      score: r.score,
      buyPrice: r.buy_price,
      sellPrice: r.sell_price,
      netMargin: r.net_margin,
      roiPct: r.roi_pct,
      resolveAt: r.resolve_at,
      resolvedAt: r.resolved_at,
      resolvedHigh: r.resolved_high,
      realizedNetMargin: r.realized_net_margin,
      realizedRoiPct: r.realized_roi_pct,
      outcome: r.outcome,
    })),
  };
}
