import { db } from "./db.js";
import { getEquipment, type EquipmentItem, type Monster } from "./gameData.js";
import {
  computeDps,
  type CombatStyle,
  type DpsOptions,
  type DpsResult,
  type PlayerSkills,
} from "./dps.js";
import type { StrategySetup } from "./strategySetups.js";

// DPS for the loadout the wiki actually recommends, plus what to upgrade next.
//
// This exists because the gear optimiser was answering a question nobody asked. Given a budget it
// searches all 2,160 priced items for the highest-DPS combination, and at the Doom of Mokhaiotl it
// proposed a Webweaver bow -- which no one takes to Doom, because raw DPS against a dummy is not
// what picks a loadout for a fight with phases, prayer drain, and a melee punish. The wiki's
// setups encode all of that; they are what players actually run. So the DPS number should describe
// THOSE, and the optimiser's job shrinks to the thing it is genuinely good at: given a setup you
// already own, which single swap buys the most damage per gp.
//
// The upgrade search is deliberately one slot at a time. A full re-optimisation would hand back
// the Webweaver answer again, and "replace your entire kit" is not advice. "Your boots are the
// weak link, and these cost 12m for +0.4 dps" is.

const SLOT_ALIASES: Record<string, string> = {
  // The wiki's {{Equipment}} template and the weirdgloop item data disagree on three slot names.
  torso: "body",
  gloves: "hands",
  boots: "feet",
};

/**
 * Item versions to prefer when a name resolves to several.
 *
 * Void and Ava's come in Broken/Locked/Normal, charged items in Charged/Uncharged, arrows in four
 * poison grades. The wiki setups name the base item and mean the working one, so anything else
 * would silently score a broken void set or an uncharged quiver.
 */
const PREFERRED_VERSIONS = ["Normal", "Charged", "Unpoisoned", ""];

const pricedStmt = db.prepare(`SELECT item_id, high FROM latest_snapshot WHERE high IS NOT NULL`);

/** Piety / Rigour equivalent, matching gearOptimizer so both panels quote the same assumption. */
const PRAYERS: DpsOptions = { prayerAttack: 1.2, prayerStrength: 1.23 };

/**
 * How much better a swap must be before it is worth naming, as a fraction of current DPS.
 *
 * Below about a percent the model's own error is larger than the difference it is reporting, so a
 * suggestion there is noise dressed as advice. It also filters out a specific bad recommendation:
 * with no floor, the Doom's budget setup offered to replace a Lightbearer with an Archers ring
 * for +1.0%, because a Lightbearer's whole value is a special-attack restore this model cannot
 * see. Same blind spot as the weapon slot, smaller and easier to miss.
 */
const MIN_GAIN_FRACTION = 0.012;

function priceMap(): Map<number, number> {
  return new Map(
    (pricedStmt.all() as unknown as { item_id: number; high: number }[]).map((r) => [
      r.item_id,
      r.high,
    ]),
  );
}

function pickVersion(candidates: EquipmentItem[]): EquipmentItem {
  for (const wanted of PREFERRED_VERSIONS) {
    const hit = candidates.find((c) => (c.version ?? "") === wanted);
    if (hit) return hit;
  }
  return candidates[0];
}

async function equipmentByName(): Promise<Map<string, EquipmentItem[]>> {
  const out = new Map<string, EquipmentItem[]>();
  for (const item of await getEquipment()) {
    const key = item.name.toLowerCase();
    const list = out.get(key);
    if (list) list.push(item);
    else out.set(key, [item]);
  }
  return out;
}

/**
 * The style a loadout is actually built around, taken from its weapon.
 *
 * Inferred rather than searched. Running all three styles and keeping the best would report a
 * magic figure for a crossbow setup on the strength of an occult necklace in the neck slot, which
 * is not what the setup is for.
 */
function styleOf(weapon: EquipmentItem | null): CombatStyle {
  if (!weapon) return "melee";
  const cat = (weapon.category ?? "").toLowerCase();
  if (/bow|crossbow|thrown|dart|chinchompa|blowpipe|gun/.test(cat)) return "ranged";
  if (/staff|wand|powered|salamander/.test(cat)) return "magic";
  // A staff swung as a weapon is still melee, but the catalogue's category is the better signal
  // than the name, and anything unrecognised is far more likely to be melee than not.
  return "melee";
}

export interface ResolvedSetup {
  items: EquipmentItem[];
  style: CombatStyle;
  /** Setup pieces that are not equipment the DPS model knows about. */
  unresolved: string[];
}

