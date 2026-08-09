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
  },
): AllocationResult {
  const maxPerItem = opts.bankroll * (opts.maxAllocationPct / 100);
  const minLiquidity = opts.minLiquidity ?? 0;
  let candidates = [...items]
    .filter(
      (i) =>
        (i.net_margin ?? 0) > 0 &&
        i.low &&
        i.liquidity >= minLiquidity &&
        !opts.excludeNames?.has(i.name.toLowerCase()),
    )
    .sort((a, b) => b.score - a.score);

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
