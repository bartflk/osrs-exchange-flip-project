import { db } from "./db.js";
import { getEquipment, type EquipmentItem, type Monster } from "./gameData.js";
import { computeDps, type CombatStyle, type DpsResult, type PlayerSkills } from "./dps.js";

// "The best gear you can afford for this boss."
//
// Two constraints, and the interesting one is the budget. Without it this is a lookup -- the
// best-in-slot lists are already written down everywhere. With it, it becomes a question nobody
// answers for you: given THIS much gp, which eleven items maximise damage?
//
// Solved greedily per slot rather than as a true knapsack. The exact version is a multi-dimensional
// knapsack over ~2,160 priced items in 11 slots, which is both expensive and pointless here,
// because the objective is not separable anyway: the damage contribution of a strength bonus
// depends on every other piece worn. The greedy pass below runs the real DPS function against a
// full candidate loadout for each choice, so at least each decision is evaluated in context.
// It finds a good loadout, not a provably optimal one, and says so.

const SLOTS = [
  "weapon",
  "shield",
  "head",
  "body",
  "legs",
  "hands",
  "feet",
  "cape",
  "neck",
  "ring",
  "ammo",
] as const;

export interface GearChoice {
  slot: string;
  itemId: number;
  name: string;
  price: number;
  image: string;
}

export interface LoadoutResult {
  style: CombatStyle;
  items: GearChoice[];
  totalCost: number;
  budget: number;
  dps: DpsResult;
  /** Slots left empty because nothing affordable existed for them. */
  emptySlots: string[];
  /** Candidates considered after price and affordability filtering. */
  consideredItems: number;
}

interface PricedEquipment extends EquipmentItem {
  price: number;
}

const pricedStmt = db.prepare(`
  SELECT item_id, high FROM latest_snapshot WHERE high IS NOT NULL
`);

async function affordableEquipment(maxPrice: number): Promise<PricedEquipment[]> {
  const equipment = await getEquipment();
  const prices = new Map(
    (pricedStmt.all() as unknown as { item_id: number; high: number }[]).map((r) => [
      r.item_id,
      r.high,
    ]),
  );

  const out: PricedEquipment[] = [];
  for (const item of equipment) {
    const price = prices.get(item.id);
    // No price means untradeable (quest gear, cosmetics, degraded variants). Excluded rather than
    // treated as free -- "best gear you can afford" must not recommend something unbuyable.
    if (price == null || price > maxPrice) continue;
    out.push({ ...item, price });
  }
  return out;
}

/**
 * What the weapon can actually load.
 *
 * Without this the optimiser produced a Dragon dart equipped alongside a Dragon javelin and
 * summed both -- a loadout the game does not permit, scored as if it did. Darts and chinchompas
 * ARE the ammunition, so their ammo slot must stay empty; a bow fires arrows and a crossbow fires
 * bolts, and neither can attack at all without them.
 *
 * Ammunition carries no category in the source data, so it is matched on name. Crude, but the
 * naming is completely consistent in OSRS: bolts end in "bolts", arrows in "arrow(s)".
 */
type AmmoKind = "bolts" | "arrows" | "javelins" | "none";

/**
 * Bows that supply their own ammunition and must leave the ammo slot empty.
 *
 * A named list, because the obvious data-driven rule is wrong: "a bow with its own ranged strength
 * needs no arrows" holds for Craw's (60), Webweaver (65) and BoFa, and fails on the Twisted bow,
 * which carries 20 and still fires arrows. Three names beat a heuristic that silently disarms the
 * best bow in the game.
 */
