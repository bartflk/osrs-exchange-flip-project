import { db } from "./db.js";
import type { ScoredItem } from "./signals.js";

// Is this a good flip? One number from 0 to 100, and the four numbers behind it.
//
// AUDIT OF WHAT THIS REPLACES. The old score was
//
//     net_margin * log10(liquidity + 1) / (1 + volatility)
//
// and it had four faults, each measurable on live data rather than a matter of taste.
//
// 1. MARGIN SWALLOWED EVERYTHING. Margin spans six orders of magnitude across the catalogue, from
//    1gp to 3.5m. log10(liquidity) spans one, from 0 to about 6. Multiplying them means the second
//    term can never overturn the first, so the score was a re-sort of margin wearing a lab coat:
//    29 of its top 30 items were the same 30 as sorting by raw margin.
// 2. IT IGNORED CAPITAL. A 3.9m margin on a 1.4b Twisted bow scored enormously while returning
//    -0.28%. A 4gp margin on a 340gp blood rune is +1.2% and you may buy 25,000 of them. The old
//    score ranked the first far above the second, which is backwards for anyone with a finite
//    bankroll, which is everyone.
// 3. IT IGNORED THE BUY LIMIT AND WHETHER THE MARKET COULD FILL IT. You cannot buy 25,000 of
//    something that trades 300 an hour, and a margin you cannot fill is not income.
// 4. IT IGNORED WHETHER THE PRICES WERE REAL. Across the catalogue the mean last-trade age is over
//    five days. A spread computed from two fossils is arithmetic, not an opportunity, and the
//    single loudest example on the board is real: Antidote++(3) shows a 764% ROI because one trade
//    went through at 66k on an item that lives near 8k.
//
// WHAT REPLACES IT. Five factors, each independently in 0..1, each shown to the reader, combined
// as a WEIGHTED GEOMETRIC MEAN. Geometric, not a weighted sum, because these are conjunctive
// requirements rather than tradeable ones: a flip that cannot fill is not rescued by a fat margin,
// and a zero in any factor should take the whole score to zero rather than be averaged away.
//
//   income     0.40   what one GE slot earns per hour, log-scaled. The objective.
//   edge       0.20   return after tax, capped at 3%. A risk buffer, not the objective.
//   fill       0.18   how much of a buy-limit cycle the market can actually absorb.
//   freshness  0.14   how recent the two prices behind the margin are.
//   stability  0.08   whether this spread is normal for this item, and how calm the price is.
//
// The score is deliberately NOT bankroll-aware. It is a property of the item, so two people with
// different bankrolls see the same ranking; what your money does with it is the separate
// gp-per-hour figure, reported next to it rather than folded in.
//
// It is also not backtested. The app logs its own recommendations and resolves them later
// (scorekeeping.ts), so this can eventually be checked against outcomes, but nothing here is
// fitted to anything: every constant below is a stated judgement with a stated reason, which is
// worth more than a fitted number whose reason nobody can reconstruct.

const SPREAD_WINDOW_SECONDS = 24 * 60 * 60;
const MIN_SPREAD_SAMPLES = 12;

/** Median spread as a fraction of the buy price, per item, over the last day. */
const spreadNormCache = new Map<number, number>();

// AVG rather than a true median: SQLite has no median aggregate, and a second pass to compute one
// over 745,000 rows would cost more than the difference is worth for a factor that only ever
// scales a score. The outlier it exists to catch is 5x to 50x the norm, not 1.2x.
const spreadStmt = db.prepare(`
  SELECT item_id, AVG(CAST(high - low AS REAL) / low) AS mean_spread, COUNT(*) AS n
  FROM price_history
  WHERE ts > ? AND high IS NOT NULL AND low IS NOT NULL AND low > 0 AND high >= low
  GROUP BY item_id
  HAVING n >= ?
`);

export function refreshSpreadNorms(): number {
  const cutoff = Math.floor(Date.now() / 1000) - SPREAD_WINDOW_SECONDS;
  const rows = spreadStmt.all(cutoff, MIN_SPREAD_SAMPLES) as unknown as {
    item_id: number;
    mean_spread: number;
  }[];
  spreadNormCache.clear();
  for (const r of rows) {
    if (r.mean_spread > 0) spreadNormCache.set(r.item_id, r.mean_spread);
  }
  return spreadNormCache.size;
}

