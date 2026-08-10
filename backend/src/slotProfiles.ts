import { fetchTimeseriesByStep } from "./wiki.js";
import {
  upsertSlotProfiles,
  getProfiledItems,
  getMostLiquidItemIds,
  getItemsAtSlot,
  getSlotProfile,
  kvGet,
  kvSet,
  type SlotProfileRow,
} from "./db.js";
import { geTax } from "./signals.js";
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
// timestep -- so longer coverage can only come from accumulating these rows locally over time,
// which is exactly why they're stored rather than recomputed.

const SLOTS_PER_DAY = 48; // 30-minute slots
const REFRESH_INTERVAL_MS = 12 * 60 * 60 * 1000;
const LAST_RUN_KEY = "slotProfiles:lastRun";

// One request per item, so this is a budget, not a target. 250 covers the genuinely liquid end of
// the market -- an item that trades a handful of times a day has no time-of-day signal worth
// having, only noise dressed up as a pattern.
const MAX_ITEMS = 250;
// Deliberately unhurried. The Wiki API is free, community-run and asks for reasonable use; there
// is no deadline on a background job that refreshes twice a day.
const REQUEST_SPACING_MS = 400;
const MIN_DAYS_PER_SLOT = 4;

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
export async function profileItem(itemId: number): Promise<SlotProfileRow[]> {
  const points = await fetchTimeseriesByStep(itemId, "30m");
  if (!points.length) return [];

  const byDay = new Map<string, { slot: number; low: number | null; high: number | null }[]>();
  const volume = new Map<number, { total: number; n: number }>();

  for (const p of points) {
    const d = new Date(p.timestamp * 1000);
    const dayKey = d.toISOString().slice(0, 10);
    const slot = slotOf(d);

    const list = byDay.get(dayKey) ?? [];
    list.push({ slot, low: p.avgLowPrice, high: p.avgHighPrice });
    byDay.set(dayKey, list);

    const v = volume.get(slot) ?? { total: 0, n: 0 };
    v.total += (p.highPriceVolume ?? 0) + (p.lowPriceVolume ?? 0);
    v.n += 1;
    volume.set(slot, v);
  }

  const buyDevs = new Map<number, number[]>();
  const sellDevs = new Map<number, number[]>();

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
      }
      if (r.high != null && r.high > 0) {
        const arr = sellDevs.get(r.slot) ?? [];
        arr.push((r.high - highMean) / highMean);
        sellDevs.set(r.slot, arr);
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
      volume: v && v.n > 0 ? Math.round(v.total / v.n) : 0,
      days: b.length,
      updated_at: now,
    });
  }
  return rows;
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

  const candidates = getMostLiquidItemIds(MAX_ITEMS);
  const lastSeen = new Map(getProfiledItems().map((r) => [r.item_id, r.updated_at]));
  candidates.sort((a, b) => (lastSeen.get(a) ?? 0) - (lastSeen.get(b) ?? 0));

  let profiled = 0;
  let failed = 0;
  for (const itemId of candidates) {
    try {
      const rows = await profileItem(itemId);
      if (rows.length) {
        upsertSlotProfiles(rows);
        profiled++;
      }
    } catch {
      // One item failing (404, transient 5xx) must not abort the run -- same additive principle
      // as the Reddit collector. The next pass retries it, since it stays oldest in the sort.
      failed++;
    }
    await new Promise((r) => setTimeout(r, REQUEST_SPACING_MS));
  }

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
  /** Sell-point premium minus buy-point discount, after GE tax. The actual timing profit. */
  timingEdgePct: number | null;
  holdSlots: number | null;
  holdHours: number | null;
  volume: number;
  days: number;
  price: number | null;
  buyLimit: number | null;
  /** gp per hour of hold, at full buy limit -- what makes a small % edge on a cheap item real. */
  projectedProfitPerLimit: number | null;
  score: number;
}

/**
 * Rank items by how good a buy they are *at this time of day*.
 *
 * Scoring combines the three things the request named -- volume, and profit at the sell point --
 * with the discount now. Deliberately a transparent product of normalised terms rather than a
 * tuned formula: every input is visible in the returned row, so a pick can always be argued with.
 */
export function computeItemOfTheHour(slot: number, limit = 12): HourlyPick[] {
  const rows = getItemsAtSlot(slot);
  const picks: HourlyPick[] = [];

  for (const r of rows) {
    if (r.days < MIN_DAYS_PER_SLOT) continue;
    if (r.volume <= 0) continue;

    // Where does this item peak *after* now? Buying at a discount only pays if a richer sell slot
    // is still ahead of you; a peak that already passed today means waiting ~24h for the next one.
    const profile = getSlotProfile(r.item_id);
    let bestSellSlot: number | null = null;
    let bestSellDev: number | null = null;
    for (let offset = 1; offset < SLOTS_PER_DAY; offset++) {
      const s = (slot + offset) % SLOTS_PER_DAY;
      const row = profile[s];
      if (!row || row.sell_deviation == null) continue;
      if (bestSellDev == null || row.sell_deviation > bestSellDev) {
        bestSellDev = row.sell_deviation;
        bestSellSlot = s;
      }
    }

    if (bestSellDev == null || bestSellSlot == null) continue;

    const grossEdge = bestSellDev - r.buy_deviation;
    if (grossEdge <= 0) continue; // no timing profit available from here

    const timingEdge = grossEdge * (1 - geTax(10_000) / 10_000);
    const holdSlots = (bestSellSlot - slot + SLOTS_PER_DAY) % SLOTS_PER_DAY;
    const holdHours = holdSlots / 2;

    const price = r.low ?? r.high;
    const projectedProfitPerLimit =
      price != null && r.buy_limit ? Math.round(price * timingEdge * r.buy_limit) : null;

    // Normalised so no single term can dominate: a 0.1% edge on a huge-volume item and a 5% edge
    // on a thin one should both be able to surface, and the caller can see which is which.
    const edgeTerm = Math.min(1, timingEdge / 0.03); // 3% is a very strong daily swing
    const volumeTerm = Math.min(1, Math.log10(r.volume + 1) / 4); // ~10k units/slot saturates
    const gpTerm =
      projectedProfitPerLimit != null ? Math.min(1, Math.log10(Math.max(1, projectedProfitPerLimit)) / 7) : 0;
    const score = Math.round((edgeTerm * 0.45 + volumeTerm * 0.25 + gpTerm * 0.3) * 100);

    picks.push({
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
      holdSlots,
      holdHours,
      volume: r.volume,
      days: r.days,
      price,
      buyLimit: r.buy_limit,
      projectedProfitPerLimit,
      score,
    });
  }

  return picks.sort((a, b) => b.score - a.score).slice(0, limit);
}

export function slotProfileCoverage(): { items: number; lastRun: number | null } {
  const last = kvGet(LAST_RUN_KEY);
  return {
    items: getProfiledItems().length,
    lastRun: last ? Number(last.value) : null,
  };
}