const AMMO_LESS_WEAPONS = /^(Craw's bow|Webweaver bow|Bow of faerdhinen|Eclipse atlatl)/i;

function ammoKindFor(weapon: EquipmentItem | null): AmmoKind {
  if (!weapon) return "none";
  if (AMMO_LESS_WEAPONS.test(weapon.name)) return "none";
  switch (weapon.category) {
    case "Crossbow":
      return "bolts";
    case "Bow":
      return "arrows";
    case "Polearm":
      // Ballistae are catalogued as polearms and fire javelins.
      return /ballista/i.test(weapon.name) ? "javelins" : "none";
    default:
      return "none";
  }
}

function ammoMatches(kind: AmmoKind, ammo: EquipmentItem): boolean {
  const n = ammo.name.toLowerCase();
  switch (kind) {
    case "bolts":
      return /bolts?/.test(n) && !/javelin/.test(n);
    case "arrows":
      return /arrows?/.test(n);
    case "javelins":
      return /javelins?/.test(n);
    case "none":
      return false;
  }
}

/**
 * Strip anything the game would refuse before scoring a loadout.
 *
 * Applied centrally rather than at each selection point, so no future caller can construct an
 * illegal combination and have it silently scored.
 */
function legalise<T extends EquipmentItem>(items: T[], style: CombatStyle): T[] {
  const weapon = items.find((i) => i.slot === "weapon") ?? null;
  const kind = ammoKindFor(weapon);
  return items.filter((i) => {
    if (i.slot === "shield" && weapon?.isTwoHanded) return false;
    if (i.slot !== "ammo") return true;
    // Ammo contributes nothing to a melee or magic attack.
    if (style !== "ranged") return false;
    return ammoMatches(kind, i);
  });
}

/** The stat that decides whether a slot's candidate is even worth testing, per style. */
function quickScore(item: EquipmentItem, style: CombatStyle): number {
  if (style === "melee") {
    const acc = Math.max(item.offensive.stab, item.offensive.slash, item.offensive.crush);
    return acc + item.bonuses.str * 10;
  }
  if (style === "ranged") {
    return item.offensive.ranged + item.bonuses.ranged_str * 10;
  }
  return item.offensive.magic + item.bonuses.magic_str * 10;
}

export async function bestLoadout(
  monster: Monster,
  skills: PlayerSkills,
  budget: number,
  style: CombatStyle,
  opts: { onSlayerTask?: boolean; prayerAttack?: number; prayerStrength?: number } = {},
): Promise<LoadoutResult> {
  const pool = await affordableEquipment(budget);

  // Per slot, keep only the strongest handful by a cheap proxy. Running the full DPS function
  // against all 2,160 items in every slot on every request would be slow and would not change the
  // answer -- an item outside the top few on raw bonuses does not win once everything else is
  // equal. The proxy narrows; the real function decides.
  const bySlot = new Map<string, PricedEquipment[]>();
  for (const item of pool) {
    const list = bySlot.get(item.slot) ?? [];
    list.push(item);
    bySlot.set(item.slot, list);
  }
  for (const [slot, list] of bySlot) {
    list.sort((a, b) => quickScore(b, style) - quickScore(a, style));
    if (slot === "ammo") {
      // Ammo is narrowed PER KIND, not globally. Ranked as one pool, javelins carry the highest
      // ranged strength and filled all twelve places -- so a crossbow reached the ammo slot to
      // find no bolts on offer at all, silently lost its ammunition to the legality filter, and
      // scored as a bow with nothing loaded. Ranged fell from 10.2 to 4.7 DPS for that reason
      // alone, which reads as "melee is better here" and is simply false.
      const kinds: AmmoKind[] = ["bolts", "arrows", "javelins"];
      const kept: PricedEquipment[] = [];
      for (const kind of kinds) {
        kept.push(...list.filter((a) => ammoMatches(kind, a)).slice(0, 8));
      }
      bySlot.set(slot, kept);
    } else {
      bySlot.set(slot, list.slice(0, 12));
    }
  }

  const chosen = new Map<string, PricedEquipment>();
  let spent = 0;

  const evaluate = (candidate?: PricedEquipment): DpsResult => {
    const items = [...chosen.values()];
    const combined = candidate
      ? [...items.filter((i) => i.slot !== candidate.slot), candidate]
      : items;
    return computeDps(legalise(combined, style), monster, skills, style, opts);
  };

  // Weapon first: it sets the attack type and speed that every other slot is judged against.
  const order = ["weapon", ...SLOTS.filter((s) => s !== "weapon")];

  const fillSlot = (slot: string): boolean => {
    const candidates = bySlot.get(slot) ?? [];
    const incumbent = chosen.get(slot);
    // Re-selecting a slot must price against the budget WITHOUT its current occupant, or the
    // incumbent's cost is charged twice and better options look unaffordable.
    const spentWithout = spent - (incumbent?.price ?? 0);
    let best: PricedEquipment | null = incumbent ?? null;
    let bestDps = evaluate(incumbent).dps;

    for (const candidate of candidates) {
      if (spentWithout + candidate.price > budget) continue;
      if (candidate.slot === "shield" && [...chosen.values()].some((i) => i.isTwoHanded)) continue;
      const result = evaluate(candidate);
      if (result.dps > bestDps + 1e-9) {
        bestDps = result.dps;
        best = candidate;
      }
    }

    if (!best || best === incumbent) return false;
    if (incumbent) {
      spent -= incumbent.price;
      chosen.delete(slot);
    }
    if (best.isTwoHanded) {
      const shield = chosen.get("shield");
      if (shield) {
        spent -= shield.price;
        chosen.delete("shield");
      }
    }
    chosen.set(slot, best);
    spent += best.price;
    return true;
  };

  for (const slot of order) fillSlot(slot);

  // Refinement passes, and they are not cosmetic.
  //
  // A single greedy sweep judges each slot against a half-built loadout, and the weapon -- picked
  // first, when nothing else is worn -- suffers worst. Against Vorkath the first pass chose a
  // Webweaver bow over a Dragon hunter crossbow, because at selection time no ammo was equipped
  // and the DHCB's damage comes entirely from its bolts, while the Webweaver carries its own
  // ranged strength. The crossbow's +30% accuracy and +25% damage against dragons never got to
  // count. Re-running each slot against the COMPLETE loadout lets that decision be revisited.
  //
  // Capped at three passes: this is a hill climb and it can oscillate between two loadouts of
  // near-identical DPS, which would otherwise spin forever.
  for (let pass = 0; pass < 3; pass++) {
    let changed = false;
    for (const slot of order) {
      if (fillSlot(slot)) changed = true;
    }
    if (!changed) break;
  }

  const items = legalise([...chosen.values()], style);
  const dps = computeDps(items, monster, skills, style, opts);

  return {
    style,
    items: items.map((i) => ({
      slot: i.slot,
      itemId: i.id,
      name: i.name,
      price: i.price,
      image: i.image,
    })),
    totalCost: items.reduce((sum, i) => sum + i.price, 0),
    budget,
    dps,
    emptySlots: SLOTS.filter((s) => !chosen.has(s)),
    consideredItems: pool.length,
  };
}

/** Runs all three styles and returns them ranked, so the choice of style is itself an output. */
export async function bestLoadoutAllStyles(
  monster: Monster,
  skills: PlayerSkills,
  budget: number,
  opts: { onSlayerTask?: boolean; prayerAttack?: number; prayerStrength?: number } = {},
): Promise<LoadoutResult[]> {
  const styles: CombatStyle[] = ["melee", "ranged", "magic"];
  const results = await Promise.all(
    styles.map((style) => bestLoadout(monster, skills, budget, style, opts)),
  );
  return results.sort((a, b) => b.dps.dps - a.dps.dps);
}
