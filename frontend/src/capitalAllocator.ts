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
  opts: { bankroll: number; numSlots: number; maxAllocationPct: number },
): AllocationResult {
  const maxPerItem = opts.bankroll * (opts.maxAllocationPct / 100);
  const candidates = [...items]
    .filter((i) => (i.net_margin ?? 0) > 0 && i.low)
    .sort((a, b) => b.score - a.score);

  const assignments: SlotAssignment[] = [];
  let remaining = opts.bankroll;

  for (const item of candidates) {
    if (assignments.length >= opts.numSlots) break;
    if (!item.low) continue;
    const capForItem = Math.min(maxPerItem, remaining);
    const affordableQty = Math.floor(capForItem / item.low);
    const qty = Math.max(0, Math.min(item.buy_limit ?? Infinity, affordableQty));
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
