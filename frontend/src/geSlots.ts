import type { GeSlot, MarketItem } from "./api";
import type { SlotAssignment } from "./capitalAllocator";
import { formatGp } from "./format";
import { computeRepriceGuidance } from "./repriceGuidance";

// DESIGN.md §14.42: the logic behind the GE slot board -- what each of the 8 boxes should say.
// Kept out of the component file for the same reason capitalAllocator.ts and repriceGuidance.ts
// are: it's a pure function that's worth reading and testing on its own, and Vite's fast refresh
// only works when a component module exports nothing but components.

export type SlotStatus =
  | "collect" // fully filled, go press Collect
  | "cancel" // still open but no longer worth filling
  | "onplan" // priced away from market ON PURPOSE -- matches an overnight plan
  | "reprice" // priced away from market, will sit
  | "filling" // partially filled and priced sensibly
  | "waiting" // priced sensibly, nothing filled yet
  | "suggestion" // empty box, allocator has a candidate
  | "empty"; // empty box, nothing to suggest

export const STATUS_STYLE: Record<
  SlotStatus,
  { box: string; label: string; tone: string; pill: string }
> = {
  // "Lights up": saturated ring + tinted background for anything needing a decision, deliberately
  // flat/dim for anything that's fine, so a glance finds the actionable boxes.
  collect: {
    box: "border-emerald-400/70 bg-emerald-500/10 ring-1 ring-emerald-400/40",
    label: "Collect",
    tone: "text-emerald-300",
    pill: "bg-emerald-500/20 text-emerald-200 border-emerald-400/40",
  },
  cancel: {
    box: "border-rose-400/70 bg-rose-500/10 ring-1 ring-rose-400/40",
    label: "Cancel",
    tone: "text-rose-300",
    pill: "bg-rose-500/20 text-rose-200 border-rose-400/40",
  },
  reprice: {
    box: "border-amber-400/70 bg-amber-500/10 ring-1 ring-amber-400/40",
    label: "Reprice",
    tone: "text-amber-300",
    pill: "bg-amber-500/20 text-amber-200 border-amber-400/40",
  },
  // Deliberately calm, and deliberately NOT amber: this box is doing exactly what was asked of
  // it. Violet matches the hold-window shading on the slot chart directly below it.
  onplan: {
    box: "border-violet-400/40 bg-violet-500/[0.07]",
    label: "On plan",
    tone: "text-violet-300",
    pill: "bg-violet-500/20 text-violet-200 border-violet-400/40",
  },
  filling: {
    box: "border-white/10 bg-white/[0.03]",
    label: "Filling",
    tone: "text-gray-400",
    pill: "bg-white/10 text-gray-300 border-white/15",
  },
  waiting: {
    box: "border-white/10 bg-white/[0.03]",
    label: "Waiting",
    tone: "text-gray-500",
    pill: "bg-white/10 text-gray-400 border-white/15",
  },
  suggestion: {
    box: "border-sky-400/40 bg-sky-500/[0.06] border-dashed",
    label: "Buy",
    tone: "text-sky-300",
    pill: "bg-sky-500/20 text-sky-200 border-sky-400/40",
  },
  empty: {
    box: "border-white/5 bg-transparent border-dashed",
    label: "Empty",
    tone: "text-gray-600",
    pill: "bg-transparent text-gray-600 border-white/10",
  },
};

// What the Overnight page intends for an item: buy near its typical price at one slot, sell near
// its typical price at another. Both legs are priced AWAY from the current market on purpose --
// that is the entire strategy -- so the generic reprice rules, which only ask "will this fill at
// today's price", give exactly the wrong answer about them.
export interface OvernightPlan {
  itemId: number;
  buyPrice: number | null;
  sellPrice: number | null;
  buySlotLabel: string;
  sellSlotLabel: string;
  // Half-hour slot indices (0-47). Labels are for reading; these are what the chart needs, and
  // carrying both means a remembered plan can still draw itself once the item has left the live
  // pick list. Optional because plans stored before this field existed will not have it.
  buySlot?: number;
  sellSlot?: number;
  // The economics, carried on the plan rather than looked up from the live pick list.
  //
  // Necessary once picks are ranked against SPENDABLE cash (14.56): a 50m item you already hold
  // is correctly absent from a list sized for the 2.5m you have left, so every card showing a
  // held position lost its expected-profit figure and the board total silently stopped counting
  // it -- 139k reported for a board actually carrying several million. The plan is the right
  // home for this: it is what was promised when the offer was placed.
  profitPerUnit?: number;
  worstDayProfit?: number;
  winDays?: number;
  pairedDays?: number;
}

