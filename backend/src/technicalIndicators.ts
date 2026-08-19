import { getPriceDailyForItem, type PriceDailyRow } from "./warehouse.js";
import { CRASH_PCT, SPIKE_PCT } from "./alerts.js";
import type { ScoredItem } from "./signals.js";

// DESIGN.md §10 item 25: "Feature-store technical indicators -- EMA, SMA, MACD, RSI, Bollinger
// Bands, ATR, rolling variance/z-score, price velocity/acceleration, trend slope, buy-limit
// utilization, historical fill rate, 'time since last spike/crash', and calendar flags." Sourced
// from DuckDB's price_daily (the only table with indefinite retention, §11.2 Fix 2) rather than
// SQLite's price_history (pruned to a few days) -- classic TA periods (RSI14, MACD 12/26/9,
// Bollinger 20) are genuinely meaningless on a handful of raw ticks.
//
// "Historical fill rate" from the source item is deliberately NOT here: this app has no data on
// whether a specific offer price actually filled (Track Record logs buy-price vs. resolved price,
// not fill outcomes -- the same gap already noted against DESIGN.md item 46's execution nudge).
// Inventing one would violate the app's own "never invent data" rule. Every other field in the
// source list is real, computed from data this app already collects.
//
// Every indicator here is a plain, textbook, publicly-documented formula (SMA/EMA/RSI/MACD/
// Bollinger/ATR/OLS trend line) -- no fitted models, nothing backtested, matching §1's "no
// black box" principle. Each field is null, honestly, when there isn't enough daily history yet
// rather than computed on too few points and presented with false confidence -- same discipline
// already used for item 6's volume-anomaly baseline and item 45's realization ratio.

const MIN_DAYS_SMA_SHORT = 5;
const MIN_DAYS_SMA_LONG = 20;
const MIN_DAYS_EMA_LONG = 26;
const MIN_DAYS_MACD_SIGNAL = 35; // 26 for the MACD line to exist + ~9 more for the signal EMA to settle
const MIN_DAYS_RSI = 15; // 14 daily changes
const MIN_DAYS_BOLLINGER = 20;
const MIN_DAYS_ATR = 15; // 14 true-range samples
const MIN_DAYS_TREND = 5;
const TREND_WINDOW_DAYS = 14;

export interface MacdResult {
  macd: number;
  signal: number | null;
  histogram: number | null;
}

export interface BollingerBands {
  mid: number;
  upper: number;
  lower: number;
}

export interface CalendarFlags {
  hourUtc: number;
  dayOfWeekUtc: number; // 0 = Sunday
  isWeekendUtc: boolean;
  // OSRS updates release weekly, Wednesdays ~11:30 UTC (DESIGN.md §6.4) -- a cheap, explainable
  // flag, not a full holiday calendar (no such data source exists here -- would be invented).
  isUpdateDayUtc: boolean;
}

export interface TechnicalIndicators {
  daysAvailable: number;
  sma5: number | null;
  sma20: number | null;
  ema12: number | null;
  ema26: number | null;
  macd: MacdResult | null;
  rsi14: number | null;
  bollinger20: BollingerBands | null;
  atr14: number | null;
  velocityPct: number | null; // most recent day-over-day % change
  accelerationPct: number | null; // change in velocity vs the prior day
  trendSlopePctPerDay: number | null; // OLS slope over the trailing window, normalized to %/day
  buyLimitUtilization: number | null; // market volume relative to one player's 4h buy limit
  daysSinceCrash: number | null; // most recent day whose close moved <= CRASH_PCT vs the prior day
  daysSinceSpike: number | null; // most recent day whose close moved >= SPIKE_PCT vs the prior day
  calendar: CalendarFlags;
}

function sma(values: number[], period: number): number | null {
  if (values.length < period) return null;
  const slice = values.slice(values.length - period);
  return slice.reduce((s, v) => s + v, 0) / period;
}

