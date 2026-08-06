import { db } from "./db.js";
import { geTax } from "./signals.js";

// DESIGN.md §14.22: the existing track record (scorekeeping.ts) only ever answers "how did the
// fixed 4h horizon go" -- this answers "how would the SAME picks have gone at 2/3/6/12/24h,"
// a genuine multi-horizon backtest. Reuses every snapshot already logged by
// logRecommendationSnapshots() rather than adding a second logging path: each snapshot already
// records (item, taken_at, buy_price), so any hold period can be backtested against it purely by
// looking up the item's real historical price at taken_at+horizon, no new writes needed.
export const HORIZON_HOURS = [2, 3, 6, 12, 24] as const;

const MAX_SNAPSHOTS = 500; // bounded sample so this stays fast as recommendation_snapshots grows

interface SnapshotForHorizon {
  item_id: number;
  taken_at: number;
  buy_price: number;
}

const snapshotsStmt = db.prepare(
  `SELECT item_id, taken_at, buy_price FROM recommendation_snapshots ORDER BY taken_at DESC LIMIT ?`,
);

// Most recent tick at or before the target time -- same "as-of" pattern as trends.ts and
// substitutions.ts. Correctly returns nothing (not a stale/wrong-era match) once the target
// falls before price_history's retention cutoff, since pruning deletes a contiguous range
// rather than leaving gaps -- see rollup.ts's RAW_RETENTION_DAYS.
const asOfPriceStmt = db.prepare(
  `SELECT high FROM price_history WHERE item_id = ? AND ts <= ? ORDER BY ts DESC LIMIT 1`,
);

export interface HorizonResult {
  hours: number;
  resolvedCount: number; // horizon has arrived and we have a real price to check against
  pendingCount: number; // horizon hasn't arrived yet for this snapshot
  noDataCount: number; // horizon arrived, but no price_history that far back (pruned/too old)
  wins: number;
  losses: number;
  winRate: number | null;
  avgNetMargin: number | null;
  avgRoiPct: number | null;
}

export function computeHorizonTrackRecord(): HorizonResult[] {
  const snapshots = snapshotsStmt.all(MAX_SNAPSHOTS) as unknown as SnapshotForHorizon[];
  const now = Math.floor(Date.now() / 1000);

  return HORIZON_HOURS.map((hours) => {
    const horizonSeconds = hours * 3600;
    let resolvedCount = 0;
    let pendingCount = 0;
    let noDataCount = 0;
    let wins = 0;
    let losses = 0;
    let sumMargin = 0;
    let sumRoi = 0;

    for (const snap of snapshots) {
      const targetTs = snap.taken_at + horizonSeconds;
      if (targetTs > now) {
        pendingCount++;
        continue;
      }
      const priceRow = asOfPriceStmt.get(snap.item_id, targetTs) as
        | { high: number | null }
        | undefined;
      if (!priceRow || priceRow.high == null) {
        noDataCount++;
        continue;
      }

      const price = priceRow.high;
      const netMargin = price - snap.buy_price - geTax(price);
      const roiPct = snap.buy_price > 0 ? netMargin / snap.buy_price : 0;
      resolvedCount++;
      sumMargin += netMargin;
      sumRoi += roiPct;
      if (netMargin > 0) wins++;
      else if (netMargin < 0) losses++;
    }

    return {
      hours,
      resolvedCount,
      pendingCount,
      noDataCount,
      wins,
      losses,
      winRate: resolvedCount > 0 ? wins / resolvedCount : null,
      avgNetMargin: resolvedCount > 0 ? sumMargin / resolvedCount : null,
      avgRoiPct: resolvedCount > 0 ? sumRoi / resolvedCount : null,
    };
  });
}
