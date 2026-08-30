import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Equipment and monster stats, from the OSRS Wiki's own DPS calculator data dumps
// (github.com/weirdgloop/osrs-dps-calc, cdn/json). Verified live before building against it:
// 5,431 equipment entries and 2,859 monsters, and 2,160 of the equipment entries join to a live
// GE price in this app's own item table -- across all eleven slots, which is what makes an
// "affordable gear" question answerable at all.
//
// Why this source rather than parsing the wiki ourselves: the dumps already carry the two fields
// a correct answer depends on and raw wikitext does not surface cleanly -- a monster's
// `attributes` (dragon / undead / fiery / etc.) and the ranged-defence split
// (light / standard / heavy). Without attributes you cannot know that a Dragon hunter crossbow is
// worth +30% against Vorkath, and a "best gear" tool that misses that recommends the wrong weapon
// with total confidence.
//
// LICENCE NOTE: that repository is GPL-3.0. This module downloads its DATA at runtime and does
// not vendor or port any of its code -- `dps.ts` is written from the formulas documented on the
// wiki. The data itself is wiki-derived (CC BY-NC-SA). Nothing here is redistributed; it is
// fetched to a local cache on one machine.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = path.join(__dirname, "..", "data", "gamedata");

const SOURCES = {
  equipment:
    "https://raw.githubusercontent.com/weirdgloop/osrs-dps-calc/main/cdn/json/equipment.json",
  monsters: "https://raw.githubusercontent.com/weirdgloop/osrs-dps-calc/main/cdn/json/monsters.json",
} as const;

// These change when the game does -- a new item or a rebalance -- which is weeks apart, not
// minutes. Re-downloading 5MB more often than that is rude to someone else's bandwidth for no
// benefit.
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

const USER_AGENT = "osrs-flip-assistant/1.0 (local single-user GE tool)";

export interface EquipmentBonuses {
  str: number;
  ranged_str: number;
  magic_str: number;
  prayer: number;
}

export interface CombatStats {
  stab: number;
  slash: number;
  crush: number;
  magic: number;
  ranged: number;
}

export interface EquipmentItem {
  name: string;
  id: number;
  version: string;
  slot: string;
  image: string;
  speed: number;
  category: string;
  bonuses: EquipmentBonuses;
  offensive: CombatStats;
  defensive: CombatStats;
  isTwoHanded: boolean;
}

export interface MonsterSkills {
  atk: number;
  def: number;
  hp: number;
  magic: number;
  ranged: number;
  str: number;
}

export interface MonsterDefensive {
  flat_armour?: number;
  stab: number;
  slash: number;
  crush: number;
  magic: number;
  light: number;
  standard: number;
  heavy: number;
}

export interface Monster {
  id: number;
  name: string;
  version: string;
  image: string;
  level: number;
  speed: number;
  style: string[] | null;
  size: number;
  max_hit: string;
  skills: MonsterSkills;
  offensive: Record<string, number>;
  defensive: MonsterDefensive;
  attributes: string[];
}

let equipmentCache: EquipmentItem[] | null = null;
let monsterCache: Monster[] | null = null;

function cachePath(kind: keyof typeof SOURCES): string {
  return path.join(CACHE_DIR, `${kind}.json`);
}

function isFresh(file: string): boolean {
  try {
    return Date.now() - fs.statSync(file).mtimeMs < MAX_AGE_MS;
  } catch {
    return false;
  }
}

async function load<T>(kind: keyof typeof SOURCES): Promise<T[]> {
  const file = cachePath(kind);

  if (isFresh(file)) {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T[];
  }

  try {
    const res = await fetch(SOURCES[kind], { headers: { "User-Agent": USER_AGENT } });
    if (!res.ok) throw new Error(`${kind} fetch failed: ${res.status}`);
    const text = await res.text();
    // Parse before writing: a truncated download that still writes leaves a permanently broken
    // cache that looks fresh, and the next call would fail on read instead of re-fetching.
    const parsed = JSON.parse(text) as T[];
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(file, text);
    console.log(`[gamedata] refreshed ${kind} (${parsed.length} entries)`);
    return parsed;
  } catch (err) {
    // A stale cache beats no data. Only fail outright when there is nothing on disk at all.
    if (fs.existsSync(file)) {
      console.error(`[gamedata] ${kind} refresh failed, using stale cache:`, err);
      return JSON.parse(fs.readFileSync(file, "utf8")) as T[];
    }
    throw err;
  }
}

export async function getEquipment(): Promise<EquipmentItem[]> {
  if (!equipmentCache) equipmentCache = await load<EquipmentItem>("equipment");
  return equipmentCache;
}

export async function getMonsters(): Promise<Monster[]> {
  if (!monsterCache) monsterCache = await load<Monster>("monsters");
  return monsterCache;
}

/** Newest version of each named monster, for name lookups from the money-making guides. */
export async function findMonster(name: string): Promise<Monster | null> {
  const monsters = await getMonsters();
  const target = name.trim().toLowerCase();
  const matches = monsters.filter((m) => m.name.toLowerCase() === target);
  if (matches.length === 0) return null;
  // Several entries share a name (phases, quest variants, difficulty modes). Prefer the one with
  // the most hitpoints: for a money-making guide the headline boss is the substantial form, not a
  // 20hp intermediate phase.
  return matches.reduce((best, m) => (m.skills.hp > best.skills.hp ? m : best));
}

/**
 * Every form a boss fights in, not just the biggest one.
 *
 * findMonster() picks a single entry, which is right for a lookup and wrong for scoring a fight.
 * Zulrah is the case that proves it: three forms, all 300 defence, but Magma has 300 RANGED
 * defence while Tanzanite has 0 and Serpentine 50. All three tie on hitpoints, so the
 * highest-hp rule picked Magma, and a ranged setup scored 1.06 dps against a boss people range.
 */
export async function getMonsterForms(name: string): Promise<Monster[]> {
  const monsters = await getMonsters();
  const target = name.trim().toLowerCase();
  return monsters.filter((m) => m.name.toLowerCase() === target);
}

export function gameDataCacheState(): { kind: string; entries: number | null; ageHours: number | null }[] {
  return (Object.keys(SOURCES) as (keyof typeof SOURCES)[]).map((kind) => {
    const file = cachePath(kind);
    try {
      const stat = fs.statSync(file);
      const entries = (JSON.parse(fs.readFileSync(file, "utf8")) as unknown[]).length;
      return { kind, entries, ageHours: (Date.now() - stat.mtimeMs) / 3_600_000 };
    } catch {
      return { kind, entries: null, ageHours: null };
    }
  });
}