export async function resolveSetupLoadout(setup: StrategySetup): Promise<ResolvedSetup> {
  const byName = await equipmentByName();
  const items: EquipmentItem[] = [];
  const unresolved: string[] = [];

  for (const [wikiSlot, piece] of Object.entries(setup.equipment)) {
    if (!piece) continue;
    const candidates = byName.get(piece.name.toLowerCase());
    if (!candidates || candidates.length === 0) {
      unresolved.push(piece.name);
      continue;
    }
    const wantSlot = SLOT_ALIASES[wikiSlot] ?? wikiSlot;
    // Slot-matched first: a name can exist in more than one slot, and the setup already says
    // which one it is worn in.
    const inSlot = candidates.filter((c) => c.slot === wantSlot);
    items.push(pickVersion(inSlot.length > 0 ? inSlot : candidates));
  }

  const weapon = items.find((i) => i.slot === "weapon") ?? null;

  // Pick the ammo the equipped weapon can actually fire. Setups list more than one because they
  // carry a swap weapon, and the first listed is frequently for the swap rather than for what is
  // worn: the Doom's max setup wears a Zaryte crossbow and lists arrows first. Taking the first
  // and letting the legality filter strip it left that crossbow firing nothing and scoring below
  // the budget setup, which is the sort of wrong answer that discredits the whole panel.
  const listed = setup.ammoOptions ?? [];
  if (weapon && listed.length > 0) {
    const withoutAmmo = items.filter((i) => i.slot !== "ammo");
    for (const option of listed) {
      const candidates = byName.get(option.name.toLowerCase())?.filter((c) => c.slot === "ammo");
      if (!candidates || candidates.length === 0) continue;
      const resolvedAmmo = pickVersion(candidates);
      if (ammoLegal(weapon, resolvedAmmo)) {
        return {
          items: [...withoutAmmo, resolvedAmmo],
          style: styleOf(weapon),
          unresolved,
        };
      }
    }
    // Nothing listed fits the worn weapon, so wear none rather than something illegal.
    return { items: withoutAmmo, style: styleOf(weapon), unresolved };
  }

  return { items, style: styleOf(weapon), unresolved };
}

/**
 * Ammunition the weapon can actually fire, restated here rather than imported.
 *
 * gearOptimizer keeps its own copy for building loadouts from scratch; this one only ever has to
 * judge whether a pairing already on the page is legal. Kept deliberately narrow: it answers
 * "can this weapon use this ammo", not "what should this weapon use".
 */
