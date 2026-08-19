import { db } from "./db.js";
import { geTax } from "./signals.js";
import type { ScoredItem } from "./signals.js";

// DESIGN.md §10 items 36-45 ("More indicators.txt" brainstorm, 2026-08-06): a bundle of
// deterministic, per-item indicators computed on demand (item detail modal only, not baked into
// every /api/items poll -- these query price_history directly and aren't cheap enough for ~4,600
// items every 60s). Every number here is real, computed from data already in this app; nothing
// is fabricated. Several ideas from the source doc (Player Count Correlation, the player-count
// half of Bot Pressure) are NOT here -- see DESIGN.md's status note for why.

const HISTORY_WINDOW_SECONDS = 14 * 24 * 60 * 60; // matches the raw retention window (rollup.ts, §14.35)
const MIN_SAMPLES = 20;

interface HistoryRow {
  ts: number;
  high: number | null;
  low: number | null;
  vol_high_5m: number | null;
  vol_low_5m: number | null;
}

const historyStmt = db.prepare(`
  SELECT ts, high, low, vol_high_5m, vol_low_5m
  FROM price_history
  WHERE item_id = ? AND ts > ?
  ORDER BY ts ASC
`);

export type BuyPressure = "bullish" | "bearish" | "neutral";
export type MeanReversionSignal = "oversold" | "overbought" | "neutral";
export type SupplyDemandShock = "supply_shock" | "demand_shock" | "none";
export type FlipSaturation = "low" | "moderate" | "high" | "unknown";

export interface IndicatorBundle {
  liquidityScore: number; // 0-100, log-scaled trades/hr
  buyPressure: BuyPressure;
  buyPressureRatio: number | null; // vol_low/vol_high over 1h -- >1 more buying than selling
  spreadStabilityScore: number | null; // 0-100, higher = more consistent margin, null = not enough history
  meanReversionZ: number | null; // current price vs trailing mean, in std deviations
  meanReversionSignal: MeanReversionSignal;
  supplyDemandShock: SupplyDemandShock;
  flipSaturation: FlipSaturation;
  opportunityScore: number; // 0-100 composite of the above -- not backtested, see DESIGN.md caveat
  sampleSize: number; // raw ticks the history-dependent indicators drew on
}

// log-scale so a jump from 5/hr to 50/hr matters more than 5,000/hr to 5,050/hr -- matches the
// same "diminishing returns on liquidity" shape signals.ts already uses (Math.log10 in scoreItem).
const LIQUIDITY_CEILING = 10_000;
function liquidityScore(liquidity: number): number {
  if (liquidity <= 0) return 0;
  return Math.min(100, Math.round((Math.log10(liquidity + 1) / Math.log10(LIQUIDITY_CEILING + 1)) * 100));
}

function buyPressureFrom(item: ScoredItem): { pressure: BuyPressure; ratio: number | null } {
  const buyVol = item.vol_low_1h; // items bought by players (filling sell offers)
  const sellVol = item.vol_high_1h; // items sold by players (filling buy offers)
  if (!buyVol && !sellVol) return { pressure: "neutral", ratio: null };
  if (!sellVol) return { pressure: "bullish", ratio: null };
  const ratio = buyVol / sellVol;
  if (ratio > 1.15) return { pressure: "bullish", ratio };
  if (ratio < 0.87) return { pressure: "bearish", ratio };
  return { pressure: "neutral", ratio };
}

function flipSaturationFrom(
  marginNow: number | null,
  marginThen: number | null,
  volumeNow: number,
  volumeThen: number,
): FlipSaturation {
  if (marginNow == null || marginThen == null || marginThen <= 0) return "unknown";
  const marginChangePct = (marginNow - marginThen) / marginThen;
  const volumeChangePct = volumeThen > 0 ? (volumeNow - volumeThen) / volumeThen : 0;
  // Classic saturation signature: margin shrinking while volume rises -- more people flipping
  // the same edge until it's competed away. Matches "More indicators.txt" item 7's definition.
  if (marginChangePct < -0.15 && volumeChangePct > 0.2) return "high";
  if (marginChangePct < -0.05 && volumeChangePct > 0) return "moderate";
  return "low";
}

