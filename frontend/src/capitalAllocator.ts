import type { MarketItem } from "./api";

// DESIGN.md §11.3 item 7: capital allocation across GE slots. Runeberg Terminal's actual shipped
// "Capital Allocator" tool validated this framing over a Markowitz-style optimizer (which assumes
// short-selling/continuous rebalancing, neither of which maps to buy-only slots with hard
// quantity limits) -- a greedy/knapsack allocator: rank by score, fill slots one at a time,
// respect a per-item allocation cap so one item can't eat the whole bankroll.
export interface SlotAssignment {
  slot: number;
  item: MarketItem;
  qty: number;
  cost: number;
  projectedProfit: number;
}

export interface AllocationResult {
  assignments: SlotAssignment[];
  totalCost: number;
  totalProfit: number;
  remainingBankroll: number;
}

export function allocateCapital(
  items: MarketItem[],
  opts: {
    bankroll: number;
    numSlots: number;
    maxAllocationPct: number;
    // DESIGN.md §10 item 21 / §14.23: a timeframe changes which items even QUALIFY, not just
    // how they're sized -- a short hold needs liquidity high enough to actually fill and resell
    // in that window; a long hold can tolerate a thinner book in exchange for wider margin. Kept
    // as a simple pre-filter (not a re-weighted score) so the allocator stays explainable: every
    // candidate still ranks by the same score as everywhere else in the app.
    minLiquidity?: number;
    // DESIGN.md §14.23: "reroll" -- cycle to the next batch of qualifying candidates instead of
    // always the same top-N, without resorting to randomness (stays deterministic/explainable).
    // Rotates the sorted candidate list by `skipCount` positions, wrapping around.
    skipCount?: number;
    // Items already occupying a real GE slot (a tracked/open offer) shouldn't also be suggested
    // for one of the *remaining* slots -- that would double-count the same item against two
    // slots at once. Matched case-insensitively by name, same key GeOffersPanel/offers.ts uses.
    excludeNames?: Set<string>;
    // DESIGN.md §14.41: units of each item already bought inside the current 4h GE limit window,
    // keyed by item id. Without this the allocator sizes against the catalogue buy limit and
    // suggests quantities the GE will simply refuse -- e.g. 11,000 Diamond when 9,360 of that
    // limit is already spent. Absent id = nothing bought recently = full limit available.
    remainingLimits?: Map<number, number>;
    // Direct request: "I want it to put all my money to work... its not adding it up to total."
    // A large bankroll over few slots often can't be spent on pure score alone -- the #1-ranked
    // item might have a buy limit that caps its own spend at a few million, while the bankroll is
    // hundreds of millions. When true, candidates are ranked by score AND how much of their fair
    // share (bankroll / numSlots) they can actually absorb, so slots go to items that use real
    // money rather than always the single highest-edge pick regardless of how little it can hold.
    // Off by default -- existing callers (Buy Signals) keep their exact current ranking.
    maximizeUtilization?: boolean;
  },
): AllocationResult {
  const maxPerItem = opts.bankroll * (opts.maxAllocationPct / 100);
  const minLiquidity = opts.minLiquidity ?? 0;
  let candidates = [...items].filter(
    (i) =>
      (i.net_margin ?? 0) > 0 &&
      i.low &&
      i.liquidity >= minLiquidity &&
      !opts.excludeNames?.has(i.name.toLowerCase()),
  );

  if (opts.maximizeUtilization && opts.numSlots > 0) {
    const fairShare = opts.bankroll / opts.numSlots;
    const capacityOf = (i: MarketItem) => {
      const limit = Math.min(i.buy_limit ?? Infinity, opts.remainingLimits?.get(i.id) ?? Infinity);
      return Math.min(maxPerItem, limit * i.low!);
    };
    // Items that can already fill their fair share keep full score weight; items that can only
    // absorb a sliver of it are discounted proportionally, so a tiny-buy-limit item ranked #1 by
    // score doesn't automatically claim a slot a bigger-capacity item could have filled instead.
    candidates = candidates
      .map((i) => ({ i, rank: i.score * (0.4 + 0.6 * Math.min(1, capacityOf(i) / fairShare)) }))
      .sort((a, b) => b.rank - a.rank)
      .map((x) => x.i);
  } else {
    candidates.sort((a, b) => b.score - a.score);
  }

  if (opts.skipCount && candidates.length > 0) {
    const skip = opts.skipCount % candidates.length;
    candidates = [...candidates.slice(skip), ...candidates.slice(0, skip)];
  }

  const assignments: SlotAssignment[] = [];
  let remaining = opts.bankroll;

  for (const item of candidates) {
    if (assignments.length >= opts.numSlots) break;
    if (!item.low) continue;
    const capForItem = Math.min(maxPerItem, remaining);
    const affordableQty = Math.floor(capForItem / item.low);
    // Cap by whichever limit is actually binding: the catalogue buy limit, or what's left of it
    // in the current 4h window once recent purchases are netted off.
    const limitFromLedger = opts.remainingLimits?.get(item.id);
    const effectiveLimit = Math.min(item.buy_limit ?? Infinity, limitFromLedger ?? Infinity);
    const qty = Math.max(0, Math.min(effectiveLimit, affordableQty));
    // qty of 0 here can mean "can't afford one" or "limit already spent" -- either way it isn't a
    // placeable suggestion, so it's skipped rather than shown as a slot you can't actually fill.
    if (qty <= 0) continue;

    const cost = qty * item.low;
    const projectedProfit = qty * (item.net_margin ?? 0);
    assignments.push({ slot: assignments.length + 1, item, qty, cost, projectedProfit });
    remaining -= cost;
  }

  const totalCost = assignments.reduce((sum, a) => sum + a.cost, 0);
  const totalProfit = assignments.reduce((sum, a) => sum + a.projectedProfit, 0);
  return { assignments, totalCost, totalProfit, remainingBankroll: opts.bankroll - totalCost };
}
