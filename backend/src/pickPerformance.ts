// Did the app's picks make YOU money?
//
// Two tables have been sitting side by side answering half the question each. recommendation_
// snapshots records what the app told you to buy, and scorekeeping grades those calls against
// where the market went next. ge_transactions records what you actually bought and sold. Nothing
// joined them, so the app could say "63% of my calls were right" but never "the trades you took
// on my advice returned X, and the ones you took on your own returned Y". Only the second sentence
// is about money you actually made.
//
// Pure functions of plain rows, no database, so the parts most likely to be quietly wrong -- the
// buy/sell pairing and the attribution -- can be pinned by tests. pickPerformanceRoute feeds these
// from the database; pickPerformance.test.ts feeds them by hand.
//
// What this does NOT claim. "Followed" versus "independent" is not an experiment: you chose which
// picks to take, and presumably took the ones that looked best. So a higher return on followed
// trades means the picks you acted on did well, not that the app caused it. The comparison is
// reported as what it is, and the UI says so.

/** GE tax: 2% of the sale, rounded down, capped at 5m, waived when it would round to 0. */
export function geTax(sellPrice: number): number {
  const tax = Math.floor(sellPrice * 0.02);
  if (tax === 0) return 0;
  return Math.min(tax, 5_000_000);
}
// Duplicated from signals.ts rather than imported, and deliberately: signals.ts pulls in the
// database at module load, and the whole point of this file is that it can be tested without one.
// The rule is four lines and fixed by the game, and pickPerformance.test.ts pins it against the
// same cases, so the two copies cannot drift apart silently.

export interface Fill {
  itemId: number;
  type: "buy" | "sell";
  quantity: number;
  /** gp per unit actually paid or received. */
  price: number;
  /** unix seconds */
  occurredAt: number;
}

export type Strategy = "signals" | "overnight";

export interface Pick {
  itemId: number;
  /** When the app made the call. */
  takenAt: number;
  /**
   * When the app's own horizon on the call ran out. Used as the end of the window in which a buy
   * counts as having followed it -- the app's definition of how long its advice is good for,
   * rather than a window invented here. Signals calls are 4h; overnight calls are 0.5-8h.
   */
  resolveAt: number;
  strategy: Strategy;
  /** Predicted return, as a fraction: 0.03 is 3%. */
  predictedRoi: number;
}

/**
 * Units that went out at one sell price having come in at one buy price.
 *
 * The unit of account is a chunk, not a fill, because the two sides do not line up: one sell can
 * consume units from three different buys, bought at three different times -- and possibly only
 * some of them on the app's advice. Attribution has to happen per chunk or it cannot be right.
 */
export interface Lot {
  itemId: number;
  quantity: number;
  buyPrice: number;
  sellPrice: number;
  buyTime: number;
  sellTime: number;
  /** What these units cost. */
  cost: number;
  /** Sale revenue, less GE tax, less cost. */
  profit: number;
  /** The pick this lot's buy followed, or null if you bought it on your own. */
  pick: Pick | null;
}

export interface MatchResult {
  lots: Lot[];
  /**
   * Units sold with no recorded buy -- the ledger starts partway through your history. Excluded,
   * not zero-costed, and that is a deliberate break from flips.ts. There, a sale with no known cost
   * is kept at zero cost and surfaced as a Missed Flip, which is right for a list of your trades.
   * Here it would be poison: zero-cost units count as pure profit, so whichever side of the
   * comparison happened to hold more pre-ledger stock would look better for reasons unrelated to
   * the app. A comparison can only use units whose cost is actually known.
   */
  unmatchedSellUnits: number;
  /** Bought and not yet sold. No profit or loss until it moves. */
  openUnits: number;
  openCost: number;
}

/**
 * Pair sells with buys, oldest unit first.
 *
 * Same convention as flips.ts, on purpose -- FIFO, grouped by item across accounts -- so that a
 * profit figure here reconciles with the Flips tab rather than quietly disagreeing with it. Grouping
 * across accounts is not a shortcut: the ledger carries one player under two identifiers (a display
 * name from the Flipping Utilities backfill, then a RuneLite account hash from slot capture), in
 * consecutive, non-overlapping periods. Splitting by identifier would strand buys from the first
 * period away from the sells in the second.
 */
