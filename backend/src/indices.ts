import { db } from "./db.js";
import { getEquipment } from "./gameData.js";
import { computeAllTrendEntries, type TrendWindow } from "./trends.js";
import {
  INDEX_DEFINITIONS,
  categoriesPopulated,
  categoryMemberIds,
  refreshItemCategories,
} from "./itemCategories.js";

// Market indices: one number per item group, so a move across a whole segment is visible without
// reading four thousand rows. DESIGN.md §16.
//
// Replaces sectors.ts, which averaged six hand-written baskets. Two things change.
//
// MEMBERSHIP comes from the wiki's category graph (itemCategories.ts) rather than a hardcoded
// array, so it keeps up with the game on its own.
//
// WEIGHTING is by turnover rather than a flat mean, and that is the more consequential change. In
// a 176-item food basket a flat mean lets a dead 300gp pie that moved 40% on two trades outvote a
// heavily traded shark: it measures attention, not money. Both are reported, because "how broad is
// this move" is a real and different question, and the two disagreeing is itself the signal that
// one item is carrying the basket.
//
// Price weighting is deliberately NOT offered. OSRS has no share count, so a 1.4bn Twisted bow is
// not economically larger than 10,000 sharks; cap weighting borrowed from equities would look
// rigorous and mean nothing.

export type IndexWeighting = "turnover" | "equal";

export interface IndexContributor {
  itemId: number;
  name: string;
  icon: string;
  changePct: number;
  /** Share of the basket's weight this item carries, 0..1. */
  weight: number;
}

export interface MarketIndex {
  key: string;
  label: string;
  group: string;
  /** Turnover-weighted change over the window, or null when nothing in it has data. */
  changePct: number | null;
  /**
   * The MEDIAN member's change, which is the honest answer to "how broad is this move".
   *
   * A median rather than a mean, and the reason is visible in the data. Index membership skips the
   * leaderboard's price and liquidity screens on purpose, so a basket contains genuinely tiny
   * items, and a handful of those swinging 200% on two trades dragged the mean to absurdity:
   * Capes read +17.47% average while its turnover-weighted figure was -5.49%. The mean was
   * reporting junk, not breadth. A median ignores the tails by construction, which is exactly what
   * is wanted from a statistic whose whole job is to describe the typical member.
   */
  medianChangePct: number | null;
  /** Members with usable trend data, and how many the group holds in total. */
  scored: number;
  total: number;
  /** How many of the scored members rose and fell. */
  up: number;
  down: number;
  /** Total gp per hour changing hands across the basket. */
  turnover: number;
  /** The single largest weight in the basket, which is what a one-item move hides behind. */
  topContributor: IndexContributor | null;
  /**
   * True when this group is derived here rather than taken from the wiki.
   *
   * Shown in the UI, because "high-end PvM gear" is this app's opinion and "Ranged weapons" is the
   * wiki's, and a reader is entitled to know which one they are looking at.
   */
  derived: boolean;
}

const volumeStmt = db.prepare(
  `SELECT item_id, COALESCE(vol_high_1h, 0) + COALESCE(vol_low_1h, 0) AS vol, high
   FROM latest_snapshot WHERE high IS NOT NULL`,
);

/**
 * Price bands for the derived PvM tiers.
 *
 * Round numbers chosen for legibility, NOT thresholds discovered in the data, and the UI says so.
 * Naming that honestly matters more than the exact values: any split here is arbitrary, and one
 * dressed up as an analytical result would be a worse lie than an obvious round number.
 */
const TIER_BANDS: { key: string; label: string; min: number; max: number }[] = [
  { key: "pvm-entry", label: "Entry PvM gear", min: 0, max: 1_000_000 },
  { key: "pvm-mid", label: "Mid PvM gear", min: 1_000_000, max: 50_000_000 },
  { key: "pvm-high", label: "High-end PvM gear", min: 50_000_000, max: Infinity },
];

/**
 * Equipment that is actually for fighting, by offensive bonus.
 *
 * `Category:Equipable items` would include cosmetics, skilling tools and graceful, none of which
 * belong in a PvM index. A positive attack bonus in some style is the closest thing to a
 * mechanical definition of "you take this to a boss", and unlike a curated list it stays true.
 */