const SELF_AMMO_WEAPONS = /^(Craw's bow|Webweaver bow|Bow of faerdhinen|Eclipse atlatl)/i;

function ammoLegal(weapon: EquipmentItem | null, ammo: EquipmentItem): boolean {
  if (!weapon) return false;
  if (SELF_AMMO_WEAPONS.test(weapon.name)) return false;
  const cat = (weapon.category ?? "").toLowerCase();
  const name = ammo.name.toLowerCase();
  if (/crossbow/.test(cat)) return /bolt/.test(name);
  if (/bow/.test(cat)) return /arrow/.test(name);
  // Thrown weapons and blowpipes carry their ammunition as the weapon itself.
  return false;
}

function legalise(items: EquipmentItem[], style: CombatStyle): EquipmentItem[] {
  const weapon = items.find((i) => i.slot === "weapon") ?? null;
  return items.filter((i) => {
    if (i.slot === "shield" && weapon?.isTwoHanded) return false;
    if (i.slot !== "ammo") return true;
    if (style !== "ranged") return false;
    return ammoLegal(weapon, i);
  });
}

export interface UpgradeSuggestion {
  slot: string;
  fromName: string | null;
  fromPrice: number | null;
  toName: string;
  toItemId: number;
  toPrice: number;
  /** Extra gp over what the current piece is worth. Never negative. */
  extraCost: number;
  dps: number;
  dpsGain: number;
  /** Percent gain over the setup as it stands. */
  gainPct: number;
  /** Extra gp per +1 dps. The efficiency ranking, and what "best value" means here. */
  gpPerDps: number;
}

export interface SetupDpsResult {
  style: CombatStyle;
  dps: DpsResult | null;
  unresolved: string[];
  upgrades: UpgradeSuggestion[];
}

/**
 * Slots this model is fit to advise on. The WEAPON is deliberately not among them.
 *
 * The DPS model reads stats and a fixed list of gear effects: dragon-hunter weapons, Arclight and
 * Emberlight, the Salve amulet, slayer helmets, and Void. It does not model bolt procs, special
 * attacks, the Twisted bow's scaling, the Scythe's multi-hit, or a weapon passive like the
 * Scorching bow's demon bonus. Those blind spots are concentrated almost entirely in the weapon
 * slot, so a weapon "upgrade" from this model is the least trustworthy number it can produce --
 * and it showed: unrestricted, it offered to swap a Zaryte crossbow for a Hunters' sunlight
 * crossbow at +44%, which is a stat comparison that ignores everything the crossbow is taken for.
 *
 * The wiki setup already chose the weapon on grounds this model cannot see. Armour, jewellery and
 * ammunition are decided by the stats it CAN see, so that is what it advises on.
 */
const UPGRADE_SLOTS = [
  "body",
  "legs",
  "head",
  "hands",
  "feet",
  "cape",
  "neck",
  "ring",
  "shield",
  "ammo",
];

/**
 * DPS for the wiki's setup, and the single-slot swaps that buy the most damage.
 *
 * `spare` is gp the player has beyond the setup itself. A swap is affordable when its price is
 * within the spare plus whatever the piece it replaces is worth, because the old piece can be
 * sold -- which is how upgrading actually works, and ignoring it would hide every sidegrade-plus
 * that is really only a few million out of pocket.
 */
export async function computeSetupDps(
  setup: StrategySetup,
  monster: Monster,
  skills: PlayerSkills,
  spare: number,
): Promise<SetupDpsResult> {
  const resolved = await resolveSetupLoadout(setup);
  const base = legalise(resolved.items, resolved.style);
  if (base.length === 0) {
    return { style: resolved.style, dps: null, unresolved: resolved.unresolved, upgrades: [] };
  }

  // The same prayer assumption the gear optimiser uses (Piety / Rigour equivalent), so the two
  // panels on the same row are directly comparable. Two DPS figures side by side under different
  // assumptions would be worse than showing one.
  const dps = computeDps(base, monster, skills, resolved.style, PRAYERS);

  const prices = priceMap();
  const equipment = await getEquipment();
  const currentBySlot = new Map(base.map((i) => [i.slot, i]));

  const upgrades: UpgradeSuggestion[] = [];
  for (const slot of UPGRADE_SLOTS) {
    const current = currentBySlot.get(slot) ?? null;
    const currentPrice = current ? (prices.get(current.id) ?? 0) : 0;
    const ceiling = spare + currentPrice;

    let best: UpgradeSuggestion | null = null;
    for (const candidate of equipment) {
      if (candidate.slot !== slot) continue;
      if (current && candidate.id === current.id) continue;
      const price = prices.get(candidate.id);
      // Untradeable pieces are skipped rather than treated as free: this list is a shopping list,
      // and an item you cannot buy does not belong on one.
      if (price == null || price > ceiling) continue;
      if ((candidate.version ?? "") !== "" && !PREFERRED_VERSIONS.includes(candidate.version)) {
        continue;
      }

      // An enchanted bolt is never "upgraded" to a plain one. Ruby and diamond bolts (e) proc for
      // damage the model cannot see, so on raw stats a plain runite bolt looks better -- it was
      // offering exactly that swap, at a confident +5%.
      if (/\(e\)$/i.test(current?.name ?? "") && !/\(e\)$/i.test(candidate.name)) continue;

      const swapped = legalise(
        [...base.filter((i) => i.slot !== slot), candidate],
        resolved.style,
      );
      // A swap that disarms the loadout (a crossbow leaving arrows equipped) scores zero rather
      // than throwing, and is filtered out by the gain check below.
      const result = computeDps(swapped, monster, skills, resolved.style, PRAYERS);
      const gain = result.dps - dps.dps;
      if (gain <= dps.dps * MIN_GAIN_FRACTION) continue;

      const extraCost = Math.max(0, price - currentPrice);
      const suggestion: UpgradeSuggestion = {
        slot,
        fromName: current?.name ?? null,
        fromPrice: current ? currentPrice : null,
        toName: candidate.name,
        toItemId: candidate.id,
        toPrice: price,
        extraCost,
        dps: result.dps,
        dpsGain: gain,
        gainPct: (gain / dps.dps) * 100,
        gpPerDps: extraCost / gain,
      };
      // One suggestion per slot, and it is the biggest GAIN rather than the best ratio. A ranking
      // by gp-per-dps alone surfaces a 40k trinket worth +0.01 dps above a 200m weapon worth +2,
      // which is efficient and useless -- the ratio belongs in the ranking BETWEEN slots, not in
      // choosing what to offer for one.
      if (!best || gain > best.dpsGain) best = suggestion;
    }
    if (best) upgrades.push(best);
  }

  // Biggest gain first: the question is "what should I buy next", and the gp-per-dps figure rides
  // along so a cheap near-equal option is visible rather than hidden behind a marginally better
  // one costing ten times as much.
  upgrades.sort((a, b) => b.dpsGain - a.dpsGain);

  return { style: resolved.style, dps, unresolved: resolved.unresolved, upgrades };
}