export function matchLots(fills: Fill[]): MatchResult {
  const byItem = new Map<number, Fill[]>();
  for (const f of fills) {
    const list = byItem.get(f.itemId);
    if (list) list.push(f);
    else byItem.set(f.itemId, [f]);
  }

  const lots: Lot[] = [];
  let unmatchedSellUnits = 0;
  let openUnits = 0;
  let openCost = 0;

  for (const [itemId, list] of byItem) {
    // Buys before sells within the same second. Two fills stamped identically are the same moment
    // to the ledger, and ordering the buy first is the only reading in which the sell has anything
    // to sell -- otherwise an instant flip would count as an unmatched sale plus an open position.
    list.sort((a, b) => a.occurredAt - b.occurredAt || (a.type === "buy" ? -1 : 1));

    const queue: { quantity: number; price: number; time: number }[] = [];

    for (const f of list) {
      if (f.type === "buy") {
        queue.push({ quantity: f.quantity, price: f.price, time: f.occurredAt });
        continue;
      }

      let remaining = f.quantity;
      // Tax is charged per unit sold, on the sell price. Computed once per fill since every unit in
      // it shared that price.
      const taxEach = geTax(f.price);
      while (remaining > 0 && queue.length) {
        const head = queue[0];
        const take = Math.min(head.quantity, remaining);
        const cost = take * head.price;
        lots.push({
          itemId,
          quantity: take,
          buyPrice: head.price,
          sellPrice: f.price,
          buyTime: head.time,
          sellTime: f.occurredAt,
          cost,
          profit: take * (f.price - taxEach) - cost,
          pick: null,
        });
        head.quantity -= take;
        remaining -= take;
        if (head.quantity === 0) queue.shift();
      }
      unmatchedSellUnits += remaining;
    }

    for (const lot of queue) {
      openUnits += lot.quantity;
      openCost += lot.quantity * lot.price;
    }
  }

  return { lots, unmatchedSellUnits, openUnits, openCost };
}

/**
 * Mark each lot with the pick its buy followed, if any.
 *
 * A buy followed a pick when it happened while that pick was live -- after the app made the call
 * and before the call's own horizon ran out. Where several were live at once (the same item called
 * on consecutive half-hourly runs is common) the most recent wins, since that is the call you were
 * looking at when you bought.
 *
 * Matching is on item and time only, not price. Requiring the buy to land near the pick's quoted
 * price sounds stricter but would exclude exactly the trades worth studying: a buy that followed
 * the call but paid over the quote is a following trade with bad execution, and that is part of
 * what this is meant to measure, not noise to be filtered out of it.
 */
export function attribute(lots: Lot[], picks: Pick[]): Lot[] {
  const byItem = new Map<number, Pick[]>();
  for (const p of picks) {
    const list = byItem.get(p.itemId);
    if (list) list.push(p);
    else byItem.set(p.itemId, [p]);
  }
  for (const list of byItem.values()) list.sort((a, b) => a.takenAt - b.takenAt);

  return lots.map((lot) => {
    const candidates = byItem.get(lot.itemId);
    let pick: Pick | null = null;
    if (candidates) {
      for (const p of candidates) {
        if (p.takenAt > lot.buyTime) break; // sorted: nothing later can have been live yet
        if (lot.buyTime <= p.resolveAt) pick = p; // keep going: a later live pick supersedes
      }
    }
    return { ...lot, pick };
  });
}

export interface GroupStats {
  /** Matched chunks. Shown for transparency, not as a trade count -- see capitalWinRate. */
  lots: number;
  items: number;
  units: number;
  cost: number;
  profit: number;
  /** profit / cost. The headline number, and the only one comparable across groups of any size. */
  roi: number | null;
  /**
   * Share of CAPITAL that ended up in profitable lots, not share of lots.
   *
   * A count-based win rate would be meaningless here. One GE offer arrives as a string of partial
   * fills, and FIFO slices those further, so a single decision can become forty lots -- the count
   * mostly measures how the GE happened to split the order. Weighting by cost makes the figure
   * immune to that: however an offer is chunked, its gp is counted once.
   */
  capitalWinRate: number | null;
}

function stats(lots: Lot[]): GroupStats {
  let cost = 0;
  let profit = 0;
  let units = 0;
  let winningCost = 0;
  const items = new Set<number>();
  for (const l of lots) {
    cost += l.cost;
    profit += l.profit;
    units += l.quantity;
    if (l.profit > 0) winningCost += l.cost;
    items.add(l.itemId);
  }
  return {
    lots: lots.length,
    items: items.size,
    units,
    cost,
    profit,
    roi: cost > 0 ? profit / cost : null,
    capitalWinRate: cost > 0 ? winningCost / cost : null,
  };
}

