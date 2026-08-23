import { fetchTimeseriesByStep } from "./wiki.js";
import {
  upsertSlotProfiles,
  getProfiledItems,
  countRankableItems,
  getUnbackedProfileItems,
  getMostLiquidItemIds,
  getHighValueItemIds,
  getItemsAtSlot,
  getSlotProfile,
  pruneStaleSlotProfiles,
  replaceSlotDaily,
  getPairedDays,
  type SlotDailyRow,
  kvGet,
  kvSet,
  type SlotProfileRow,
} from "./db.js";
import { NON_FLIPPABLE_IDS, geTax } from "./signals.js";
import { median } from "./stats.js";

// DESIGN.md §14.44: "best item to buy right now", by half-hour of the UTC day.
//
// §14.43 answered this for ONE item at a time. Answering it across the market needs a profile per
// item, and each profile costs one Wiki API request -- so this is a slow background job writing
// into item_slot_profile, and the ranking then reads from SQLite instantly.
//
// Granularity, probed live (see the table in wiki.ts): timestep=30m returns 365 points = 7.6 days
// at 30-minute resolution. That's the finest resolution available over a week. Four weeks at this
// resolution is NOT obtainable -- every timeseries request is capped at 365 points regardless of
// timestep. Note these rows are REPLACED on each refresh, not appended to, so the window stays
// 7.6 days -- extending it would need an append-only observations table, which is not built.

const SLOTS_PER_DAY = 48; // 30-minute slots
const REFRESH_INTERVAL_MS = 12 * 60 * 60 * 1000;
const LAST_RUN_KEY = "slotProfiles:lastRun";

// One request per item, so this is a budget, not a target. 250 covers the genuinely liquid end of
// the market -- an item that trades a handful of times a day has no time-of-day signal worth
// having, only noise dressed up as a pattern.
const MAX_ITEMS = 250;
// A second, smaller track for expensive PvM gear (Noxious halberd, Scythe, etc.) that the
// liquidity ranking above structurally excludes -- their unit volume never competes with cheap
// staples even though real gp moves through them. Still requires >=2 units/hr on both sides so a
// dead collectible doesn't get profiled on noise. Kept separate and small (60, not merged into
// the 250 budget) so the liquid track's coverage isn't diluted by adding this.
// 120, not 60: at a 300m+ bankroll the 20-30m band is squarely in range (eight Bandos
// chestplates is ~185m), and a top-60-by-price cohort bottoms out around 28m, excluding it.
const HIGH_VALUE_ITEMS = 120;
const HIGH_VALUE_MIN_VOLUME = 2;
// Deliberately unhurried. The Wiki API is free, community-run and asks for reasonable use; there
// is no deadline on a background job that refreshes twice a day.
const REQUEST_SPACING_MS = 400;
const MIN_DAYS_PER_SLOT = 4;
// §14.51: a paired buy/sell median needs enough days on BOTH slots to mean anything.
const MIN_PAIRED_DAYS = 4;
// The Wiki API caps a timeseries at 365 POINTS, not 365 days -- so "7.6 days at 30m resolution"
// only holds for an item that trades in most slots. A thin item's 365 points stretch much
// further: measured live, Armageddon teleport scroll's rows span 51 calendar days, Ankou mask 18,
// Broad arrowheads 14. Four paired days drawn from a 51-day span is not a daily rhythm, it is
// four samples taken up to seven weeks apart, and the per-day detrending that makes this method
// work cannot remove drift it never saw. Picks whose evidence is stretched that thin are rejected
// rather than ranked alongside genuinely weekly ones.
const MAX_PAIRED_SPAN_DAYS = 16;
// Matches the frontend's own default so an un-set bankroll behaves the same on both sides.
export const DEFAULT_BANKROLL = 10_000_000;
// §14.45: items that fall out of the top-MAX_ITEMS liquidity list never get refreshed again, so
// without an age limit their profiles are ranked forever against current prices. Measured: 109
// items were being recommended on 9-day-old patterns.
const MAX_PROFILE_AGE_SECONDS = 3 * 24 * 60 * 60;
const PRUNE_AGE_SECONDS = 14 * 24 * 60 * 60;

// Calendar days between the first and last paired reading, inclusive. Distinct from the COUNT of
// paired days: 4 readings can span 4 days or 51, and only the second number says whether those
// readings describe a repeating daily pattern or four scattered snapshots.
function pairedSpanDays(paired: { day: string }[]): number {
  if (paired.length === 0) return 0;
  let min = paired[0].day;
  let max = paired[0].day;
  for (const p of paired) {
    if (p.day < min) min = p.day;
    if (p.day > max) max = p.day;
  }
  const ms = Date.parse(max + "T00:00:00Z") - Date.parse(min + "T00:00:00Z");
  return Math.round(ms / 86_400_000) + 1;
}