// How far a real offer may sit from the planned price and still count as "that plan". Slot prices
// are medians over a week of half-hour readings, so an exact match is not something a human
// typing into the GE could hit, nor something worth demanding.
const PLAN_PRICE_TOLERANCE = 0.03;

export interface SlotView {
  index: number;
  status: SlotStatus;
  slot?: GeSlot;
  suggestion?: SlotAssignment;
  headline: string;
  detail: string;
  suggestedPrice: number | null;
  /** The price this box is about -- the live offer's, or the suggested buy price. */
  price: number | null;
  /** Units, as "sold/total" for a live offer or the suggested quantity. */
  qtyText: string | null;
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
  // Overnight plans keyed by item id. Omitted by Buy Signals, whose offers are meant to fill at
  // today's price and so genuinely do want the reprice rules.
  //
  // Keyed off the RAW pick list, not the allocator's assignments: once you place the offer the
  // allocator excludes that item from its candidates (it is already occupying a slot), so by the
  // time the plan matters most there is no assignment left to match against.
  plans?: Map<number, OvernightPlan>,
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
              detail: `Ties up ${formatGp(suggestion.cost)}`,
              suggestedPrice: suggestion.item.low ?? null,
              price: suggestion.item.low ?? null,
              qtyText: `buy ${suggestion.qty.toLocaleString()}`,
            }
          : {
              index,
              status: "empty",
              headline: "Empty",
              detail: "",
              suggestedPrice: null,
              price: null,
              qtyText: null,
            },
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

    // Does this offer match an overnight plan for the same item, on the same leg?
    const plan = plans?.get(slot.itemId);
    const plannedPrice = plan ? (slot.type === "buy" ? plan.buyPrice : plan.sellPrice) : null;
    const onPlan =
      plannedPrice != null &&
      plannedPrice > 0 &&
      Math.abs(slot.price - plannedPrice) / plannedPrice <= PLAN_PRICE_TOLERANCE;

    let status: SlotStatus;
    let detail: string;
    let suggestedPrice: number | null = guidance.suggestedPrice;

    if (done) {
      status = "collect";
      detail = `${slot.type === "buy" ? "Bought" : "Sold"} all ${slot.totalQuantity.toLocaleString()}, collect it`;
      suggestedPrice = null;
    } else if (onPlan && plan) {
      // Checked BEFORE cancel as well as before reprice, and both for the same reason: those two
      // verdicts answer "does this fill, and is it worth filling, at TODAY's spread." An overnight
      // position is not trying to clear today's spread -- it is priced to a band measured over a
      // week, and being away from the current market is the position, not a mistake in it.
      status = "onplan";
      const market = fallback;
      const ref = slot.type === "buy" ? market?.low : market?.high;
      const gapPct =
        ref != null && ref > 0 ? Math.abs(slot.price - ref) / ref : null;
      const side = slot.type === "buy" ? "below" : "above";
      const fills =
        gapPct == null
          ? ""
          : (slot.type === "buy" && slot.price >= (ref ?? 0)) ||
              (slot.type === "sell" && slot.price <= (ref ?? Infinity))
            ? " At market, should fill."
            : ` Priced ${(gapPct * 100).toFixed(1)}% ${side} market by design.`;
      detail = `On plan.${fills}`;
      // No suggested reprice: there is nothing to correct.
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

    views.push({
      index,
      status,
      slot,
      headline: slot.name,
      detail,
      suggestedPrice,
      price: slot.price,
      qtyText: `${slot.quantitySold.toLocaleString()}/${slot.totalQuantity.toLocaleString()}`,
    });
  }
  return views;
}

/** How many boxes are asking for a decision right now. */
export function countNeedsAction(views: SlotView[]): number {
  return views.filter(
    (v) => v.status === "collect" || v.status === "cancel" || v.status === "reprice",
  ).length;
}
