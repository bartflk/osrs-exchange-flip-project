// GE tax: 2% of sale price (doubled from 1% on 2025-05-29, the "Yama CAs & More!" update --
// verified against the live OSRS Wiki Grand Exchange page), capped at 5,000,000gp per sale,
// rounds down to 0 (so effectively waived) under 50gp. A curated whitelist of tax-exempt items
// also exists (bonds, teleport tabs, charged jewelry, basic tools, low-level food/ammo/potions)
// -- not modeled here, since it needs a maintained item-id list rather than a price-based rule;
// net_margin will slightly under-state profit on that specific whitelist until it's added.
export function geTax(sellPrice: number): number {
  const tax = Math.floor(sellPrice * 0.02);
  if (tax === 0) return 0;
  return Math.min(tax, 5_000_000);
}

export interface ItemRow {
  id: number;
  name: string;
  members: number;
  buy_limit: number | null;
  icon: string;
  high: number | null;
  low: number | null;
  vol_high_5m: number;
  vol_low_5m: number;
  vol_high_1h: number;
  vol_low_1h: number;
  updated_at: number | null;
}

export interface ScoredItem extends ItemRow {
  net_margin: number | null;
  roi_pct: number | null;
  liquidity: number;
  limit_adjusted_profit: number | null;
  score: number;
  tax: number | null;
}

export function scoreItem(row: ItemRow): ScoredItem {
  const { high, low, buy_limit, vol_high_5m, vol_low_5m, vol_high_1h, vol_low_1h } = row;

  let net_margin: number | null = null;
  let roi_pct: number | null = null;
  let limit_adjusted_profit: number | null = null;
  let tax: number | null = null;

  if (high != null && low != null && low > 0) {
    tax = geTax(high);
    net_margin = high - low - tax;
    roi_pct = net_margin / low;
    if (buy_limit) {
      limit_adjusted_profit = net_margin * buy_limit;
    }
  }

  // liquidity: minimum of 5m and 1h volume on both sides, so a burst on one side
  // doesn't overstate how fillable the flip actually is.
  const minVol5m = Math.min(vol_high_5m, vol_low_5m);
  const minVol1h = Math.min(vol_high_1h, vol_low_1h);
  const liquidity = Math.min(minVol5m * 12, minVol1h); // normalize 5m to hourly rate, take the more conservative

  const score = net_margin != null ? net_margin * Math.log10(liquidity + 1) : -Infinity;

  return { ...row, net_margin, roi_pct, liquidity, limit_adjusted_profit, score, tax };
}
