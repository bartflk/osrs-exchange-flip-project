import { db } from "./db.js";
import {
  matchLots,
  summarise,
  type Fill,
  type ItemStats,
  type Pick,
  type PickPerformance,
  type Strategy,
} from "./pickPerformance.js";

// The database half of pickPerformance.ts: read the two tables, hand plain rows to the pure half.
// Kept apart so the arithmetic can be tested without a database; this file is only plumbing.

const fillsStmt = db.prepare(`
  SELECT item_id, type, quantity, price, occurred_at FROM ge_transactions
`);

// Unresolved picks are included. Whether the app's own grading has come in yet is irrelevant to
// whether you followed the call -- that depends only on when it was made and when you bought.
const picksStmt = db.prepare(`
  SELECT item_id, taken_at, resolve_at, strategy, roi_pct FROM recommendation_snapshots
`);

const itemMetaStmt = db.prepare(`SELECT id, name, icon FROM items`);

export interface NamedItemStats extends ItemStats {
  name: string;
  icon: string | null;
}

export interface PickPerformanceResponse extends Omit<PickPerformance, "followedItems"> {
  followedItems: NamedItemStats[];
}

export function computePickPerformance(): PickPerformanceResponse {
  const report = computeRaw();
  const meta = new Map(
    (itemMetaStmt.all() as unknown as { id: number; name: string; icon: string | null }[]).map(
      (r) => [r.id, r],
    ),
  );
  return {
    ...report,
    followedItems: report.followedItems.map((i) => ({
      ...i,
      name: meta.get(i.itemId)?.name ?? `Item ${i.itemId}`,
      icon: meta.get(i.itemId)?.icon ?? null,
    })),
  };
}

function computeRaw(): PickPerformance {
  const fills: Fill[] = (
    fillsStmt.all() as unknown as {
      item_id: number;
      type: string;
      quantity: number;
      price: number;
      occurred_at: number;
    }[]
  )
    // Anything that is neither is not a trade this can price, and passing it through would
    // silently land it on the sell side of the pairing.
    .filter((r) => r.type === "buy" || r.type === "sell")
    .map((r) => ({
      itemId: r.item_id,
      type: r.type as Fill["type"],
      quantity: r.quantity,
      price: r.price,
      occurredAt: r.occurred_at,
    }));

  const picks: Pick[] = (
    picksStmt.all() as unknown as {
      item_id: number;
      taken_at: number;
      resolve_at: number;
      strategy: string | null;
      roi_pct: number;
    }[]
  ).map((r) => ({
    itemId: r.item_id,
    takenAt: r.taken_at,
    resolveAt: r.resolve_at,
    // NULL predates the strategy column, and every such row was a signals call -- the migration
    // that added the column backfilled on exactly that basis (db.ts).
    strategy: (r.strategy === "overnight" ? "overnight" : "signals") as Strategy,
    predictedRoi: r.roi_pct,
  }));

  return summarise(matchLots(fills), picks);
}
