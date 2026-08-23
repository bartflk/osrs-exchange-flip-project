import type { PairedDay } from "./api";

// Pricing a round trip to a chosen fill probability.
//
// §14.60 measured the problem this solves: the plan quotes the MEDIAN low at the buy slot, which
// by construction is reached on about half the days, and a live run left four of five buys
// unfilled for nine hours. The median is not a special price -- it is simply the 50% point of a
// distribution the app already stores per day. Every other point on that distribution is equally
// available, and each one is a different trade:
//
//   bid low  -> rarely fills, wide margin when it does
//   bid high -> nearly always fills, thin margin
//
// So the aggression is exposed as a dial rather than frozen at 50%. Both legs move together and
// in opposite directions: raising the target lifts the FLOOR you bid and lowers the CEILING you
// ask, narrowing the band from both sides. Watching the profit shrink as the dial turns is the
// point -- it is the cost of certainty, made visible instead of argued about.

/** GE tax: 2% of the sale, capped at 5m, rounded down (so waived under 50gp). Mirrors signals.ts. */
export function geTax(sellPrice: number): number {
  const tax = Math.floor(sellPrice * 0.02);
  if (tax === 0) return 0;
  return Math.min(tax, 5_000_000);
}

/**
 * Value at a given quantile, linearly interpolated between the two neighbouring observations.
 *
 * This was originally nearest-rank, on the reasoning that an interpolated quantile "invents a
 * price that was never observed." That reasoning was wrong here, and the slider made it obvious:
 * with seven daily observations, eighteen slider positions collapse onto six distinct prices, so
 * the band sat still for three or four steps and then jumped fifty gp -- reported as "the lines
 * just jump around instead of tightening the band."
 *
 * The distinction the original comment missed: a price you PLACE is a decision, and any integer
 * is available to it. A statistic you REPORT is a claim about history and should be an observed
 * value. Bid and ask are decisions. The fill rates beside them are claims, and those stay
 * empirical -- counted against the real observations, never interpolated.
 */
export function quantile(values: number[], q: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 1) return sorted[0];
  const pos = Math.min(sorted.length - 1, Math.max(0, q * (sorted.length - 1)));
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

export interface FillPricing {
  /** What to bid. Higher target = higher bid = fills more often. */
  bid: number;
  /** What to ask. Higher target = lower ask = fills more often. */
  ask: number;
  profitPerUnit: number;
  /** Rates ACHIEVED by these prices against the sample, which is not exactly the target -- with
   *  seven observations the reachable rates are sevenths. Reporting the achieved rate rather than
   *  the requested one keeps the number honest. */
  buyFillRate: number;
  sellFillRate: number;
  /** Rough odds of getting both legs. See the caveat in the UI: the legs are not independent, and
   *  a missed SELL is recoverable (you still hold the item) while a missed BUY is simply no trade. */
  bothLegs: number;
  /** Worst and best single measured day AT THESE PRICES. */
  worstDayProfit: number;
  bestDayProfit: number;
  winDays: number;
  days: number;
}

export function priceAtFill(paired: PairedDay[], target: number): FillPricing | null {
  if (paired.length === 0) return null;
  const lows = paired.map((p) => p.buy);
  const highs = paired.map((p) => p.sell);

  const bidRaw = quantile(lows, target);
  // Mirrored: to sell on `target` of days you must ask at the (1 - target) point of the highs.
  const askRaw = quantile(highs, 1 - target);
  if (bidRaw == null || askRaw == null) return null;
  // Rounded outward: a bid rounds DOWN and an ask rounds UP, so rounding never quietly makes the
  // trade look better than the prices you would actually place.
  const bid = Math.floor(bidRaw);
  const ask = Math.ceil(askRaw);

  const buyFillRate = lows.filter((v) => v <= bid).length / lows.length;
  const sellFillRate = highs.filter((v) => v >= ask).length / highs.length;

  const profitPerUnit = ask - geTax(Math.round(ask)) - bid;

  // Per-day outcomes, and the framing here matters. At a FIXED bid and ask the profit per unit is
  // a constant, so "worst day" measured that way is just the same number again -- it was, and it
  // said nothing.
  //
  // The real downside of a bought position is not a worse spread, it is the sell leg missing: you
  // hold the item and end up taking whatever the market offers instead of your ask. So the day
  // outcomes are measured as "bought at the bid, sold into that day's actual high" -- restricted
  // to days the BUY would have filled, because a day where it never did is not a losing day, it
  // is a day with no trade.
  const bought = paired.filter((p) => p.buy <= bid);
  const dayProfits = bought.map((p) => p.sell - geTax(Math.round(p.sell)) - bid);

  return {
    bid,
    ask,
    profitPerUnit,
    buyFillRate,
    sellFillRate,
    bothLegs: buyFillRate * sellFillRate,
    worstDayProfit: dayProfits.length ? Math.min(...dayProfits) : profitPerUnit,
    bestDayProfit: dayProfits.length ? Math.max(...dayProfits) : profitPerUnit,
    winDays: dayProfits.filter((v) => v > 0).length,
    // Denominator is the days the buy actually filled, not every day measured -- "4 of 5 days
    // won" has to mean four of the five days you would have been holding something.
    days: dayProfits.length,
  };
}
