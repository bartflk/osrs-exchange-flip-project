import { db, getAllGeTransactions, type GeTransaction } from "./db.js";
import { geTax } from "./signals.js";
import { getCaptureStartedAt } from "./geLedger.js";

// DESIGN.md §14.40: turn the raw transaction ledger into the things you actually want to look at
// -- open positions, completed flips, session performance. Every Flipping-Copilot-style screen is
// a view over these three functions.
//
// Pairing is FIFO: the oldest unsold unit is the one considered sold. That's a convention, not a
// fact about the game (the GE doesn't track which specific unit left your inventory), so it's
// stated here rather than buried -- it's the standard choice, and it's what makes "avg buy price"
// on a partially-sold position mean the cost of what you're *still holding* rather than a blended
// average of everything you ever bought.

export type FlipStatus = "BUYING" | "SELLING" | "FINISHED";

export interface Flip {
  itemId: number;
  name: string;
  icon: string | null;
  firstBuyTime: number | null;
  lastSellTime: number | null;
  status: FlipStatus;
  bought: number;
  sold: number;
  avgBuyPrice: number;
  avgSellPrice: number;
  tax: number;
  profit: number;
  profitEach: number;
  roiPct: number | null;
  transactions: GeTransaction[];
}

export interface Position {
  itemId: number;
  name: string;
  icon: string | null;
  quantity: number;
  avgBuyPrice: number;
  costBasis: number;
  marketPrice: number | null;
  marketValue: number | null;
  unrealizedProfit: number | null;
  unrealizedRoiPct: number | null;
}

interface BuyLot {
  quantity: number;
  price: number;
  time: number;
}

// Running totals for the flip currently being accumulated.
interface FlipAccumulator {
  transactions: GeTransaction[];
  bought: number;
  sold: number;
  buyCost: number;
  sellRevenue: number;
  tax: number;
  firstBuyTime: number | null;
  lastSellTime: number | null;
  matchedCost: number;
}

const itemMetaStmt = db.prepare(`SELECT id, name, icon FROM items`);
const latestPricesStmt = db.prepare(
  `SELECT item_id, high, low FROM latest_snapshot WHERE low IS NOT NULL OR high IS NOT NULL`,
);

function itemMeta(): Map<number, { name: string; icon: string | null }> {
  const rows = itemMetaStmt.all() as unknown as { id: number; name: string; icon: string | null }[];
  return new Map(rows.map((r) => [r.id, { name: r.name, icon: r.icon }]));
}

function latestPrices(): Map<number, { high: number | null; low: number | null }> {
  const rows = latestPricesStmt.all() as unknown as {
    item_id: number;
    high: number | null;
    low: number | null;
  }[];
  return new Map(rows.map((r) => [r.item_id, { high: r.high, low: r.low }]));
}

function groupByItem(txs: GeTransaction[]): Map<number, GeTransaction[]> {
  const byItem = new Map<number, GeTransaction[]>();
  for (const t of txs) {
    const list = byItem.get(t.item_id);
    if (list) list.push(t);
    else byItem.set(t.item_id, [t]);
  }
  for (const list of byItem.values()) list.sort((a, b) => a.occurred_at - b.occurred_at);
  return byItem;
}

/**
 * Walk one item's transactions in time order, splitting them into flips.
 *
 * A flip runs from the first buy that opens a position to the moment the position returns to
 * zero. That's what makes "Bought 25,000 / Sold 21,512 / SELLING" a coherent single row rather
 * than 25,000 unrelated events, and it matches how the flip is thought about in practice: one
 * decision, however many partial fills the GE splits it into.
 *
 * Sells with no matching buy (position already zero) are kept as their own FINISHED flip with
 * zero cost basis rather than dropped -- that's what selling something the ledger never saw you
 * buy looks like, and hiding it would silently inflate profit. It's the honest signal that the
 * ledger starts partway through, which is what Missed Flips surfaces.
 */
