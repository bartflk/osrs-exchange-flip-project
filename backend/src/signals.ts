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
export const NON_FLIPPABLE_IDS = new Set([13190]);

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
  /** Unix seconds of the last trade on each side. Null on items that have never traded. */
  high_time: number | null;
  low_time: number | null;
  /** Units traded in the last 24 hours, from the wiki volumes endpoint. Null until first poll. */
  daily_volume: number | null;
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
  /**
   * Margin times daily volume: how much profit the whole market moved through this item in a day.
   *
   * The one number every competing tool leads with, and the app did not have it. Margin alone
   * ranks a 3.5m spread on an item that trades thirty times a day above a 1gp spread on one that
   * trades a hundred million times, and only one of those is somewhere money actually is. It is
   * NOT what you can personally make, which is the buy limit column next to it.
   */
  margin_x_volume: number | null;
  /** Seconds since the last trade on each side. The margin is only as real as the older of these. */
  buy_age: number | null;
  sell_age: number | null;
  /** Recent price trace for the row sparkline, filled in by the items route, not by scoring. */
  spark?: number[];
  /**
   * The flip rank, 0 to 100, and the four factors behind it. See flipScore.ts.
   *
   * Attached after scoring rather than inside it, because it needs fields (buy_age, liquidity,
   * volatility) that scoreItem itself produces. Optional so the many callers of scoreItem that
   * only want a margin do not pay for it.
   */
  flip?: import("./flipScore.js").FlipScore;
}

export function scoreItem(row: ItemRow): ScoredItem {
  const { high, low, buy_limit, vol_high_1h, vol_low_1h } = row;

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
      margin_x_volume: null,
      buy_age: null,
      sell_age: null,
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

  // Units you could realistically fill in an hour: the THINNER SIDE of the last hour of trade, so
  // a burst of buying does not overstate how easily you get back out.
  //
  // This used to also take min() against the five-minute volume scaled up by twelve, as a second
  // conservatism. That term could only ever drag the answer to zero. An item trading a few hundred
  // times a day has no trades at all in most five-minute windows, so one side is 0, times twelve is
  // 0, and the min is 0. Measured on the live board: eight of the top ten items by market turnover
  // reported 0/hr, including Ancestral robe top at 299 trades a day and Elder maul at 477. A
  // liquidity number that reads zero for items that visibly trade is worse than no number, because
  // it is also the score's volume term and the Market tab's minimum-liquidity filter.
  const liquidity = Math.min(vol_high_1h, vol_low_1h);

  // Volatility as a mild score penalty, not a hard filter -- an item with no volatility data
  // yet (penalty factor 1) ranks exactly as before, so this never breaks ranking for items
  // without 24h of history. Once data exists, a highly volatile item (CoV of, say, 0.3) is
  // discounted to ~77% of its raw score -- message 8's "Trade Health combines... Volatility."
  const volatility_pct = getVolatility(row.id);
  const volatilityPenalty = 1 + (volatility_pct ?? 0);
  const score =
    net_margin != null ? (net_margin * Math.log10(liquidity + 1)) / volatilityPenalty : -Infinity;

  const now = Math.floor(Date.now() / 1000);
  return {
    ...row,
    net_margin,
    roi_pct,
    liquidity,
    limit_adjusted_profit,
    score,
    tax,
    volatility_pct,
    margin_x_volume:
      net_margin != null && row.daily_volume != null ? net_margin * row.daily_volume : null,
    buy_age: row.low_time != null ? Math.max(0, now - row.low_time) : null,
    sell_age: row.high_time != null ? Math.max(0, now - row.high_time) : null,
    execution_buy_price,
    execution_sell_price,
    execution_margin,
  };
}