function slotOf(date: Date): number {
  return date.getUTCHours() * 2 + (date.getUTCMinutes() >= 30 ? 1 : 0);
}

export function slotLabel(slot: number): string {
  const h = Math.floor(slot / 2);
  const m = slot % 2 === 0 ? "00" : "30";
  return `${String(h).padStart(2, "0")}:${m}`;
}

export function currentSlot(): number {
  return slotOf(new Date());
}

/**
 * Build one item's 48-slot profile from its 30-minute series.
 *
 * Same method as tradingHours.ts: each reading becomes a % deviation from its own day's mean
 * (removing trend), then slots are aggregated across days with a MEDIAN (removing outliers).
 * Skipping either step gets this badly wrong -- see stats.ts for the worked example.
 */
export async function profileItem(
  itemId: number,
): Promise<{ profile: SlotProfileRow[]; daily: SlotDailyRow[] }> {
  const points = await fetchTimeseriesByStep(itemId, "30m");
  if (!points.length) return { profile: [], daily: [] };

  // §14.51: the raw per-day readings, kept so the ranking can pair a buy slot against a sell slot
  // within the same day instead of differencing two independently-taken medians.
  const daily: SlotDailyRow[] = [];

  const byDay = new Map<string, { slot: number; low: number | null; high: number | null }[]>();
  const volume = new Map<number, { total: number; n: number }>();

  for (const p of points) {
    const d = new Date(p.timestamp * 1000);
    const dayKey = d.toISOString().slice(0, 10);
    const slot = slotOf(d);

    const list = byDay.get(dayKey) ?? [];
    list.push({ slot, low: p.avgLowPrice, high: p.avgHighPrice });
    byDay.set(dayKey, list);
    daily.push({
      item_id: itemId,
      slot,
      day: dayKey,
      low: p.avgLowPrice ?? null,
      high: p.avgHighPrice ?? null,
    });

    const v = volume.get(slot) ?? { total: 0, n: 0 };
    v.total += (p.highPriceVolume ?? 0) + (p.lowPriceVolume ?? 0);
    v.n += 1;
    volume.set(slot, v);
  }

  const buyDevs = new Map<number, number[]>();
  const sellDevs = new Map<number, number[]>();
  // §14.45: absolute gp, not just deviations. Profit is (sell*0.98 - buy)/buy in real coins;
  // it cannot be recovered from two deviations measured against two different daily means.
  const buyPrices = new Map<number, number[]>();
  const sellPrices = new Map<number, number[]>();

  for (const readings of byDay.values()) {
    const lows = readings.map((r) => r.low).filter((v): v is number => v != null && v > 0);
    const highs = readings.map((r) => r.high).filter((v): v is number => v != null && v > 0);
    // A day with only a handful of readings has no meaningful mean to deviate from.
    if (lows.length < 12 || highs.length < 12) continue;

    const lowMean = lows.reduce((s, v) => s + v, 0) / lows.length;
    const highMean = highs.reduce((s, v) => s + v, 0) / highs.length;

    for (const r of readings) {
      if (r.low != null && r.low > 0) {
        const arr = buyDevs.get(r.slot) ?? [];
        arr.push((r.low - lowMean) / lowMean);
        buyDevs.set(r.slot, arr);
        const abs = buyPrices.get(r.slot) ?? [];
        abs.push(r.low);
        buyPrices.set(r.slot, abs);
      }
      if (r.high != null && r.high > 0) {
        const arr = sellDevs.get(r.slot) ?? [];
        arr.push((r.high - highMean) / highMean);
        sellDevs.set(r.slot, arr);
        const abs = sellPrices.get(r.slot) ?? [];
        abs.push(r.high);
        sellPrices.set(r.slot, abs);
      }
    }
  }

  const now = Math.floor(Date.now() / 1000);
  const rows: SlotProfileRow[] = [];

  for (let slot = 0; slot < SLOTS_PER_DAY; slot++) {
    const b = buyDevs.get(slot) ?? [];
    const s = sellDevs.get(slot) ?? [];
    const v = volume.get(slot);
    rows.push({
      item_id: itemId,
      slot,
      buy_deviation: b.length >= MIN_DAYS_PER_SLOT ? median(b) : null,
      sell_deviation: s.length >= MIN_DAYS_PER_SLOT ? median(s) : null,
      buy_price: b.length >= MIN_DAYS_PER_SLOT ? median(buyPrices.get(slot) ?? []) : null,
      sell_price: s.length >= MIN_DAYS_PER_SLOT ? median(sellPrices.get(slot) ?? []) : null,
      volume: v && v.n > 0 ? Math.round(v.total / v.n) : 0,
      days: b.length,
      updated_at: now,
    });
  }
  return { profile: rows, daily };
}

