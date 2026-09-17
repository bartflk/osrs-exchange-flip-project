import type { TimeseriesPoint } from "./api";
import { geTax, quantile } from "./fillPricing";

// The two prices worth parking an offer at today, drawn as horizontal lines across the chart.
//
// Direct request: "give me a bottom horizontal line for both buy and sell best price for the
// whole day", with the important qualifier that these are NOT the day's extremes. The reasoning,
// in the requester's words: "if you skim off a very very small margin off you will get the fills,
// but also skim a little bit off the profit and you will be able to sell."
//
// That is the whole design. The single lowest low of the day is a price that printed once and
// mostly just sits there unfilled; parking a buy offer at it is a decision to not trade. So the
// buy line sits slightly ABOVE the day's floor and the sell line slightly BELOW its ceiling --
// each giving up a sliver of margin in exchange for a price the market actually revisited.
//
// Quantiles rather than a fixed percentage skim, because a fixed skim is a number with no
// grounding: 0.5% is most of the range on a tight staple and a rounding error on a volatile ring.
// A quantile is a claim about observed history ("a tenth of the day traded at or below this"),
// so it self-scales to the item and can be checked against the chart it is drawn on.
const BUY_Q = 0.1;
const SELL_Q = 0.9;

// Below this there is not enough of a day to characterise. The 24h series is 5-minute steps, so
// a normal day is ~288 points; a couple of dozen is a thin but real sample, and single digits is
// an item that barely traded, where a quantile would be reporting noise as a level.
const MIN_SAMPLES = 12;

export interface DayLevels {
  /** What to bid: 10th percentile of the day's low prints. */
  buy: number;
  /** What to ask: 90th percentile of the day's high prints. */
  sell: number;
  /** The day's true floor and ceiling, for the tooltip -- how much the skim gave up. */
  floor: number;
  ceiling: number;
  /** GE tax owed on a sale at `sell`. */
  tax: number;
  /** sell - buy - tax. Negative means the skimmed pair is not a trade. */
  netMargin: number;
  /** netMargin as a fraction of the buy price. */
  roiPct: number;
  samples: number;
}

/**
 * Levels from the last 24h of 5-minute steps.
 *
 * Always fed the 24h series regardless of which lookback the chart is showing, so "day best" means
 * one fixed thing on every zoom level. On a 30d chart the pair reads as a narrow band through the
 * middle, which is still the useful question: where does today sit inside the month.
 */
export function computeDayLevels(points: TimeseriesPoint[]): DayLevels | null {
  const lows = points.map((p) => p.avgLowPrice).filter((v): v is number => v != null && v > 0);
  const highs = points.map((p) => p.avgHighPrice).filter((v): v is number => v != null && v > 0);
  const samples = Math.min(lows.length, highs.length);
  if (samples < MIN_SAMPLES) return null;

  // Rounded to integers: these are prices you type into an offer box, and the GE has no
  // fractional gp. Buy rounds UP and sell rounds DOWN so rounding always costs the skim a
  // fraction rather than quietly handing back margin the quantile did not actually find.
  const buy = Math.ceil(quantile(lows, BUY_Q)!);
  const sell = Math.floor(quantile(highs, SELL_Q)!);
  const tax = geTax(sell);

  return {
    buy,
    sell,
    floor: Math.min(...lows),
    ceiling: Math.max(...highs),
    tax,
    netMargin: sell - buy - tax,
    roiPct: buy > 0 ? (sell - buy - tax) / buy : 0,
    samples,
  };
}
