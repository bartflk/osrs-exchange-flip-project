import { getVolatility } from "./volatility.js";

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

// DESIGN.md §10 item 46 (Execution Edge, from Design/new suggestions.txt): net_margin assumes
// buying at exactly `low` and selling at exactly `high` fills instantly, which is optimistic --
// low/high are the most recent FILL, not a live order book, so an offer placed at either price
// can sit unfilled. A more realistic suggestion nudges the buy slightly above `low` and the sell
// slightly below `high` -- "undercut/overcut" to jump the queue at a small, explicit cost, same
// mechanic `repriceGuidance.ts`'s SLIGHT_GAP threshold already reasons about for tracked offers.
// The nudge size is a simple %-of-price heuristic (min 1gp), NOT the real GE tick-size table --
// deliberately flagged as a placeholder since the source suggestion itself says this should
// "eventually be data-driven" once real fill-rate history exists to calibrate against (that data
// doesn't exist yet -- Track Record, §10 item 1, logs buy-price vs. resolved price, not whether a
// specific offer price filled).
const EXECUTION_NUDGE_PCT = 0.005; // 0.5% of price, minimum 1gp
function executionNudge(price: number): number {
  return Math.max(1, Math.round(price * EXECUTION_NUDGE_PCT));
}

// Old school bond (13190): technically has a GE buy/sell spread like any other item, but it's
// not something people actually flip -- getting a sellable bond onto the GE in the first place
// means either paying real money for it or already holding one from membership, not buying it
// off the GE cheap and reselling. Scoring it alongside genuine flips just wastes a Buy Signals /
// allocator slot on a "flip" no one would actually run. Excluded from scoring everywhere
// (Market, Buy Signals, Track record, Capital allocator all share scoreItem).
const NON_FLIPPABLE_IDS = new Set([13190]);

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
  // Coefficient of variation of the high price over a trailing 24h (volatility.ts) -- null
  // until enough history exists, not a fake 0.
  volatility_pct: number | null;
  // Execution Edge (see executionNudge above): a more realistic buy/sell pair than the raw
  // low/high, and the margin you'd actually clear at those prices after tax. Null under the
  // same conditions net_margin is null (no current high/low, or low <= 0).
  execution_buy_price: number | null;
  execution_sell_price: number | null;
  execution_margin: number | null;
}

export function scoreItem(row: ItemRow): ScoredItem {
  const { high, low, buy_limit, vol_high_5m, vol_low_5m, vol_high_1h, vol_low_1h } = row;

  let net_margin: number | null = null;
  let roi_pct: number | null = null;
  let limit_adjusted_profit: number | null = null;
  let tax: number | null = null;

  if (NON_FLIPPABLE_IDS.has(row.id)) {
    return {
      ...row,
      net_margin,
      roi_pct,
      liquidity: 0,
      limit_adjusted_profit,
      score: -Infinity,
      tax,
      volatility_pct: null,
      execution_buy_price: null,
      execution_sell_price: null,
      execution_margin: null,
    };
  }

  let execution_buy_price: number | null = null;
  let execution_sell_price: number | null = null;
  let execution_margin: number | null = null;

  if (high != null && low != null && low > 0) {
    tax = geTax(high);
    net_margin = high - low - tax;
    roi_pct = net_margin / low;
    if (buy_limit) {
      limit_adjusted_profit = net_margin * buy_limit;
    }

    execution_buy_price = low + executionNudge(low);
    // Guard against a pathologically thin spread collapsing the two prices past each other --
    // sell must clear at least 1gp above the nudged buy price.
    execution_sell_price = Math.max(execution_buy_price + 1, high - executionNudge(high));
    execution_margin = execution_sell_price - execution_buy_price - geTax(execution_sell_price);
  }

  // liquidity: minimum of 5m and 1h volume on both sides, so a burst on one side
  // doesn't overstate how fillable the flip actually is.
  const minVol5m = Math.min(vol_high_5m, vol_low_5m);
  const minVol1h = Math.min(vol_high_1h, vol_low_1h);
  const liquidity = Math.min(minVol5m * 12, minVol1h); // normalize 5m to hourly rate, take the more conservative

  // Volatility as a mild score penalty, not a hard filter -- an item with no volatility data
  // yet (penalty factor 1) ranks exactly as before, so this never breaks ranking for items
  // without 24h of history. Once data exists, a highly volatile item (CoV of, say, 0.3) is
  // discounted to ~77% of its raw score -- message 8's "Trade Health combines... Volatility."
  const volatility_pct = getVolatility(row.id);
  const volatilityPenalty = 1 + (volatility_pct ?? 0);
  const score =
    net_margin != null ? (net_margin * Math.log10(liquidity + 1)) / volatilityPenalty : -Infinity;

  return {
    ...row,
    net_margin,
    roi_pct,
    liquidity,
    limit_adjusted_profit,
    score,
    tax,
    volatility_pct,
    execution_buy_price,
    execution_sell_price,
    execution_margin,
  };
}