export interface ProfileRunResult {
  attempted: number;
  profiled: number;
  failed: number;
  skipped: boolean;
}

/**
 * Refresh profiles for the most liquid items, oldest-first so an interrupted run resumes where it
 * left off rather than redoing the same head of the list every time.
 */
export async function refreshSlotProfiles(force = false): Promise<ProfileRunResult> {
  const last = kvGet(LAST_RUN_KEY);
  if (!force && last && Date.now() - Number(last.value) < REFRESH_INTERVAL_MS) {
    return { attempted: 0, profiled: 0, failed: 0, skipped: true };
  }
  kvSet(LAST_RUN_KEY, String(Date.now()));

  const liquid = getMostLiquidItemIds(MAX_ITEMS);
  const highValue = getHighValueItemIds(HIGH_VALUE_ITEMS, HIGH_VALUE_MIN_VOLUME);
  // Items whose profile has no per-day rows behind it can never produce a pick, so they go into
  // the candidate set regardless of whether they still rank as liquid or high-value -- otherwise
  // they stay broken until the 14-day prune quietly removes them.
  const unbacked = getUnbackedProfileItems();
  const candidates = [...new Set([...liquid, ...highValue, ...unbacked])];
  if (unbacked.length) {
    console.log(`[slots] ${unbacked.length} profile(s) missing per-day rows -- requeued`);
  }
  const lastSeen = new Map(getProfiledItems().map((r) => [r.item_id, r.updated_at]));
  candidates.sort((a, b) => (lastSeen.get(a) ?? 0) - (lastSeen.get(b) ?? 0));

  let profiled = 0;
  let failed = 0;
  for (const itemId of candidates) {
    try {
      const { profile, daily } = await profileItem(itemId);
      if (profile.length) {
        upsertSlotProfiles(profile);
        replaceSlotDaily(itemId, daily);
        profiled++;
      }
    } catch {
      // One item failing (404, transient 5xx) must not abort the run -- same additive principle
      // as the Reddit collector. The next pass retries it, since it stays oldest in the sort.
      failed++;
    }
    await new Promise((r) => setTimeout(r, REQUEST_SPACING_MS));
  }

  const pruned = pruneStaleSlotProfiles(Math.floor(Date.now() / 1000) - PRUNE_AGE_SECONDS);
  if (pruned) console.log(`[slots] pruned ${pruned} stale profile row(s)`);

  return { attempted: candidates.length, profiled, failed, skipped: false };
}

export interface HourlyPick {
  itemId: number;
  name: string;
  icon: string | null;
  slot: number;
  slotLabel: string;
  buyDeviation: number;
  /** Best sell slot found later in the day, and what it's worth. */
  bestSellSlot: number | null;
  bestSellSlotLabel: string | null;
  sellDeviation: number | null;
  /** Real after-tax return: (sell_price - tax - buy_price) / buy_price. §14.45. */
  timingEdgePct: number | null;
  /** The gp figures behind it, so the number can be checked rather than trusted. */
  buyPrice: number | null;
  sellPrice: number | null;
  profitPerUnit: number | null;
  /** Days where both slots had a reading -- the actual sample behind profitPerUnit. */
  pairedDays: number;
  /** How many of those days the trade would have profited. */
  winDays: number;
  holdSlots: number | null;
  holdHours: number | null;
  volume: number;
  days: number;
  price: number | null;
  buyLimit: number | null;
  /** gp per hour of hold, at full buy limit -- what makes a small % edge on a cheap item real. */
  projectedProfitPerLimit: number | null;
  // §14.46: what the ranking is actually for. A 13% edge on a 232gp dart earns 330k against a
  // 308m bankroll because the buy limit caps you at 11,000 units; a 1.65% edge on a 48m weapon
  // earns 4.7m because you can hold six of them. Percentage return is the wrong objective when
  // capital, not opportunity, is the binding constraint.
  /** Units you can actually buy: min(buy limit, bankroll / price). */
  deployableUnits: number;
  /** gp those units tie up. */
  capitalUsed: number;
  /** deployableUnits x profitPerUnit -- gp this pick earns YOUR bankroll per limit cycle. */
  cycleProfit: number;
  /** Calendar days the paired readings span. 4 days over 51 is not a weekly rhythm -- see MAX_PAIRED_SPAN_DAYS. */
  pairedSpanDays: number;
  /** Share of the slot's typical traded volume you'd have to absorb. >1 means you are the market. */
  fillShare: number | null;
  score: number;
}