/** Null when this item has too little local history to have a normal spread yet. */
export function getSpreadNorm(itemId: number): number | null {
  return spreadNormCache.get(itemId) ?? null;
}

export interface FlipScore {
  /** 0 to 100. Comparable across items, and 0 means at least one factor was disqualifying. */
  score: number;
  /** Money one GE slot earns per hour on this flip, log-scaled against a 2m/hr ceiling. */
  income: number;
  /** Return after tax over the buy price, scaled against a 3% ceiling. */
  edge: number;
  /** How much of one buy-limit cycle the market can actually absorb. */
  fill: number;
  /** How recent the two prices behind the margin are. */
  freshness: number;
  /** How normal this spread is for this item, and how calm the price has been. */
  stability: number;
  /** Units of one 4-hour buy-limit cycle the market can realistically fill. */
  expectedUnits: number;
  /** Profit from one filled cycle, after tax. Not bankroll-aware. */
  cycleProfit: number;
  /** That cycle spread over the 4 hours it takes, which is the comparable income figure. */
  gpPerHour: number;
  /** Capital one full cycle ties up. */
  cycleCapital: number;
  /** The factor that cost this item the most, named, or null when nothing stands out. */
  weakest: string | null;
}

/**
 * A 3% return after tax is full marks on the edge factor.
 *
 * Edge is here as a RISK BUFFER, not as the objective. A 0.2% margin is erased by a single tick of
 * adverse movement while your offer sits, and no amount of volume makes that safe; past about 3%
 * the extra cushion stops mattering, so it caps rather than continuing to reward. The freak 764%
 * print on a dead item gets exactly the same edge credit as an honest 3% one, and then loses the
 * score everywhere else.
 */
const EDGE_CEILING = 0.03;

/**
 * The objective: gp per hour that one Grand Exchange slot earns.
 *
 * This is the correction to the first version of this score, which ranked purely on rate of
 * return and put a flip earning 32k an hour above one earning 4.1m. Rate of return is the right
 * objective when CAPITAL is the binding constraint. In this game it usually is not: you have eight
 * GE slots and a buy limit per item per four hours, so what you are really allocating is slots,
 * and the thing to maximise per slot is money, not percentage.
 *
 * Log-scaled deliberately. Income spans six orders of magnitude across the catalogue and a linear
 * term would make this a re-sort of gp/hr, which is the exact failure of the score this replaces.
 * The compression is not a loss of information because gp/hr is printed in its own column: the
 * rank answers "is this a good flip", the column answers "how big is it".
 */
const INCOME_CEILING = 2_000_000;

/** Prices older than this are increasingly likely to be describing a market that has moved. */
const FRESHNESS_HALF_LIFE_SECONDS = 30 * 60;

const WEIGHTS = { income: 0.4, edge: 0.2, fill: 0.18, freshness: 0.14, stability: 0.08 };

const CYCLE_HOURS = 4;

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