// A predicted return above this is a glitch, not a forecast, and is left out of the average.
// Same bound and same reasoning as alerts.ts's MAX_SANE_PCT: a genuine GE move essentially never
// clears 300%, so anything past it is a near-zero price acting as the denominator. The stored
// recommendations include one signals call "predicting" a 13,430% return, which on its own would
// have set the predicted-return figure for any group it landed in.
export const MAX_SANE_PREDICTED_ROI = 3.0;

export interface ExecutionGap {
  /** Cost-weighted return the app predicted on the picks you followed. */
  predictedRoi: number | null;
  /** Cost-weighted return you actually realised on those same lots. */
  realizedRoi: number | null;
  /** Lots included -- followed lots whose prediction passed the sanity bound. */
  lots: number;
  /** Followed lots left out because their prediction was a glitch. */
  excludedGlitches: number;
}

/**
 * What the app said the picks you took were worth, against what you actually got out of them.
 *
 * Both sides are weighted by YOUR cost, not the pick's, so a call you put 200m behind counts for
 * more than one you tried with 2m. That makes it answer the useful question -- how much of the
 * promised edge reached your bank on the money you actually committed.
 */
function executionGap(followed: Lot[]): ExecutionGap {
  let weight = 0;
  let predicted = 0;
  let realizedProfit = 0;
  let included = 0;
  let excludedGlitches = 0;
  for (const l of followed) {
    const p = l.pick!;
    if (!Number.isFinite(p.predictedRoi) || Math.abs(p.predictedRoi) > MAX_SANE_PREDICTED_ROI) {
      excludedGlitches++;
      continue;
    }
    weight += l.cost;
    predicted += p.predictedRoi * l.cost;
    realizedProfit += l.profit;
    included++;
  }
  return {
    predictedRoi: weight > 0 ? predicted / weight : null,
    realizedRoi: weight > 0 ? realizedProfit / weight : null,
    lots: included,
    excludedGlitches,
  };
}

/** One item's followed trades, rolled up. */
export interface ItemStats {
  itemId: number;
  cost: number;
  profit: number;
  roi: number | null;
}

/**
 * Which picks the headline is made of.
 *
 * Added because the headline on its own invites the wrong conclusion. A group return is an
 * average, and an average of fourteen positions can be one disaster or fourteen mediocre trades,
 * which are different problems with different fixes. On the real ledger it turned out to be the
 * second -- the followed trades were consistently thin rather than dragged down by one loser --
 * and that is only visible item by item.
 *
 * Largest capital first, because that is what the headline is weighted by: the rows at the top
 * are the ones actually moving it.
 */
function itemBreakdown(lots: Lot[]): ItemStats[] {
  const byItem = new Map<number, { cost: number; profit: number }>();
  for (const l of lots) {
    const e = byItem.get(l.itemId);
    if (e) {
      e.cost += l.cost;
      e.profit += l.profit;
    } else byItem.set(l.itemId, { cost: l.cost, profit: l.profit });
  }
  return [...byItem.entries()]
    .map(([itemId, e]) => ({
      itemId,
      cost: e.cost,
      profit: e.profit,
      roi: e.cost > 0 ? e.profit / e.cost : null,
    }))
    .sort((a, b) => b.cost - a.cost);
}

export interface PickPerformance {
  followed: GroupStats;
  independent: GroupStats;
  byStrategy: Record<Strategy, GroupStats>;
  execution: ExecutionGap;
  followedItems: ItemStats[];
  excluded: { unmatchedSellUnits: number; openUnits: number; openCost: number };
  /** Span of the matched lots, by sell time. */
  range: { from: number | null; to: number | null };
}

export function summarise(match: MatchResult, picks: Pick[]): PickPerformance {
  const lots = attribute(match.lots, picks);
  const followed = lots.filter((l) => l.pick != null);
  const independent = lots.filter((l) => l.pick == null);

  let from: number | null = null;
  let to: number | null = null;
  for (const l of lots) {
    if (from == null || l.sellTime < from) from = l.sellTime;
    if (to == null || l.sellTime > to) to = l.sellTime;
  }

  return {
    followed: stats(followed),
    independent: stats(independent),
    byStrategy: {
      signals: stats(followed.filter((l) => l.pick!.strategy === "signals")),
      overnight: stats(followed.filter((l) => l.pick!.strategy === "overnight")),
    },
    execution: executionGap(followed),
    followedItems: itemBreakdown(followed),
    excluded: {
      unmatchedSellUnits: match.unmatchedSellUnits,
      openUnits: match.openUnits,
      openCost: match.openCost,
    },
    range: { from, to },
  };
}
