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
 * Versions that are the item in a NON-working state.
 *
 * Written as a deny-list rather than a list of good versions, which is the second attempt. An
 * allow-list of "Normal, Charged, Unpoisoned" looked complete and silently failed on crystal gear,
 * which the data versions as Active/Inactive: neither was allowed, the code fell through to
 * whichever entry came first, and Zulrah's ranged setup scored 1.06 dps wearing an inactive
 * crystal helm and body. A deny-list fails the safe way, since a version name nobody has seen yet
 * is far more likely to be a working variant than a broken one.
 */
const DEGRADED_VERSIONS = new Set([
  "broken",
  "locked",
  "inactive",
  "uncharged",
  "damaged",
  "deactivated",
  "empty",
]);

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

function isWorking(item: EquipmentItem): boolean {
  return !DEGRADED_VERSIONS.has((item.version ?? "").toLowerCase());
}

function pickVersion(candidates: EquipmentItem[]): EquipmentItem {
  return candidates.find(isWorking) ?? candidates[0];
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

/**
 * DPS across every form of the boss, not against one of them.
 *
 * Weighted the only way that is actually correct for a fight you must finish: the time spent on a
 * form is its hitpoints divided by your DPS against it, so the DPS for the whole fight is total
 * hitpoints over total time. A flat mean would flatter a setup that melts two forms and stalls on
 * the third, which is precisely the Zulrah case -- Magma carries 300 ranged defence, Tanzanite 0.
 *
 * Reduces to the plain figure for the overwhelming majority of bosses, which have one form.
 */
function effectiveDps(
  loadout: EquipmentItem[],
  forms: Monster[],
  skills: PlayerSkills,
  style: CombatStyle,
): { dps: DpsResult; perForm: { form: string; dps: number }[] } {
  const results = forms.map((form) => ({
    form: form.version || form.name,
    hp: form.skills.hp,
    result: computeDps(loadout, form, skills, style, PRAYERS),
  }));

  const totalHp = results.reduce((acc, r) => acc + r.hp, 0);
  const totalTime = results.reduce(
    (acc, r) => acc + (r.result.dps > 0 ? r.hp / r.result.dps : Infinity),
    0,
  );
  const combined = Number.isFinite(totalTime) && totalTime > 0 ? totalHp / totalTime : 0;

  // The reported max hit and accuracy come from the form the fight spends longest on, since a
  // weighted average of a max hit is not a number that means anything.
  const slowest = results.reduce((worst, r) =>
    (r.result.dps > 0 ? r.hp / r.result.dps : Infinity) >
    (worst.result.dps > 0 ? worst.hp / worst.result.dps : Infinity)
      ? r
      : worst,
  );

  return {
    dps: { ...slowest.result, dps: combined, timeToKill: combined > 0 ? totalHp / combined : Infinity },
    perForm: results.map((r) => ({ form: r.form, dps: r.result.dps })),
  };
}

export interface BuildStep {
  slot: string;
  fromName: string | null;
  toName: string;
  extraCost: number;
  dpsAfter: number;
}

export interface SetupDpsResult {
  style: CombatStyle;
  dps: DpsResult | null;
  unresolved: string[];
  upgrades: UpgradeSuggestion[];
  /**
   * Why no DPS figure is given, when there is none. Null when the number is sound.
   *
   * Magic is the case this exists for. The model has no spell: a staff's damage is taken from its
   * magic damage BONUS, which is exactly backwards for the staves people actually use. Tumeken's
   * shadow and the Sanguinesti staff carry a bonus of 0 because their damage comes from a built-in
   * spell, while a Kodai wand carries 150 because it amplifies a spell you cast yourself. Scoring
   * on the bonus alone therefore ranks the wand above the shadow, which is not a small error to
   * caveat, it is the wrong answer. A missing number beats a confidently wrong one.
   */
  dpsUnavailable: string | null;
  /** The affordable build, applied greedily from the wiki setup. Empty when nothing fits. */
  build: BuildStep[];
  buildDps: number | null;
  buildSpend: number;
  /** DPS against each form, when the boss has more than one. */
  perForm: { form: string; dps: number }[];
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
  forms: Monster[],
  skills: PlayerSkills,
  spare: number,
): Promise<SetupDpsResult> {
  const resolved = await resolveSetupLoadout(setup);
  const base = legalise(resolved.items, resolved.style);
  if (base.length === 0) {
    return {
      style: resolved.style,
      dps: null,
      unresolved: resolved.unresolved,
      upgrades: [],
      dpsUnavailable: "This setup lists no worn equipment, only an inventory.",
      build: [],
      buildDps: null,
      buildSpend: 0,
      perForm: [],
    };
  }

  // The same prayer assumption the gear optimiser uses (Piety / Rigour equivalent), so the two
  // panels on the same row are directly comparable. Two DPS figures side by side under different
  // assumptions would be worse than showing one.
  const dpsUnavailable = magicUnsupported(base, resolved.style);
  const scored = effectiveDps(base, forms, skills, resolved.style);
  const dps = scored.dps;

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
      if (!isWorking(candidate)) continue;

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
      const result = effectiveDps(swapped, forms, skills, resolved.style).dps;
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

  if (dpsUnavailable) {
    return {
      style: resolved.style,
      dps: null,
      unresolved: resolved.unresolved,
      upgrades: [],
      dpsUnavailable,
      build: [],
      buildDps: null,
      buildSpend: 0,
      perForm: [],
    };
  }

  const build = planBuild(base, forms, skills, resolved.style, prices, equipment, spare, dps.dps);

  return {
    style: resolved.style,
    dps,
    unresolved: resolved.unresolved,
    upgrades,
    dpsUnavailable: null,
    build: build.steps,
    buildDps: build.steps.length > 0 ? build.dps : null,
    buildSpend: build.spend,
    perForm: scored.perForm.length > 1 ? scored.perForm : [],
  };
}

/**
 * Whether this loadout is one the magic model cannot score.
 *
 * Everything except a powered staff, which is the only magic weapon whose damage does not depend
 * on a spell the player chooses and this model does not track. The data distinguishes them
 * cleanly: "Powered Staff" for Tumeken's shadow, the Sanguinesti staff and the tridents, "Staff"
 * for a Kodai wand.
 *
 * Powered staves are not scored either, for now: their max hit comes from the built-in spell and
 * this model has no table of those. Reporting the category honestly is better than guessing at
 * numbers, and the gap is narrow and clearly stated rather than silently wrong across the board.
 */
function magicUnsupported(loadout: EquipmentItem[], style: CombatStyle): string | null {
  if (style !== "magic") return null;
  const weapon = loadout.find((i) => i.slot === "weapon");
  const cat = (weapon?.category ?? "").toLowerCase();
  if (cat === "powered staff") {
    return "Powered staves deal damage through a built-in spell, and this model has no table of those max hits.";
  }
  return "Magic damage depends on the spell cast, which this model does not track. A staff's magic damage bonus alone would rank a Kodai wand above Tumeken's shadow.";
}

/**
 * The best build you can actually afford, starting from the wiki's setup.
 *
 * Greedy, one slot at a time, always taking the biggest remaining gain that still fits. This
 * replaces a free search over all 2,160 items, which was the source of every nonsense
 * recommendation on this page: it proposed a Webweaver bow for the Doom of Mokhaiotl, an Elder
 * maul melee build for a boss people range, and a Kodai wand "magic" build that is not a build at
 * all. Starting from the wiki's loadout keeps the weapon and the style that the fight actually
 * calls for, and asks only the question this model can answer -- which armour and jewellery to
 * put around it for the money available.
 */
function planBuild(
  base: EquipmentItem[],
  forms: Monster[],
  skills: PlayerSkills,
  style: CombatStyle,
  prices: Map<number, number>,
  equipment: EquipmentItem[],
  spare: number,
  startingDps: number,
): { steps: BuildStep[]; dps: number; spend: number } {
  let current = [...base];
  let currentDps = startingDps;
  let remaining = spare;
  const steps: BuildStep[] = [];
  const done = new Set<string>();

  // Bounded rather than while(true): one improvement per slot is the most this can honestly
  // claim, and an unbounded loop on a greedy search over live prices is how a request hangs.
  for (let pass = 0; pass < UPGRADE_SLOTS.length; pass++) {
    let best: { step: BuildStep; items: EquipmentItem[]; dps: number } | null = null;

    for (const slot of UPGRADE_SLOTS) {
      if (done.has(slot)) continue;
      const worn = current.find((i) => i.slot === slot) ?? null;
      const wornPrice = worn ? (prices.get(worn.id) ?? 0) : 0;
      const ceiling = remaining + wornPrice;

      for (const candidate of equipment) {
        if (candidate.slot !== slot) continue;
        if (worn && candidate.id === worn.id) continue;
        const price = prices.get(candidate.id);
        if (price == null || price > ceiling) continue;
        if (!isWorking(candidate)) continue;
        if (/\(e\)$/i.test(worn?.name ?? "") && !/\(e\)$/i.test(candidate.name)) continue;

        const swapped = legalise([...current.filter((i) => i.slot !== slot), candidate], style);
        const result = effectiveDps(swapped, forms, skills, style).dps;
        const gain = result.dps - currentDps;
        if (gain <= currentDps * MIN_GAIN_FRACTION) continue;
        if (best && result.dps <= best.dps) continue;

        best = {
          step: {
            slot,
            fromName: worn?.name ?? null,
            toName: candidate.name,
            extraCost: Math.max(0, price - wornPrice),
            dpsAfter: result.dps,
          },
          items: swapped,
          dps: result.dps,
        };
      }
    }

    if (!best) break;
    steps.push(best.step);
    current = best.items;
    currentDps = best.dps;
    remaining -= best.step.extraCost;
    done.add(best.step.slot);
  }

  return { steps, dps: currentDps, spend: spare - remaining };
}
