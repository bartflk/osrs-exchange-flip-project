import { getRecentHistoryForItem } from "./db.js";

// Forward price bands from this item's own recent behaviour. DESIGN.md §14.12.
//
// NOT a trained model and not a prediction of direction. It answers one question: if this item
// keeps behaving the way it has been behaving, where is its price likely to sit tonight? The
// bands are empirical quantiles of its own returns, projected forward. Nothing is fitted.
//
// The first version of this produced a FLAT LINE on every item, which is what prompted the
// rewrite. Three faults, compounding:
//
// 1. It measured returns between raw price_history ticks, which land about every five minutes.
//    At that cadence a 212m item does not re-price: 74% of Torva full helm's consecutive ticks
//    were EXACTLY zero, so its 25th and 75th percentile returns were both 0.00% and the band had
//    no width at all. The IQR was measuring polling cadence, not volatility.
// 2. It labelled each of those five-minute steps as 30 minutes and ran 48 of them, calling the
//    result "~24h". The horizon was really four hours of scaling stretched across a day-wide axis.
// 3. It scaled BOTH band edges by sqrt(step). Spread grows with the square root of time; drift
//    grows linearly. Applying sqrt to a drifting item bends the whole band the wrong way.
//
// All three are fixed by resampling to fixed buckets the size of the forecast step, working in log
// space, and separating the median (drift, scales with t) from the quantile deviations around it
// (spread, scales with sqrt t). Resampled to 30 minutes, Torva's zero share falls from 74% to 27%
// and its 10th/90th percentiles open to -1.03%/+0.87%.

export interface ForecastPoint {
  timestamp: number;
  /** Median path: where the price sits if the item keeps drifting as it has been. */
  mid: number;
  /** Inner band, 25th to 75th percentile. Roughly half of outcomes. */
  low: number;
  high: number;
  /** Outer band, 10th to 90th percentile. Roughly eight outcomes in ten. */
  outerLow: number;
  outerHigh: number;
}

export interface ForecastResult {
  points: ForecastPoint[];
  /** Resampled steps the bands were built from, not raw ticks. */
  historicalSamples: number;
  stepMinutes: number;
  horizonHours: number;
  /**
   * Share of resampled steps where the price did not move at all.
   *
   * Surfaced rather than hidden because it is the single number that says how much to trust the
   * band. Above about half, the quantiles are describing an item that mostly sits still, and the
   * inner band will be narrow for that reason rather than because the price is stable.
   */
  flatShare: number;
  /** Median drift per step, as a fraction. Negative means it has been falling. */
  driftPerStep: number;
}

const STEP_MINUTES = 30;
const STEP_SECONDS = STEP_MINUTES * 60;
const HORIZON_STEPS = 48; // 24h at the step size above, and now actually 24h
// price_history retains about three days, which is 144 half-hour buckets at best. Asking for more
// raw ticks than that costs nothing and protects against a denser future poll.
const MAX_RAW_TICKS = 5000;
// Below this the quantiles are being read off a handful of points and the band is decoration.
const MIN_STEPS = 12;

function quantile(sorted: number[], q: number): number {
  const idx = (sorted.length - 1) * q;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

export function computeForecast(itemId: number, currentPrice: number): ForecastResult | null {
  if (currentPrice <= 0) return null;
  const history = getRecentHistoryForItem(itemId, MAX_RAW_TICKS);
  if (history.length < 2) return null;

  // Last price observed in each fixed bucket. Buckets rather than raw ticks is the whole fix:
  // a step has to be the same length as the step being forecast, or the quantiles describe a
  // different question from the one being asked.
  const buckets = new Map<number, number>();
  for (const row of history) {
    if (row.high == null || row.high <= 0) continue;
    buckets.set(Math.floor(row.ts / STEP_SECONDS), row.high);
  }

  const keys = [...buckets.keys()].sort((a, b) => a - b);
  const logReturns: number[] = [];
  for (let i = 1; i < keys.length; i++) {
    // Adjacent buckets only. A gap means the poller was down, and treating a six-hour hole as one
    // 30-minute step would import that outage into the volatility estimate as a huge fake move.
    if (keys[i] - keys[i - 1] !== 1) continue;
    const prev = buckets.get(keys[i - 1])!;
    const cur = buckets.get(keys[i])!;
    logReturns.push(Math.log(cur / prev));
  }
  if (logReturns.length < MIN_STEPS) return null;

  const sorted = [...logReturns].sort((a, b) => a - b);
  // Log space throughout: returns compound, and exponentiating at the end cannot produce a
  // negative price the way adding scaled percentages can.
  const drift = quantile(sorted, 0.5);
  const q25 = quantile(sorted, 0.25) - drift;
  const q75 = quantile(sorted, 0.75) - drift;
  const q10 = quantile(sorted, 0.1) - drift;
  const q90 = quantile(sorted, 0.9) - drift;

  const flat = logReturns.filter((r) => r === 0).length;
  const now = Math.floor(Date.now() / 1000);
  const points: ForecastPoint[] = [];

  for (let step = 1; step <= HORIZON_STEPS; step++) {
    // Drift accumulates with time, spread with its square root. That difference is the reason a
    // trending item's band leans in the direction it has been going instead of fanning symmetrically
    // around a level it has already left.
    const centre = drift * step;
    const spread = Math.sqrt(step);
    const at = (dev: number) => currentPrice * Math.exp(centre + dev * spread);
    points.push({
      timestamp: now + step * STEP_SECONDS,
      mid: at(0),
      low: at(q25),
      high: at(q75),
      outerLow: at(q10),
      outerHigh: at(q90),
    });
  }

  return {
    points,
    historicalSamples: logReturns.length,
    stepMinutes: STEP_MINUTES,
    horizonHours: (HORIZON_STEPS * STEP_MINUTES) / 60,
    flatShare: flat / logReturns.length,
    driftPerStep: Math.expm1(drift),
  };
}
