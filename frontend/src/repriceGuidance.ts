import type { MarketItem } from "./api";
import type { Offer } from "./offers";

// DESIGN.md §10 item 17 / §14.16: reprice/cancel guidance for tracked GE offers. Deterministic,
// rule-based, explainable from the same buy/sell prices already shown elsewhere in the app --
// same philosophy as alerts.ts and the Actions tab's existing sell heuristic. Re-evaluated fresh
// every time `items` updates (each poll cycle), since it's a pure function of the offer and the
// current market row, not a persisted judgment.
export type RepriceAction = "hold" | "reprice_up" | "reprice_down" | "cancel" | "unknown";

export interface RepriceGuidance {
  action: RepriceAction;
  suggestedPrice: number | null;
  reason: string;
}

export const ACTION_LABEL: Record<RepriceAction, string> = {
  hold: "Hold",
  reprice_up: "Reprice up",
  reprice_down: "Reprice down",
  cancel: "Cancel",
  unknown: "Unknown",
};

export const ACTION_TONE: Record<RepriceAction, string> = {
  hold: "text-emerald-400",
  reprice_up: "text-amber-400",
  reprice_down: "text-amber-400",
  cancel: "text-rose-400",
  unknown: "text-gray-500",
};

// Matches the threshold the Actions tab's fill-likelihood heuristic already used inline before
// this was pulled out into a shared, reusable, and more actionable function.
const SLIGHT_GAP = 0.02; // 2%

export function computeRepriceGuidance(
  offer: Offer,
  market: MarketItem | undefined,
): RepriceGuidance {
  if (!market) {
    return {
      action: "unknown",
      suggestedPrice: null,
      reason: "Not in the current Market fetch — too illiquid to compare, or a name mismatch.",
    };
  }

  if (offer.type === "buy") {
    if (market.low == null) {
      return { action: "unknown", suggestedPrice: null, reason: "No current buy-side price." };
    }
    if (offer.price >= market.low) {
      return {
        action: "hold",
        suggestedPrice: null,
        reason: "At or above the current market low — should fill.",
      };
    }
    const gapPct = (market.low - offer.price) / market.low;
    if (gapPct > SLIGHT_GAP && (market.net_margin ?? 0) <= 0) {
      // The market moved enough that even buying at today's low no longer clears a profitable
      // margin -- reprice guidance alone would be misleading; the trade itself is stale.
      return {
        action: "cancel",
        suggestedPrice: null,
        reason:
          "Market moved against this flip — buying even at today's price no longer clears a profitable margin.",
      };
    }
    return {
      action: "reprice_up",
      suggestedPrice: market.low,
      reason:
        gapPct <= SLIGHT_GAP
          ? `${(gapPct * 100).toFixed(1)}% below market — a small reprice would likely fill.`
          : `${(gapPct * 100).toFixed(1)}% below market — may sit unfilled at this price.`,
    };
  }

  // sell
  if (market.high == null) {
    return { action: "unknown", suggestedPrice: null, reason: "No current sell-side price." };
  }
  if (offer.price <= market.high) {
    return {
      action: "hold",
      suggestedPrice: null,
      reason: "At or below the current market high — should fill.",
    };
  }
  const gapPct = (offer.price - market.high) / market.high;
  return {
    action: "reprice_down",
    suggestedPrice: market.high,
    reason:
      gapPct <= SLIGHT_GAP
        ? `${(gapPct * 100).toFixed(1)}% above market — a small reprice would likely fill.`
        : `${(gapPct * 100).toFixed(1)}% above market — may sit unfilled at this price.`,
  };
}
