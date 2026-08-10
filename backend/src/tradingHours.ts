import { fetchTimeseries } from "./wiki.js";
import { kvGetFresh, kvSet } from "./db.js";
import { geTax } from "./signals.js";

// DESIGN.md §14.43: "what time of day is this item cheapest to buy and dearest to sell".
//
// Source is the Wiki API's `lookback=7d` series (168 hourly points, all 24 hours covered across
// 7 days -- see the granularity table in wiki.ts), NOT this app's own price_history. That
// distinction is the whole feature: local history only exists for the hours the backend happened
// to be running, which on this install is 10 of 24 hours -- and identically for every item, which
// is the giveaway that it measures uptime rather than the market. Deriving "best hour to buy"
// from it would produce a confident, well-formatted, completely meaningless number.
//
// 7 days is the ceiling, not a choice: 30d drops to 6-hour granularity (4 distinct hours of the
// day), so there is no longer hourly window available on this API version. Seven samples per hour
// is thin, which is why the reliability gate below exists rather than always returning an answer.
//
// Method, deliberately simple and fully explainable (§1: no ML, no fitted models):
//   1. Group the hourly points by UTC calendar day.
//   2. Within each day, express every hour's price as a % deviation from THAT DAY's mean.
//   3. Average each hour-of-day's deviation across all days.
//
// Step 2 is the one that matters. Without it a trending item makes late hours look systematically
// "expensive" purely because the price rose over the fortnight -- you'd be reading the trend and
// calling it a daily rhythm. Detrending per day removes the level and leaves only the shape.

const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const MIN_DAYS_PER_HOUR = 5; // below this an hour's average is one or two readings, i.e. noise
const MIN_HOURS_COVERED = 20; // out of 24
// A daily swing smaller than this is indistinguishable from ordinary tick noise for most items,
// and calling it a "best time to trade" would be false precision.
const MEANINGFUL_SWING_PCT = 0.004; // 0.4%

export interface HourProfile {
  hourUtc: number;
  /** Mean % deviation of the insta-buy (low) price from that day's average. Negative = cheaper. */
  buyDeviation: number | null;
  /** Mean % deviation of the insta-sell (high) price from that day's average. */
  sellDeviation: number | null;
  /** Mean units traded in this hour, both directions. */
  volume: number;
  /** How many distinct days contributed to this hour. */
  days: number;
}

export interface TradingHours {
  itemId: number;
  hours: HourProfile[];
  bestBuyHourUtc: number | null;
  bestSellHourUtc: number | null;
  /** Round-trip edge from timing alone: sell-high deviation minus buy-low deviation, after tax. */
  timingEdgePct: number | null;
  /**
   * Hours you'd have to hold to go from the best buy hour to the next best sell hour, wrapping
   * past midnight. Surfaced because the edge above is NOT free: a "buy 08:00, sell 07:00" pair
   * reads like a quick flip and is actually a 23-hour hold, with all the price risk that implies.
   * Quoting the edge without the hold would make timing look far better than it is.
   */
  holdHours: number | null;
  busiestHourUtc: number | null;
  quietestHourUtc: number | null;
  daysCovered: number;
  hoursCovered: number;
  /** False when the swing is too small or the sample too thin to make a claim. */
  reliable: boolean;
  caveat: string | null;
}

interface DayBucket {
  prices: { hour: number; low: number | null; high: number | null }[];
}