export function scoreFlip(item: ScoredItem): FlipScore {
  const margin = item.net_margin;
  const buyPrice = item.low;
  const empty: FlipScore = {
    score: 0,
    income: 0,
    edge: 0,
    fill: 0,
    freshness: 0,
    stability: 0,
    expectedUnits: 0,
    cycleProfit: 0,
    gpPerHour: 0,
    cycleCapital: 0,
    weakest: "no price",
  };
  if (margin == null || buyPrice == null || buyPrice <= 0) return empty;

  // --- edge ---------------------------------------------------------------------------------
  // A negative margin is not a small opportunity, it is not one at all, so it floors at zero
  // rather than going negative and being rescued by another factor.
  const roi = margin / buyPrice;
  const edge = clamp01(roi / EDGE_CEILING);

  // --- fill ---------------------------------------------------------------------------------
  // What one cycle can actually absorb: the GE limit, or what the market trades in four hours,
  // whichever is smaller. `liquidity` is already the thinner side of the last hour, so it counts
  // the side that will actually hold you up.
  const limit = item.buy_limit ?? 0;
  const marketPerCycle = item.liquidity * CYCLE_HOURS;
  const expectedUnits = limit > 0 ? Math.min(limit, marketPerCycle) : marketPerCycle;
  // Scored as the fraction of the limit the market can fill. An item with no limit at all is
  // judged on the market alone, against a nominal cycle, since there is no cap to compare to.
  const fill = limit > 0 ? clamp01(marketPerCycle / limit) : clamp01(marketPerCycle / 1000);

  // --- freshness ----------------------------------------------------------------------------
  // The OLDER side, because a margin is the gap between two prices and is only as current as the
  // staler of them. Exponential decay rather than a cliff: a 31-minute-old price is not
  // categorically worse than a 29-minute-old one.
  const ages = [item.buy_age, item.sell_age].filter((a): a is number => a != null);
  const worstAge = ages.length ? Math.max(...ages) : null;
  const freshness =
    worstAge == null ? 0 : Math.exp(-worstAge / FRESHNESS_HALF_LIFE_SECONDS / Math.LN2);

  // --- stability ----------------------------------------------------------------------------
  // Two different worries, multiplied.
  //
  // The first is the one that matters: a spread far wider than this item's own normal spread is
  // almost always one stale side or a single freak print, not free money. This is the factor that
  // demotes Antidote++(3) from the top of the board without needing a hardcoded blocklist.
  const norm = getSpreadNorm(item.id);
  const currentSpread = (item.high != null ? item.high - buyPrice : 0) / buyPrice;
  const spreadRatio = norm != null && norm > 0 ? currentSpread / norm : 1;
  // Up to twice the normal spread is ordinary movement and is not penalised at all. Past that the
  // factor falls away as the ratio grows, reaching about a third by ten times normal.
  const spreadSanity = spreadRatio <= 2 ? 1 : clamp01(2 / spreadRatio);

  // The second is ordinary price volatility, which is a mild drag rather than a verdict: a
  // flipper needs some movement, and an item with no volatility data yet is not penalised at all.
  const vol = item.volatility_pct ?? 0;
  const calm = 1 / (1 + vol * 2);

  const stability = spreadSanity * calm;

  // --- income -------------------------------------------------------------------------------
  const cycleProfit = margin * expectedUnits;
  const gpPerHour = cycleProfit / CYCLE_HOURS;
  const income =
    gpPerHour <= 0 ? 0 : clamp01(Math.log10(1 + gpPerHour) / Math.log10(1 + INCOME_CEILING));

  // --- combine ------------------------------------------------------------------------------
  const factors: [string, number, number][] = [
    ["income", income, WEIGHTS.income],
    ["edge", edge, WEIGHTS.edge],
    ["fill", fill, WEIGHTS.fill],
    ["freshness", freshness, WEIGHTS.freshness],
    ["stability", stability, WEIGHTS.stability],
  ];
  let logSum = 0;
  for (const [, value, weight] of factors) {
    // A true zero would make the log negative infinity. Floored at a value low enough that a
    // zero factor still crushes the score to roughly nothing, without turning it into NaN.
    logSum += weight * Math.log(Math.max(value, 1e-4));
  }
  const score = 100 * Math.exp(logSum);

  // Which factor is holding it back, for the one-line explanation on the row. Compared by how
  // much each one drags the geometric mean, which is its weighted log, not its raw value: a 0.5
  // on a 0.35 weight costs more than a 0.4 on a 0.15 weight.
  let weakest: string | null = null;
  let worstDrag = 0;
  for (const [name, value, weight] of factors) {
    const drag = -weight * Math.log(Math.max(value, 1e-4));
    if (drag > worstDrag) {
      worstDrag = drag;
      weakest = name;
    }
  }
  // Nothing is worth naming when every factor is already good.
  if (worstDrag < 0.15) weakest = null;

  return {
    score,
    income,
    edge,
    fill,
    freshness,
    stability,
    expectedUnits,
    cycleProfit,
    gpPerHour,
    cycleCapital: buyPrice * expectedUnits,
    weakest,
  };
}