export function computeIndicatorBundle(item: ScoredItem): IndicatorBundle {
  const cutoff = Math.floor(Date.now() / 1000) - HISTORY_WINDOW_SECONDS;
  const rows = historyStmt.all(item.id, cutoff) as unknown as HistoryRow[];

  const { pressure: buyPressure, ratio: buyPressureRatio } = buyPressureFrom(item);

  let spreadStabilityScore: number | null = null;
  let meanReversionZ: number | null = null;
  let meanReversionSignal: MeanReversionSignal = "neutral";
  let supplyDemandShock: SupplyDemandShock = "none";

  const usable = rows.filter((r) => r.high != null && r.low != null && r.high > 0);
  if (usable.length >= MIN_SAMPLES) {
    // Spread stability: coefficient of variation of (high-low)/low across the window -- a
    // consistent margin scores near 100, a margin that swings wildly scores low.
    const spreads = usable.map((r) => (r.high! - r.low!) / r.low!);
    const spreadMean = spreads.reduce((s, v) => s + v, 0) / spreads.length;
    if (spreadMean > 0) {
      const spreadVariance =
        spreads.reduce((s, v) => s + (v - spreadMean) ** 2, 0) / spreads.length;
      const spreadCoV = Math.sqrt(spreadVariance) / spreadMean;
      spreadStabilityScore = Math.max(0, Math.round(100 - Math.min(100, spreadCoV * 60)));
    }

    // Mean reversion: current high vs trailing mean, in std deviations of the same window.
    const highs = usable.map((r) => r.high!);
    const highMean = highs.reduce((s, v) => s + v, 0) / highs.length;
    const highVariance = highs.reduce((s, v) => s + (v - highMean) ** 2, 0) / highs.length;
    const highStddev = Math.sqrt(highVariance);
    if (highStddev > 0 && item.high != null) {
      meanReversionZ = (item.high - highMean) / highStddev;
      if (meanReversionZ <= -1) meanReversionSignal = "oversold";
      else if (meanReversionZ >= 1) meanReversionSignal = "overbought";
    }

    // Supply/demand shock: compare the most recent quarter of the window's avg volume to the
    // rest, cross-referenced with price direction over the same split. No player-count
    // cross-check (that data source isn't wired in -- see DESIGN.md), so this is a volume+price
    // proxy, not the full three-factor version from the source material.
    const splitIdx = Math.floor(usable.length * 0.75);
    const recentRows = usable.slice(splitIdx);
    const priorRows = usable.slice(0, splitIdx);
    if (recentRows.length >= 3 && priorRows.length >= 3) {
      const avgVol = (rs: HistoryRow[]) =>
        rs.reduce((s, r) => s + (r.vol_high_5m ?? 0) + (r.vol_low_5m ?? 0), 0) / rs.length;
      const recentVol = avgVol(recentRows);
      const priorVol = avgVol(priorRows);
      const volJump = priorVol > 0 ? (recentVol - priorVol) / priorVol : 0;
      const priceChange =
        (recentRows[recentRows.length - 1].high! - priorRows[0].high!) / priorRows[0].high!;
      if (volJump > 0.5 && priceChange < -0.03) supplyDemandShock = "supply_shock";
      else if (volJump > 0.5 && priceChange > 0.03) supplyDemandShock = "demand_shock";
    }
  }

  // Flip saturation needs a "then" (start of window) margin/volume to compare against "now".
  const flipSaturation =
    usable.length >= MIN_SAMPLES
      ? flipSaturationFrom(
          item.net_margin,
          usable[0].high != null && usable[0].low != null
            ? usable[0].high - usable[0].low - geTax(usable[0].high)
            : null,
          (item.vol_high_1h ?? 0) + (item.vol_low_1h ?? 0),
          (usable[0].vol_high_5m ?? 0) + (usable[0].vol_low_5m ?? 0),
        )
      : "unknown";

  // Opportunity score: starts neutral (50), then each signal pushes it up or down. Liquidity and
  // spread stability pull proportionally toward/away from neutral (scaled, not full-weight,
  // since they're supporting context rather than the primary call); margin sign, buy pressure,
  // mean reversion, and saturation are flat bonuses/penalties. Deliberately simple and documented
  // as a heuristic, not backtested -- same honest caveat already attached to every other
  // composite/threshold in this app (Capital Allocator timeframes, §10 item 26's Risk Level sketch).
  const liqScore = liquidityScore(item.liquidity);
  const stabilityComponent = spreadStabilityScore ?? 50; // neutral prior when unknown
  const pressureBonus = buyPressure === "bullish" ? 10 : buyPressure === "bearish" ? -10 : 0;
  const reversionBonus =
    meanReversionSignal === "oversold" ? 8 : meanReversionSignal === "overbought" ? -8 : 0;
  const marginComponent = (item.net_margin ?? 0) > 0 ? 15 : -15;
  const saturationPenalty = flipSaturation === "high" ? -15 : flipSaturation === "moderate" ? -5 : 0;
  const opportunityScore = Math.max(
    0,
    Math.min(
      100,
      Math.round(
        50 +
          (liqScore - 50) * 0.3 +
          (stabilityComponent - 50) * 0.25 +
          pressureBonus +
          reversionBonus +
          marginComponent +
          saturationPenalty,
      ),
    ),
  );

  return {
    liquidityScore: liqScore,
    buyPressure,
    buyPressureRatio,
    spreadStabilityScore,
    meanReversionZ,
    meanReversionSignal,
    supplyDemandShock,
    flipSaturation,
    opportunityScore,
    sampleSize: usable.length,
  };
}