async function pvmEquipmentIds(): Promise<Set<number>> {
  const out = new Set<number>();
  for (const item of await getEquipment()) {
    const o = item.offensive;
    const b = item.bonuses;
    const offensive =
      o.stab > 0 || o.slash > 0 || o.crush > 0 || o.magic > 0 || o.ranged > 0;
    const damage = b.str > 0 || b.ranged_str > 0 || b.magic_str > 0;
    if (offensive || damage) out.add(item.id);
  }
  return out;
}

interface Member {
  itemId: number;
  name: string;
  icon: string;
  changePct: number;
  turnover: number;
}

function summarise(
  def: { key: string; label: string; group: string; derived: boolean },
  members: Member[],
  total: number,
): MarketIndex {
  if (members.length === 0) {
    return {
      ...def,
      changePct: null,
      medianChangePct: null,
      scored: 0,
      total,
      up: 0,
      down: 0,
      turnover: 0,
      topContributor: null,
    };
  }

  const turnover = members.reduce((s, m) => s + m.turnover, 0);
  // Falls back to an equal weighting when nothing in the basket traded this hour. A basket of
  // zero-turnover items would otherwise divide by zero and report NaN, which renders as a blank
  // and reads as "no move" rather than "no data".
  const weightOf = (m: Member) => (turnover > 0 ? m.turnover / turnover : 1 / members.length);

  const changePct = members.reduce((s, m) => s + m.changePct * weightOf(m), 0);

  const sorted = members.map((m) => m.changePct).sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const medianChangePct =
    sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];

  const top = members.reduce((best, m) => (weightOf(m) > weightOf(best) ? m : best));

  return {
    ...def,
    changePct,
    medianChangePct,
    scored: members.length,
    total,
    up: members.filter((m) => m.changePct > 0).length,
    down: members.filter((m) => m.changePct < 0).length,
    turnover,
    topContributor: {
      itemId: top.itemId,
      name: top.name,
      icon: top.icon,
      changePct: top.changePct,
      weight: weightOf(top),
    },
  };
}

export async function computeMarketIndices(window: TrendWindow): Promise<MarketIndex[]> {
  // First call after a fresh install has nothing cached. Fetching inline is slow once and correct,
  // which beats returning an empty board that looks like a broken feature.
  if (!categoriesPopulated()) await refreshItemCategories();

  // screen:false on purpose. The leaderboard's price and liquidity floors exist to stop one thin
  // item topping a list OF extremes; an index has no extremes to protect, because a thin item is
  // already diluted by its own weight. With the floors on, Runes and Chambers of Xeric both scored
  // zero members: every rune trades under the 1,000gp floor, and CoX uniques under 20/hr.
  const trend = await computeAllTrendEntries(window, { screen: false });
  const byId = new Map(trend.map((t) => [t.itemId, t]));

  const volumes = new Map(
    (volumeStmt.all() as unknown as { item_id: number; vol: number; high: number }[]).map((r) => [
      r.item_id,
      r.vol * r.high,
    ]),
  );

  const memberFor = (id: number): Member | null => {
    const t = byId.get(id);
    if (!t) return null;
    return {
      itemId: id,
      name: t.name,
      icon: t.icon,
      changePct: t.changePct,
      turnover: volumes.get(id) ?? 0,
    };
  };

  const out: MarketIndex[] = [];

  for (const def of INDEX_DEFINITIONS) {
    const ids = categoryMemberIds(def.category);
    const members = ids.map(memberFor).filter((m): m is Member => m != null);
    out.push(
      summarise(
        { key: def.key, label: def.label, group: def.group, derived: false },
        members,
        ids.length,
      ),
    );
  }

  // Derived tiers last, and flagged, because they are this app's opinion rather than the wiki's.
  const pvm = await pvmEquipmentIds();
  const priceById = new Map(
    (volumeStmt.all() as unknown as { item_id: number; high: number }[]).map((r) => [
      r.item_id,
      r.high,
    ]),
  );
  for (const band of TIER_BANDS) {
    const ids = [...pvm].filter((id) => {
      const price = priceById.get(id);
      return price != null && price >= band.min && price < band.max;
    });
    const members = ids.map(memberFor).filter((m): m is Member => m != null);
    out.push(
      summarise(
        { key: band.key, label: band.label, group: "PvM tiers", derived: true },
        members,
        ids.length,
      ),
    );
  }

  return out;
}
