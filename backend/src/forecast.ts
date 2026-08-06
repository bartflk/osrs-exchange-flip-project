import { getRecentHistoryForItem } from "./db.js";

// DESIGN.md §14.12 / message 8 "Prediction Bands": IQR-style forecast -- NOT a trained model.
// Takes the trailing empirical distribution of this item's own period-over-period % returns
// from price_history, and projects the current price forward using random-walk variance
// scaling (band width grows with sqrt(stepsAhead), the standard result for a sum of i.i.d.
// steps). The only assumption made is "recent volatility is a reasonable guide to near-term
// volatility" -- not that future price *levels* are predictable. Pure descriptive statistics
// (quantiles), no fitting/training, matching the "deterministic quant engine first" ordering.
export interface ForecastPoint {
  timestamp: number;
  mid: number;
  low: number;
  high: number;
}

export interface ForecastResult {
  points: ForecastPoint[];
  historicalSamples: number;
}

const TRAILING_SAMPLES = 200; // how many recent history ticks to build the return distribution from
const MIN_SAMPLES = 20; // don't forecast off a handful of ticks
// price_history ticks land whenever the underlying 5m-average changes (roughly every few
// minutes in practice, not a fixed cadence) -- treating each tick-to-tick return as one "step"
// and labeling steps 30 minutes apart is an approximation, not a precise resampling. Good enough
// for a first deterministic pass; a real fixed-cadence resample would need price_daily-style
// bucketing, not worth the complexity before this has proven useful.
const STEP_SECONDS = 30 * 60;
const HORIZON_STEPS = 48; // ~24h ahead at the approximate 30-min step size above

function quantile(sorted: number[], q: number): number {
  const idx = (sorted.length - 1) * q;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

export function computeForecast(itemId: number, currentPrice: number): ForecastResult | null {
  if (currentPrice <= 0) return null;
  const history = getRecentHistoryForItem(itemId, TRAILING_SAMPLES + 1);
  if (history.length < MIN_SAMPLES) return null;

  const returns: number[] = [];
  for (let i = 1; i < history.length; i++) {
    const prev = history[i - 1].high;
    const cur = history[i].high;
    if (prev != null && cur != null && prev > 0) returns.push((cur - prev) / prev);
  }
  if (returns.length < MIN_SAMPLES) return null;

  const sorted = [...returns].sort((a, b) => a - b);
  const stepLow = quantile(sorted, 0.25);
  const stepHigh = quantile(sorted, 0.75);

  const now = Math.floor(Date.now() / 1000);
  const points: ForecastPoint[] = [];
  for (let step = 1; step <= HORIZON_STEPS; step++) {
    const scale = Math.sqrt(step);
    const a = currentPrice * (1 + stepLow * scale);
    const b = currentPrice * (1 + stepHigh * scale);
    const low = Math.max(0, Math.min(a, b));
    const high = Math.max(0, Math.max(a, b));
    points.push({
      timestamp: now + step * STEP_SECONDS,
      mid: (low + high) / 2,
      low,
      high,
    });
  }

  return { points, historicalSamples: returns.length };
}
