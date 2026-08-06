import type { MarketItem } from "./api";
import type { Offer } from "./offers";

// DESIGN.md §10 item 23: Trade Health Score -- a continuously-recalculated 0-100 score for each
// tracked/open offer, re-evaluated every poll cycle since it's a pure function of the offer +
// current market row (same "no persisted judgment" pattern as repriceGuidance.ts). Distinct from
// that guidance (a one-shot hold/reprice/cancel verdict) -- health tracks the whole thesis
// decaying over time (margin going flat, volatility picking up, the offer sitting unfilled),
// not just "is my price still competitive." Always paired with plain-English reasons for any
// deduction -- matches this app's "never a silent black box" principle (§1).
export type TradeHealthTier = "healthy" | "watch" | "at_risk";

export interface TradeHealth {
  score: number;
  tier: TradeHealthTier;
  reasons: string[];
}

export const TIER_LABEL: Record<TradeHealthTier, string> = {
  healthy: "Healthy",
  watch: "Watch",
  at_risk: "At risk",
};

export const TIER_TONE: Record<TradeHealthTier, string> = {
  healthy: "text-emerald-400",
  watch: "text-amber-400",
  at_risk: "text-rose-400",
};

function tierFor(score: number): TradeHealthTier {
  if (score >= 70) return "healthy";
  if (score >= 40) return "watch";
  return "at_risk";
}

export function computeTradeHealth(offer: Offer, market: MarketItem | undefined): TradeHealth | null {
  if (!market || market.low == null || market.high == null) return null;

  let score = 100;
  const reasons: string[] = [];

  // The underlying flip's own margin going flat/negative matters more than your specific price --
  // if the thesis itself broke, no reprice fixes that.
  if ((market.net_margin ?? 0) <= 0) {
    score -= 40;
    reasons.push("underlying margin has gone flat or negative");
  }

  // Price drift against you -- how far the market has moved past your offer, same direction
  // repriceGuidance.ts already checks, but here as a continuous penalty rather than a verdict.
  if (offer.type === "buy" && market.low > offer.price) {
    const gapPct = (market.low - offer.price) / offer.price;
    const penalty = Math.min(30, gapPct * 300);
    if (penalty > 2) {
      score -= penalty;
      reasons.push(`market's buying at ${Math.round(market.low).toLocaleString()}gp, above your offer`);
    }
  } else if (offer.type === "sell" && market.high < offer.price) {
    const gapPct = (offer.price - market.high) / offer.price;
    const penalty = Math.min(30, gapPct * 300);
    if (penalty > 2) {
      score -= penalty;
      reasons.push(`market's selling at ${Math.round(market.high).toLocaleString()}gp, below your ask`);
    }
  }

  // Volatility picking up erodes confidence in the thesis holding, independent of price drift.
  if (market.volatility_pct != null && market.volatility_pct > 0.03) {
    const penalty = Math.min(20, (market.volatility_pct - 0.03) * 400);
    score -= penalty;
    reasons.push(`volatility picked up (${(market.volatility_pct * 100).toFixed(1)}% 24h)`);
  }

  // Thin liquidity means harder to fill (buy) or exit (sell), even if the price itself is fine.
  if (market.liquidity < 10) {
    score -= 15;
    reasons.push("liquidity has thinned -- may be hard to fill or exit");
  }

  // Staleness: an offer that's been sitting a long time without filling is itself a signal
  // something's off, separate from any single factor above.
  if (offer.trackedAt != null) {
    const hoursOpen = (Date.now() / 1000 - offer.trackedAt) / 3600;
    if (hoursOpen > 4) {
      const penalty = Math.min(15, (hoursOpen - 4) * 2);
      score -= penalty;
      reasons.push(`open ${hoursOpen.toFixed(0)}h without filling`);
    }
  }

  score = Math.max(0, Math.round(score));
  return { score, tier: tierFor(score), reasons };
}
