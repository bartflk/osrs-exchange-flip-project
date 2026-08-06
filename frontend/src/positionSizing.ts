import type { MarketItem } from "./api";

// DESIGN.md §10 item 7: instead of a single suggested quantity, show conservative/suggested/
// aggressive bands so the number itself communicates how sure the system is -- a wide, low
// conservative band on a volatile item says "be careful" without needing a sentence to say it.
// Deterministic, reuses volatility_pct (already computed by volatility.ts/§14.12) -- no new data.
export type SizingTierName = "conservative" | "suggested" | "aggressive";

export interface SizingTier {
  name: SizingTierName;
  qty: number;
  cost: number;
  projectedProfit: number;
}

const TIER_FRACTIONS: Record<SizingTierName, number> = {
  conservative: 0.25,
  suggested: 0.5,
  aggressive: 1,
};

// volatility_pct is a coefficient of variation over 24h ticks; live data shows typical values in
// the 0.001-0.05 range for normal items (matches the existing >0.05 "watch out" threshold used
// elsewhere in ItemDetailModal). Scaled so ~5% CoV roughly halves confidence, ~8%+ floors it --
// not backtested, same honest caveat already attached to every other tier/threshold in this app.
function stabilityFactor(volatilityPct: number | null): number {
  if (volatilityPct == null) return 0.6; // unknown -- moderate default, not falsely confident
  return Math.max(0.2, Math.min(1, 1 - volatilityPct * 10));
}

export function computeSizingTiers(item: MarketItem): SizingTier[] | null {
  if (item.low == null || item.net_margin == null || item.net_margin <= 0) return null;

  // Cap position size by whatever's more restrictive: the GE's own 4h buy limit, or how much
  // volume actually clears in an hour (no point sizing past what could realistically fill).
  const limitCap = item.buy_limit ?? Infinity;
  const liquidityCap = item.liquidity > 0 ? item.liquidity : Infinity;
  const baseMax = Math.min(limitCap, liquidityCap);
  if (!Number.isFinite(baseMax) || baseMax <= 0) return null;

  const stability = stabilityFactor(item.volatility_pct);

  return (Object.keys(TIER_FRACTIONS) as SizingTierName[]).map((name) => {
    const qty = Math.max(0, Math.floor(baseMax * TIER_FRACTIONS[name] * stability));
    return {
      name,
      qty,
      cost: qty * item.low!,
      projectedProfit: qty * item.net_margin!,
    };
  });
}
