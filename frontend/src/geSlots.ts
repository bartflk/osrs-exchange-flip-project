import type { GeSlot, MarketItem } from "./api";
import type { SlotAssignment } from "./capitalAllocator";
import { formatGp, formatGpFull } from "./format";
import { computeRepriceGuidance } from "./repriceGuidance";

// DESIGN.md §14.42: the logic behind the GE slot board -- what each of the 8 boxes should say.
// Kept out of the component file for the same reason capitalAllocator.ts and repriceGuidance.ts
// are: it's a pure function that's worth reading and testing on its own, and Vite's fast refresh
// only works when a component module exports nothing but components.

export type SlotStatus =
  | "collect" // fully filled, go press Collect
  | "cancel" // still open but no longer worth filling
  | "reprice" // priced away from market, will sit
  | "filling" // partially filled and priced sensibly
  | "waiting" // priced sensibly, nothing filled yet
  | "suggestion" // empty box, allocator has a candidate
  | "empty"; // empty box, nothing to suggest

export const STATUS_STYLE: Record<SlotStatus, { box: string; label: string; tone: string }> = {
  // "Lights up": saturated ring + tinted background for anything needing a decision, deliberately
  // flat/dim for anything that's fine, so a glance finds the actionable boxes.
  collect: {
    box: "border-emerald-400/70 bg-emerald-500/10 ring-1 ring-emerald-400/40",
    label: "Collect",
    tone: "text-emerald-300",
  },
  cancel: {
    box: "border-rose-400/70 bg-rose-500/10 ring-1 ring-rose-400/40",
    label: "Cancel",
    tone: "text-rose-300",
  },
  reprice: {
    box: "border-amber-400/70 bg-amber-500/10 ring-1 ring-amber-400/40",
    label: "Reprice",
    tone: "text-amber-300",
  },
  filling: { box: "border-white/10 bg-white/[0.03]", label: "Filling", tone: "text-gray-400" },
  waiting: { box: "border-white/10 bg-white/[0.03]", label: "Waiting", tone: "text-gray-500" },
  suggestion: {
    box: "border-sky-400/40 bg-sky-500/[0.06] border-dashed",
    label: "Buy",
    tone: "text-sky-300",
  },
  empty: {
    box: "border-white/5 bg-transparent border-dashed",
    label: "Empty",
    tone: "text-gray-600",
  },
};

export interface SlotView {
  index: number;
  status: SlotStatus;
  slot?: GeSlot;
  suggestion?: SlotAssignment;
  headline: string;
  detail: string;
  suggestedPrice: number | null;
}

/**
 * Decide what each of the 8 boxes should say.
 *
 * Order of checks matters and is the same priority a player would apply: a fully-filled offer
 * needs collecting no matter how it was priced; an unprofitable one should be cancelled rather
 * than repriced to fill faster into a loss; only then does "will this fill at all" apply.
 */
export function buildSlotViews(
  slots: GeSlot[],
  suggestions: SlotAssignment[],
  items: MarketItem[],
): SlotView[] {
  const byIndex = new Map(slots.map((s) => [s.slot, s]));
  // Keyed by id, not name. Name matching failed live for Diamond while working for Emerald,
  // because `items` is the Market tab's *filtered* list -- anything below its liquidity threshold
  // simply isn't in it, and the slot then rendered "not in the current Market fetch" instead of
  // guidance. Ids are also immune to the punctuation/case mismatches names invite.
  const marketById = new Map(items.map((i) => [i.id, i]));
  const queue = [...suggestions];

  const views: SlotView[] = [];
  for (let index = 0; index < 8; index++) {
    const slot = byIndex.get(index);

    if (!slot) {
      const suggestion = queue.shift();
      views.push(
        suggestion
          ? {
              index,
              status: "suggestion",
              suggestion,
              headline: suggestion.item.name,
              detail: `Buy ${suggestion.qty.toLocaleString()} @ ${formatGpFull(
                suggestion.item.low ?? 0,
              )} · +${formatGp(suggestion.projectedProfit)}`,
              suggestedPrice: suggestion.item.low ?? null,
            }
          : { index, status: "empty", headline: "Empty", detail: "", suggestedPrice: null },
      );
      continue;
    }

    const market = marketById.get(slot.itemId);
    const done = slot.totalQuantity > 0 && slot.quantitySold >= slot.totalQuantity;

    // The backend already resolves each slot's relevant side of the book (high for a buy, low for
    // a sell) straight from latest_snapshot, so a slot can still be judged on "will this fill"
    // even when the item is absent from the filtered Market list. The full MarketItem is still
    // preferred when available -- it's the only thing carrying net_margin, which is what powers
    // the "cancel, no longer profitable" verdict.
    const fallback: MarketItem | undefined =
      market ??
      (slot.marketPrice != null
        ? ({
            id: slot.itemId,
            name: slot.name,
            low: slot.type === "buy" ? slot.marketPrice : null,
            high: slot.type === "sell" ? slot.marketPrice : null,
            // Deliberately positive-but-unknown: without margin data the rules must not conclude
            // "cancel, unprofitable" from missing information. Fill guidance still works.
            net_margin: 1,
          } as unknown as MarketItem)
        : undefined);

    const guidance = computeRepriceGuidance({ type: slot.type, price: slot.price }, fallback);

    let status: SlotStatus;
    let detail: string;
    let suggestedPrice: number | null = guidance.suggestedPrice;

    if (done) {
      status = "collect";
      detail = `${slot.type === "buy" ? "Bought" : "Sold"} all ${slot.totalQuantity.toLocaleString()} — collect it`;
      suggestedPrice = null;
    } else if (guidance.action === "cancel") {
      status = "cancel";
      detail = guidance.reason;
    } else if (guidance.action === "reprice_up" || guidance.action === "reprice_down") {
      status = "reprice";
      detail = guidance.reason;
    } else if (slot.quantitySold > 0) {
      status = "filling";
      detail = guidance.reason;
    } else {
      status = "waiting";
      detail = guidance.reason;
    }

    views.push({ index, status, slot, headline: slot.name, detail, suggestedPrice });
  }
  return views;
}

/** How many boxes are asking for a decision right now. */
export function countNeedsAction(views: SlotView[]): number {
  return views.filter(
    (v) => v.status === "collect" || v.status === "cancel" || v.status === "reprice",
  ).length;
}