function flipsForItem(itemId: number, txs: GeTransaction[], meta: Map<number, { name: string; icon: string | null }>): Flip[] {
  const info = meta.get(itemId);
  const flips: Flip[] = [];

  const lots: BuyLot[] = [];
  let current: FlipAccumulator | null = null;

  function newAccumulator(): FlipAccumulator {
    return {
      transactions: [],
      bought: 0,
      sold: 0,
      buyCost: 0,
      sellRevenue: 0,
      tax: 0,
      firstBuyTime: null,
      lastSellTime: null,
      matchedCost: 0,
    };
  }

  // Takes the accumulator as an argument rather than reading the enclosing `current`: assignments
  // made inside a closure are invisible to TypeScript's control-flow analysis, which would then
  // narrow `current` to `null` after the loop and reject the perfectly valid read below.
  function finish(c: FlipAccumulator, status: FlipStatus) {
    // Profit counts only units that actually sold: revenue after tax, minus what those specific
    // units cost. Unsold inventory is a Position, not a profit or a loss, until it moves.
    const profit = c.sellRevenue - c.tax - c.matchedCost;
    flips.push({
      itemId,
      name: info?.name ?? `Item ${itemId}`,
      icon: info?.icon ?? null,
      firstBuyTime: c.firstBuyTime,
      lastSellTime: c.lastSellTime,
      status,
      bought: c.bought,
      sold: c.sold,
      avgBuyPrice: c.bought ? Math.round(c.buyCost / c.bought) : 0,
      avgSellPrice: c.sold ? Math.round(c.sellRevenue / c.sold) : 0,
      tax: c.tax,
      profit,
      profitEach: c.sold ? Math.round(profit / c.sold) : 0,
      roiPct: c.matchedCost > 0 ? profit / c.matchedCost : null,
      transactions: c.transactions,
    });
  }

  for (const t of txs) {
    if (!current) current = newAccumulator();
    const c = current;
    c.transactions.push(t);

    if (t.type === "buy") {
      lots.push({ quantity: t.quantity, price: t.price, time: t.occurred_at });
      c.bought += t.quantity;
      c.buyCost += t.spent;
      if (c.firstBuyTime == null) c.firstBuyTime = t.occurred_at;
      continue;
    }

    // sell
    let remaining = t.quantity;
    while (remaining > 0 && lots.length) {
      const lot = lots[0];
      const take = Math.min(lot.quantity, remaining);
      c.matchedCost += take * lot.price;
      lot.quantity -= take;
      remaining -= take;
      if (lot.quantity === 0) lots.shift();
    }
    // `remaining > 0` means we sold units the ledger never recorded buying. Their cost basis is
    // unknown, so it contributes 0 -- deliberately making the profit look implausibly good rather
    // than inventing a purchase price. Missed Flips is where this gets surfaced.

    c.sold += t.quantity;
    c.sellRevenue += t.spent;
    c.tax += geTax(t.price) * t.quantity;
    c.lastSellTime = t.occurred_at;

    // Position back to zero -- the flip is complete.
    if (!lots.length) {
      finish(c, "FINISHED");
      current = null;
    }
  }

  // Whatever is left open at the end of the ledger is a flip in progress: SELLING once any units
  // have gone, BUYING while still accumulating.
  if (current) finish(current, current.sold > 0 ? "SELLING" : "BUYING");
  return flips;
}

export function computeFlips(): Flip[] {
  const txs = getAllGeTransactions();
  const meta = itemMeta();
  const out: Flip[] = [];
  for (const [itemId, list] of groupByItem(txs)) {
    out.push(...flipsForItem(itemId, list, meta));
  }
  // Newest activity first, matching every other feed in the app.
  return out.sort(
    (a, b) => (b.lastSellTime ?? b.firstBuyTime ?? 0) - (a.lastSellTime ?? a.firstBuyTime ?? 0),
  );
}

/**
 * What you're currently holding, per item: unsold buy lots valued at the price you'd actually
 * realise selling them now.
 *
 * Market value uses `low` (the instant-sell price) rather than `high`, and unrealised profit is
 * net of GE tax. Both are deliberately the pessimistic-but-real choice: `high` is what someone
 * else paid buying instantly, not what you'd get, and tax is unavoidable. This will read slightly
 * lower than Flipping Copilot's equivalent figures, which is the same reasoning that left
 * realizationRatio visible at 0.134 in §14.38 -- the gap between the optimistic number and the
 * real one is the thing worth knowing.
 */