/**
 * Best pick for one item, buying at `slot` and selling at the best REALISED-PROFIT slot found
 * within `maxLookaheadSlots` slots forward (wrapping past midnight). Shared by
 * `computeItemOfTheHour` (lookahead = the whole day) and `computeOvernightPicks` (lookahead
 * capped to an actual overnight hold) -- same gating, same scoring, only the search window
 * differs. See §14.45 for why this ranks by realised after-tax profit rather than a raw
 * sell-side deviation (a previous version conflated two different daily-mean baselines).
 */
function bestPickForItem(
  r: ReturnType<typeof getItemsAtSlot>[number],
  slot: number,
  maxLookaheadSlots: number,
  bankroll: number,
): HourlyPick | null {
  // scoreItem() has excluded these from Market/Buy Signals/the allocator since early on, but the
  // slot-profile ranking never shared the list -- so Old school bond was ranking #1 among the
  // items a nearly-spent bankroll could still afford. It has a spread like anything else; what it
  // does not have is a way to acquire one off the GE cheaply, which is what makes it not a flip.
  if (NON_FLIPPABLE_IDS.has(r.item_id)) return null;
  if (r.days < MIN_DAYS_PER_SLOT) return null;
  if (r.volume <= 0) return null;
  if (r.buy_price == null || r.buy_price <= 0) return null;

  // Index the profile by its own slot column rather than array position: relying on the array
  // being exactly 48 ordered rows is true today only because the writer always emits 48.
  const profile = getSlotProfile(r.item_id);
  const bySlot = new Map(profile.map((p) => [p.slot, p]));

  // §14.51: score each candidate sell slot by the MEDIAN OF THE PAIRED DAILY OUTCOMES, not by
  // the difference between two independently-taken medians.
  //
  // "Buy at 15:30, sell at 09:00" only ever happens inside one day's prices. Taking
  // median(sell across days) - median(buy across days) lets the two medians land on different
  // days, so on a trending item the week's drift gets counted as time-of-day edge. Measured on
  // Dexterous prayer scroll (down 19% across the sample week): the old formula claimed 1.62m/unit
  // where the median paired day actually returned 109k, and three of eight live picks were
  // loss-making on a median day.
  let bestSellSlot: number | null = null;
  let bestProfit = 0;
  let bestPairedDays = 0;
  let bestWinDays = 0;
  let bestSpanDays = 0;
  for (let offset = 1; offset <= maxLookaheadSlots; offset++) {
    const s = (slot + offset) % SLOTS_PER_DAY;
    const row = bySlot.get(s);
    if (!row || row.sell_price == null || row.sell_price <= 0) continue;

    const paired = getPairedDays(r.item_id, slot, s);
    if (paired.length < MIN_PAIRED_DAYS) continue;
    // Reject evidence stretched across too wide a calendar window (see MAX_PAIRED_SPAN_DAYS).
    const span = pairedSpanDays(paired);
    if (span > MAX_PAIRED_SPAN_DAYS) continue;
    const profits = paired.map((d) => d.sell - geTax(Math.round(d.sell)) - d.buy);
    const m = median(profits);
    if (m == null) continue;
    const profit = m;
    if (profit > bestProfit) {
      bestProfit = profit;
      bestSellSlot = s;
      bestPairedDays = paired.length;
      bestWinDays = profits.filter((x) => x > 0).length;
      bestSpanDays = span;
    }
  }

  if (bestSellSlot == null || bestProfit <= 0) return null; // no timing profit available from here

  const bestSellRow = bySlot.get(bestSellSlot)!;
  const bestSellDev = bestSellRow.sell_deviation;
  // Real after-tax return on what you actually tie up.
  const timingEdge = bestProfit / r.buy_price;
  const holdSlots = (bestSellSlot - slot + SLOTS_PER_DAY) % SLOTS_PER_DAY;
  const holdHours = holdSlots / 2;

  const price = r.buy_price;
  const projectedProfitPerLimit = r.buy_limit ? Math.round(bestProfit * r.buy_limit) : null;

  // §14.46: rank by the gp this actually earns the caller's bankroll, not by percentage.
  //
  // Two constraints bind at once and neither alone is enough: the GE buy limit caps units per 4h
  // cycle, and the bankroll caps how many you can pay for. Whichever bites first is the real
  // position size.
  const affordable = Math.floor(bankroll / r.buy_price);
  const deployableUnits = Math.max(0, Math.min(r.buy_limit ?? Infinity, affordable));
  if (deployableUnits <= 0) return null; // can't buy even one at this bankroll
  const capitalUsed = Math.round(deployableUnits * r.buy_price);
  const cycleProfit = Math.round(deployableUnits * bestProfit);

  // Can the market absorb that position? `volume` is units traded per 30-minute slot, so this is
  // the fraction of a typical slot you would have to be. Above ~50% you are no longer taking the
  // observed price, you are setting it -- which is exactly the case where a historical median
  // stops predicting your fill.
  const fillShare = r.volume > 0 ? deployableUnits / r.volume : null;
  const fillPenalty = fillShare == null ? 0.5 : fillShare <= 0.5 ? 1 : Math.max(0.15, 0.5 / fillShare);

  // Log-scaled so the ranking spans darts (~3e5) to big weapons (~5e6) without the top end
  // flattening: 1m -> 0.60, 5m -> 0.78, 50m -> 1.0.
  const gpTerm = Math.min(1, Math.log10(Math.max(1, cycleProfit)) / 7.7);
  const score = Math.round(gpTerm * fillPenalty * 100);

  return {
    itemId: r.item_id,
    name: r.name,
    icon: r.icon,
    slot,
    slotLabel: slotLabel(slot),
    buyDeviation: r.buy_deviation,
    bestSellSlot,
    bestSellSlotLabel: slotLabel(bestSellSlot),
    sellDeviation: bestSellDev,
    timingEdgePct: timingEdge,
    buyPrice: Math.round(r.buy_price),
    sellPrice: Math.round(bestSellRow.sell_price!),
    profitPerUnit: Math.round(bestProfit),
    pairedDays: bestPairedDays,
    winDays: bestWinDays,
    pairedSpanDays: bestSpanDays,
    holdSlots,
    holdHours,
    volume: r.volume,
    days: r.days,
    price,
    buyLimit: r.buy_limit,
    projectedProfitPerLimit,
    deployableUnits,
    capitalUsed,
    cycleProfit,
    fillShare,
    score,
  };
}