export async function computeTradingHours(itemId: number): Promise<TradingHours> {
  // Version the key, don't just name it. Found live: adding `holdHours` to the result shape left
  // every cached entry serving the old object, so the UI rendered an empty value for hours after
  // the field shipped -- a silent, confusing failure rather than an obvious one. Bump this
  // whenever TradingHours gains or changes a field.
  const cacheKey = `tradingHours:v2:${itemId}`;
  const cached = kvGetFresh<TradingHours>(cacheKey, CACHE_TTL_MS);
  if (cached) return cached;

  const points = await fetchTimeseries(itemId, "7d");

  // --- group by UTC day -----------------------------------------------------------------------
  const days = new Map<string, DayBucket>();
  const volumeByHour = new Map<number, { total: number; n: number }>();

  for (const p of points) {
    const d = new Date(p.timestamp * 1000);
    const dayKey = d.toISOString().slice(0, 10);
    const hour = d.getUTCHours();

    let bucket = days.get(dayKey);
    if (!bucket) {
      bucket = { prices: [] };
      days.set(dayKey, bucket);
    }
    bucket.prices.push({ hour, low: p.avgLowPrice, high: p.avgHighPrice });

    const vol = (p.highPriceVolume ?? 0) + (p.lowPriceVolume ?? 0);
    const v = volumeByHour.get(hour) ?? { total: 0, n: 0 };
    v.total += vol;
    v.n += 1;
    volumeByHour.set(hour, v);
  }

  // --- per-day detrending ---------------------------------------------------------------------
  const buyDevs = new Map<number, number[]>();
  const sellDevs = new Map<number, number[]>();

  for (const bucket of days.values()) {
    const lows = bucket.prices.map((p) => p.low).filter((v): v is number => v != null && v > 0);
    const highs = bucket.prices.map((p) => p.high).filter((v): v is number => v != null && v > 0);
    // A day with only a couple of readings has no meaningful "daily mean" to deviate from.
    if (lows.length < 6 || highs.length < 6) continue;

    const lowMean = lows.reduce((s, v) => s + v, 0) / lows.length;
    const highMean = highs.reduce((s, v) => s + v, 0) / highs.length;

    for (const p of bucket.prices) {
      if (p.low != null && p.low > 0 && lowMean > 0) {
        const arr = buyDevs.get(p.hour) ?? [];
        arr.push((p.low - lowMean) / lowMean);
        buyDevs.set(p.hour, arr);
      }
      if (p.high != null && p.high > 0 && highMean > 0) {
        const arr = sellDevs.get(p.hour) ?? [];
        arr.push((p.high - highMean) / highMean);
        sellDevs.set(p.hour, arr);
      }
    }
  }

  const mean = (a: number[]) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : null);

  const hours: HourProfile[] = [];
  for (let h = 0; h < 24; h++) {
    const b = buyDevs.get(h) ?? [];
    const s = sellDevs.get(h) ?? [];
    const v = volumeByHour.get(h);
    hours.push({
      hourUtc: h,
      buyDeviation: b.length >= MIN_DAYS_PER_HOUR ? mean(b) : null,
      sellDeviation: s.length >= MIN_DAYS_PER_HOUR ? mean(s) : null,
      volume: v && v.n > 0 ? Math.round(v.total / v.n) : 0,
      days: b.length,
    });
  }

  // --- pick the extremes ----------------------------------------------------------------------
  const usableBuy = hours.filter((h) => h.buyDeviation != null);
  const usableSell = hours.filter((h) => h.sellDeviation != null);
  const hoursCovered = Math.max(usableBuy.length, usableSell.length);
  const daysCovered = days.size;

  let bestBuyHourUtc: number | null = null;
  let bestSellHourUtc: number | null = null;
  let timingEdgePct: number | null = null;

  if (usableBuy.length) {
    bestBuyHourUtc = usableBuy.reduce((a, b) => (b.buyDeviation! < a.buyDeviation! ? b : a)).hourUtc;
  }
  if (usableSell.length) {
    bestSellHourUtc = usableSell.reduce((a, b) =>
      b.sellDeviation! > a.sellDeviation! ? b : a,
    ).hourUtc;
  }

  const buySwing = usableBuy.length
    ? Math.max(...usableBuy.map((h) => h.buyDeviation!)) -
      Math.min(...usableBuy.map((h) => h.buyDeviation!))
    : 0;
  const sellSwing = usableSell.length
    ? Math.max(...usableSell.map((h) => h.sellDeviation!)) -
      Math.min(...usableSell.map((h) => h.sellDeviation!))
    : 0;

  if (bestBuyHourUtc != null && bestSellHourUtc != null) {
    const buyDev = hours[bestBuyHourUtc].buyDeviation!;
    const sellDev = hours[bestSellHourUtc].sellDeviation!;
    // Gross timing edge, then taxed: 2% comes off the sale regardless of how well you timed it,
    // so quoting the pre-tax figure would overstate what timing is actually worth.
    const gross = sellDev - buyDev;
    timingEdgePct = gross * (1 - geTax(10_000) / 10_000);
  }

  // Wraps past midnight: buying at 20:00 and selling at 04:00 is an 8-hour hold, not -16.
  let holdHours: number | null = null;
  if (bestBuyHourUtc != null && bestSellHourUtc != null) {
    holdHours = (bestSellHourUtc - bestBuyHourUtc + 24) % 24;
    if (holdHours === 0) holdHours = 24;
  }

  const busiest = hours.reduce((a, b) => (b.volume > a.volume ? b : a));
  const withVolume = hours.filter((h) => h.volume > 0);
  const quietest = withVolume.length
    ? withVolume.reduce((a, b) => (b.volume < a.volume ? b : a))
    : null;

  // --- honesty gate ---------------------------------------------------------------------------
  let reliable = true;
  let caveat: string | null = null;
  if (hoursCovered < MIN_HOURS_COVERED) {
    reliable = false;
    caveat = `Only ${hoursCovered} of 24 hours have enough data — not enough to call a best time.`;
  } else if (Math.max(buySwing, sellSwing) < MEANINGFUL_SWING_PCT) {
    reliable = false;
    caveat = `This item's price barely moves by hour (swing under ${(MEANINGFUL_SWING_PCT * 100).toFixed(1)}%) — timing it isn't worth much.`;
  } else if (daysCovered < 6) {
    // 7 days is the API's maximum hourly window, so this fires only when an item genuinely has
    // gaps (thin trading), not merely because the window is short.
    reliable = false;
    caveat = `Only ${daysCovered} days of hourly data — too thin to call a pattern.`;
  }

  const result: TradingHours = {
    itemId,
    hours,
    bestBuyHourUtc,
    bestSellHourUtc,
    timingEdgePct,
    holdHours,
    busiestHourUtc: busiest.volume > 0 ? busiest.hourUtc : null,
    quietestHourUtc: quietest ? quietest.hourUtc : null,
    daysCovered,
    hoursCovered,
    reliable,
    caveat,
  };

  kvSet(cacheKey, JSON.stringify(result));
  return result;
}