export function computePositions(): Position[] {
  const txs = getAllGeTransactions();
  const meta = itemMeta();
  const prices = latestPrices();
  const out: Position[] = [];

  for (const [itemId, list] of groupByItem(txs)) {
    let lots: BuyLot[] = [];
    for (const t of list) {
      if (t.type === "buy") {
        lots.push({ quantity: t.quantity, price: t.price, time: t.occurred_at });
        continue;
      }
      let remaining = t.quantity;
      while (remaining > 0 && lots.length) {
        const lot = lots[0];
        const take = Math.min(lot.quantity, remaining);
        lot.quantity -= take;
        remaining -= take;
        if (lot.quantity === 0) lots.shift();
      }
    }

    const quantity = lots.reduce((s, l) => s + l.quantity, 0);
    if (quantity <= 0) continue;

    const costBasis = lots.reduce((s, l) => s + l.quantity * l.price, 0);
    const avgBuyPrice = Math.round(costBasis / quantity);
    const price = prices.get(itemId);
    const marketPrice = price?.low ?? price?.high ?? null;
    const info = meta.get(itemId);

    const marketValue = marketPrice != null ? marketPrice * quantity : null;
    const netPerUnit = marketPrice != null ? marketPrice - geTax(marketPrice) - avgBuyPrice : null;

    out.push({
      itemId,
      name: info?.name ?? `Item ${itemId}`,
      icon: info?.icon ?? null,
      quantity,
      avgBuyPrice,
      costBasis,
      marketPrice,
      marketValue,
      unrealizedProfit: netPerUnit != null ? netPerUnit * quantity : null,
      unrealizedRoiPct: netPerUnit != null && costBasis > 0 ? (netPerUnit * quantity) / costBasis : null,
    });
  }

  return out.sort((a, b) => (b.marketValue ?? 0) - (a.marketValue ?? 0));
}

export interface SessionStats {
  since: number;
  realizedProfit: number;
  unrealizedProfit: number;
  flipsFinished: number;
  transactions: number;
  taxPaid: number;
  turnover: number;
  roiPct: number | null;
  gpPerHour: number | null;
  elapsedSeconds: number;
  positionsValue: number;
  captureStartedAt: number | null;
  /** Flips excluded from realizedProfit because their cost basis is unknown. */
  excludedUnmatchedFlips: number;
  /** Sale value of those excluded flips, so the omission is visible rather than silent. */
  excludedUnmatchedRevenue: number;
}

/**
 * Performance since a given instant. Only counts flips that FINISHED inside the window -- a flip
 * that started before it would otherwise credit the session with profit earned earlier.
 *
 * Flips that sold more units than the ledger saw bought are excluded from realised profit
 * entirely. Found live on the first run: three "Uncut diamond" flips showed `bought 0, sold 1082,
 * profit 2.6m` because the buys happened before capture started, and including them turned a
 * ~0 gp/hr session into a reported 147k gp/hr. A cost basis of zero is missing data, not free
 * inventory, and treating it as profit would make every headline number in the app a lie for the
 * first few hours after setup. They're counted and surfaced separately instead, and listed in
 * full under Missed Flips.
 */
export function computeSession(since: number): SessionStats {
  const flips = computeFlips();
  const positions = computePositions();
  const now = Math.floor(Date.now() / 1000);

  const inWindow = flips.filter((f) => (f.lastSellTime ?? 0) >= since);
  const unmatched = inWindow.filter((f) => f.sold > f.bought);
  const accountable = inWindow.filter((f) => f.sold <= f.bought);

  const realizedProfit = accountable.reduce((s, f) => s + f.profit, 0);
  const taxPaid = accountable.reduce((s, f) => s + f.tax, 0);
  const turnover = accountable.reduce((s, f) => s + f.avgBuyPrice * f.sold, 0);
  const transactions = inWindow.reduce(
    (s, f) => s + f.transactions.filter((t) => t.occurred_at >= since).length,
    0,
  );

  const elapsedSeconds = Math.max(1, now - since);
  const positionsValue = positions.reduce((s, p) => s + (p.marketValue ?? 0), 0);
  const unrealizedProfit = positions.reduce((s, p) => s + (p.unrealizedProfit ?? 0), 0);

  return {
    since,
    realizedProfit,
    unrealizedProfit,
    flipsFinished: accountable.filter((f) => f.status === "FINISHED").length,
    transactions,
    taxPaid,
    turnover,
    roiPct: turnover > 0 ? realizedProfit / turnover : null,
    gpPerHour: Math.round((realizedProfit / elapsedSeconds) * 3600),
    elapsedSeconds,
    positionsValue,
    captureStartedAt: getCaptureStartedAt(),
    excludedUnmatchedFlips: unmatched.length,
    excludedUnmatchedRevenue: unmatched.reduce((s, f) => s + f.avgSellPrice * f.sold, 0),
  };
}