/**
 * Rank items by how good a buy they are *at this time of day*.
 *
 * Scoring combines the three things the request named -- volume, and profit at the sell point --
 * with the discount now. Deliberately a transparent product of normalised terms rather than a
 * tuned formula: every input is visible in the returned row, so a pick can always be argued with.
 */
export function computeItemOfTheHour(slot: number, limit = 12, bankroll = DEFAULT_BANKROLL): HourlyPick[] {
  const freshSince = Math.floor(Date.now() / 1000) - MAX_PROFILE_AGE_SECONDS;
  const rows = getItemsAtSlot(slot, freshSince);
  const picks = rows
    .map((r) => bestPickForItem(r, slot, SLOTS_PER_DAY - 1, bankroll)) // whole day
    .filter((p): p is HourlyPick => p != null);
  return picks.sort((a, b) => b.score - a.score).slice(0, limit);
}

// DESIGN.md: Overnight Trading, Phase 1. Same method as computeItemOfTheHour, but the sell-slot
// search is capped to an actual overnight hold window instead of the whole day -- a pick whose
// best pair is 20 hours away isn't an overnight trade, it's a coincidence that would leave the
// position open long past "sell it after work."
export function computeOvernightPicks(
  bedtimeSlot: number,
  maxHoldSlots: number,
  limit = 8,
  bankroll = DEFAULT_BANKROLL,
): HourlyPick[] {
  const freshSince = Math.floor(Date.now() / 1000) - MAX_PROFILE_AGE_SECONDS;
  const rows = getItemsAtSlot(bedtimeSlot, freshSince);
  const picks = rows
    .map((r) => bestPickForItem(r, bedtimeSlot, maxHoldSlots, bankroll))
    .filter((p): p is HourlyPick => p != null);
  return picks.sort((a, b) => b.score - a.score).slice(0, limit);
}

export function slotProfileCoverage(): {
  items: number;
  profiledItems: number;
  lastRun: number | null;
} {
  const last = kvGet(LAST_RUN_KEY);
  const freshSince = Math.floor(Date.now() / 1000) - MAX_PROFILE_AGE_SECONDS;
  return {
    // What the ranking can actually draw on: fresh AND backed by per-day rows. Reporting the raw
    // profile count here overstated coverage by 28% (556 claimed against 434 usable), which is
    // exactly the kind of number that reads as reassuring and means nothing.
    items: countRankableItems(freshSince),
    profiledItems: getProfiledItems().length,
    lastRun: last ? Number(last.value) : null,
  };
}