// Standard EMA: seeded with the SMA of the first `period` values, then smoothed forward. Returns
// the full series (index-aligned to `values`, undefined before the seed point) since MACD needs
// the whole EMA12/EMA26 series, not just the latest value.
function emaSeries(values: number[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null);
  if (values.length < period) return out;
  const k = 2 / (period + 1);
  let prev = values.slice(0, period).reduce((s, v) => s + v, 0) / period;
  out[period - 1] = prev;
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

function computeMacd(closes: number[]): MacdResult | null {
  if (closes.length < MIN_DAYS_EMA_LONG) return null;
  const ema12 = emaSeries(closes, 12);
  const ema26 = emaSeries(closes, 26);
  const macdLine: number[] = [];
  for (let i = 0; i < closes.length; i++) {
    if (ema12[i] != null && ema26[i] != null) macdLine.push(ema12[i]! - ema26[i]!);
  }
  if (macdLine.length === 0) return null;
  const latestMacd = macdLine[macdLine.length - 1];
  if (closes.length < MIN_DAYS_MACD_SIGNAL || macdLine.length < 9) {
    return { macd: latestMacd, signal: null, histogram: null };
  }
  const signalSeries = emaSeries(macdLine, 9);
  const signal = signalSeries[signalSeries.length - 1];
  return { macd: latestMacd, signal, histogram: signal != null ? latestMacd - signal : null };
}

// Wilder's smoothing, the original/standard RSI method (distinct from a plain SMA of gains/losses).
function computeRsi(closes: number[], period = 14): number | null {
  if (closes.length < period + 1) return null;
  const changes: number[] = [];
  for (let i = 1; i < closes.length; i++) changes.push(closes[i] - closes[i - 1]);
  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 0; i < period; i++) {
    const c = changes[i];
    if (c > 0) avgGain += c;
    else avgLoss += -c;
  }
  avgGain /= period;
  avgLoss /= period;
  for (let i = period; i < changes.length; i++) {
    const c = changes[i];
    const gain = c > 0 ? c : 0;
    const loss = c < 0 ? -c : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

function computeBollinger(closes: number[], period = 20, mult = 2): BollingerBands | null {
  const mid = sma(closes, period);
  if (mid == null) return null;
  const slice = closes.slice(closes.length - period);
  const variance = slice.reduce((s, v) => s + (v - mid) ** 2, 0) / period;
  const stddev = Math.sqrt(variance);
  return { mid, upper: mid + mult * stddev, lower: mid - mult * stddev };
}

// Average True Range, Wilder's original method: true range per day is the largest of (day's
// high-low range, gap up from prior close, gap down from prior close), then smoothed the same
// way RSI's gain/loss average is.
function computeAtr(rows: PriceDailyRow[], period = 14): number | null {
  const usable = rows.filter(
    (r) => r.max_high != null && r.min_low != null && r.close_high != null,
  );
  if (usable.length < period + 1) return null;
  const trueRanges: number[] = [];
  for (let i = 1; i < usable.length; i++) {
    const cur = usable[i];
    const prevClose = usable[i - 1].close_high!;
    const highLow = cur.max_high! - cur.min_low!;
    const highPrevClose = Math.abs(cur.max_high! - prevClose);
    const lowPrevClose = Math.abs(cur.min_low! - prevClose);
    trueRanges.push(Math.max(highLow, highPrevClose, lowPrevClose));
  }
  if (trueRanges.length < period) return null;
  let atr = trueRanges.slice(0, period).reduce((s, v) => s + v, 0) / period;
  for (let i = period; i < trueRanges.length; i++) {
    atr = (atr * (period - 1) + trueRanges[i]) / period;
  }
  return atr;
}

// Ordinary least squares slope of price against day index, normalized to %/day of the window's
// mean price so a 500gp item and a 500m item are comparable.
function computeTrendSlope(closes: number[]): number | null {
  const window = closes.slice(-TREND_WINDOW_DAYS);
  if (window.length < MIN_DAYS_TREND) return null;
  const n = window.length;
  const xs = Array.from({ length: n }, (_, i) => i);
  const xMean = xs.reduce((s, v) => s + v, 0) / n;
  const yMean = window.reduce((s, v) => s + v, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (xs[i] - xMean) * (window[i] - yMean);
    den += (xs[i] - xMean) ** 2;
  }
  if (den === 0 || yMean === 0) return null;
  const slope = num / den;
  return slope / yMean;
}

function daysSinceThreshold(closes: number[], predicate: (changePct: number) => boolean): number | null {
  for (let i = closes.length - 1; i >= 1; i--) {
    const prev = closes[i - 1];
    if (!prev) continue;
    const changePct = (closes[i] - prev) / prev;
    if (predicate(changePct)) return closes.length - 1 - i;
  }
  return null;
}

function calendarFlagsNow(): CalendarFlags {
  const now = new Date();
  const dayOfWeekUtc = now.getUTCDay();
  return {
    hourUtc: now.getUTCHours(),
    dayOfWeekUtc,
    isWeekendUtc: dayOfWeekUtc === 0 || dayOfWeekUtc === 6,
    isUpdateDayUtc: dayOfWeekUtc === 3, // Wednesday
  };
}

export async function computeTechnicalIndicators(item: ScoredItem): Promise<TechnicalIndicators> {
  const rows = await getPriceDailyForItem(item.id, 90);
  const closes = rows.map((r) => r.close_high).filter((v): v is number => v != null);

  const buyLimitUtilization =
    item.buy_limit != null && item.buy_limit > 0
      ? ((item.vol_high_1h ?? 0) + (item.vol_low_1h ?? 0)) * 4 / item.buy_limit
      : null;

  const velocityPct =
    closes.length >= 2 ? (closes[closes.length - 1] - closes[closes.length - 2]) / closes[closes.length - 2] : null;
  const accelerationPct =
    closes.length >= 3
      ? velocityPct! - (closes[closes.length - 2] - closes[closes.length - 3]) / closes[closes.length - 3]
      : null;

  return {
    daysAvailable: closes.length,
    sma5: closes.length >= MIN_DAYS_SMA_SHORT ? sma(closes, 5) : null,
    sma20: closes.length >= MIN_DAYS_SMA_LONG ? sma(closes, 20) : null,
    ema12: closes.length >= 12 ? emaSeries(closes, 12).at(-1) ?? null : null,
    ema26: closes.length >= MIN_DAYS_EMA_LONG ? emaSeries(closes, 26).at(-1) ?? null : null,
    macd: computeMacd(closes),
    rsi14: closes.length >= MIN_DAYS_RSI ? computeRsi(closes) : null,
    bollinger20: closes.length >= MIN_DAYS_BOLLINGER ? computeBollinger(closes) : null,
    atr14: rows.length >= MIN_DAYS_ATR ? computeAtr(rows) : null,
    velocityPct,
    accelerationPct,
    trendSlopePctPerDay: computeTrendSlope(closes),
    buyLimitUtilization,
    daysSinceCrash: daysSinceThreshold(closes, (pct) => pct <= CRASH_PCT),
    daysSinceSpike: daysSinceThreshold(closes, (pct) => pct >= SPIKE_PCT),
    calendar: calendarFlagsNow(),
  };
}
