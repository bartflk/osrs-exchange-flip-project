import type { EquipmentItem, Monster } from "./gameData.js";

// A damage-per-second model, written from the combat formulas documented on the OSRS Wiki
// (Damage per second/Melee, /Ranged, /Magic and the Combat formula article) rather than ported
// from anyone's implementation.
//
// LICENCE: the wiki's own calculator is GPL-3.0. Its DATA is used (see gameData.ts); none of its
// code is copied, which is why this file exists at all instead of a vendored port.
//
// ---------------------------------------------------------------------------------------------
// WHAT THIS MODELS, AND WHAT IT DOES NOT
//
// Modelled: effective attack and strength with prayer and style bonuses, the standard accuracy
// roll (attack roll vs defence roll), max hit, attack speed, and the multiplicative gear effects
// that change which weapon actually wins -- Dragon hunter crossbow/lance vs dragons, Salve amulet
// vs undead, Void set bonuses, slayer helm on task, and Arclight/Emberlight vs demons.
//
// NOT modelled: special attacks, weapon-specific passives beyond the list above, defence
// reduction over a fight (DWH, Bandos godsword), multi-phase bosses, prayer drain, overhead
// protection, ticks lost to movement or eating, and anything about supplies. The wiki's own
// calculator spends 100KB on exactly this long tail, which is the honest reason a
// self-contained model is labelled an ESTIMATE everywhere it surfaces.
//
// Those specific effects are included and not others because they are the ones that change the
// ANSWER rather than the number: without the DHCB dragon bonus a gear optimiser recommends the
// wrong weapon for Vorkath with total confidence, which is worse than being 5% off.
// ---------------------------------------------------------------------------------------------

export type CombatStyle = "melee" | "ranged" | "magic";
export type AttackType = "stab" | "slash" | "crush" | "magic" | "ranged";

export interface PlayerSkills {
  attack: number;
  strength: number;
  defence: number;
  ranged: number;
  magic: number;
  hitpoints: number;
  prayer: number;
}

export interface DpsOptions {
  /** Multipliers from prayers, e.g. Piety = 1.20 attack / 1.23 strength. */
  prayerAttack?: number;
  prayerStrength?: number;
  /** True when the monster is the player's current slayer assignment. */
  onSlayerTask?: boolean;
}

export interface DpsResult {
  dps: number;
  maxHit: number;
  accuracy: number;
  attackSpeedTicks: number;
  /** Seconds to kill one monster at full hitpoints. */
  timeToKill: number;
  style: CombatStyle;
  attackType: AttackType;
  /** Human-readable list of the multiplicative effects that were applied. */
  effects: string[];
}

const TICK_SECONDS = 0.6;

function sum(items: EquipmentItem[], pick: (i: EquipmentItem) => number): number {
  return items.reduce((acc, i) => acc + (pick(i) || 0), 0);
}

function has(items: EquipmentItem[], re: RegExp): boolean {
  return items.some((i) => re.test(i.name));
}

/** The weapon is whichever equipped item occupies the weapon slot. */
function weaponOf(items: EquipmentItem[]): EquipmentItem | null {
  return items.find((i) => i.slot === "weapon") ?? null;
}

/**
 * Gear multipliers that apply to accuracy and damage together.
 *
 * Each is conditional on a monster ATTRIBUTE from the wiki data, which is the whole reason that
 * field mattered when choosing the data source. Salve and slayer helm deliberately do not stack:
 * in game the salve takes precedence, and stacking them would inflate every undead-slayer-task
 * estimate.
 */
function gearMultipliers(
  items: EquipmentItem[],
  monster: Monster,
  style: CombatStyle,
  opts: DpsOptions,
): { accuracy: number; damage: number; effects: string[] } {
  const attrs = new Set((monster.attributes ?? []).map((a) => a.toLowerCase()));
  const effects: string[] = [];
  let accuracy = 1;
  let damage = 1;

  const weapon = weaponOf(items);
  const weaponName = weapon?.name ?? "";

  if (attrs.has("dragon")) {
    if (/^Dragon hunter crossbow/i.test(weaponName) && style === "ranged") {
      accuracy *= 1.3;
      damage *= 1.25;
      effects.push("Dragon hunter crossbow vs dragon (+30% acc, +25% dmg)");
    } else if (/^Dragon hunter lance/i.test(weaponName) && style === "melee") {
      accuracy *= 1.2;
      damage *= 1.2;
      effects.push("Dragon hunter lance vs dragon (+20%)");
    } else if (/^Dragon hunter wand/i.test(weaponName) && style === "magic") {
      accuracy *= 1.5;
      damage *= 1.2;
      effects.push("Dragon hunter wand vs dragon (+50% acc, +20% dmg)");
    }
  }

  if (/^Arclight/i.test(weaponName) && (attrs.has("demon") || attrs.has("demonic"))) {
    accuracy *= 1.7;
    damage *= 1.7;
    effects.push("Arclight vs demon (+70%)");
  } else if (/^Emberlight/i.test(weaponName) && (attrs.has("demon") || attrs.has("demonic"))) {
    accuracy *= 1.7;
    damage *= 1.7;
    effects.push("Emberlight vs demon (+70%)");
  }

  // Salve beats the slayer helm rather than adding to it.
  const salveEi = has(items, /^Salve amulet\s?\(ei\)/i);
  const salveE = has(items, /^Salve amulet\s?\(e\)/i);
  const salveI = has(items, /^Salve amulet\s?\(i\)/i);
  const salve = has(items, /^Salve amulet$/i);
  const undead = attrs.has("undead");
  const slayerHelm = has(items, /Slayer helmet|Black mask/i);

  if (undead && (salveEi || salveE) && (style === "ranged" || style === "magic")) {
    accuracy *= 1.2;
    damage *= 1.2;
    effects.push("Salve amulet (e) vs undead (+20%)");
  } else if (undead && (salveI || salve) && style === "melee") {
    const mult = salve ? 7 / 6 : 7 / 6;
    accuracy *= mult;
    damage *= mult;
    effects.push("Salve amulet vs undead (+16.7%)");
  } else if (undead && salveI && style !== "melee") {
    accuracy *= 7 / 6;
    damage *= 7 / 6;
    effects.push("Salve amulet (i) vs undead (+16.7%)");
  } else if (opts.onSlayerTask && slayerHelm) {
    const mult = style === "melee" ? 7 / 6 : 1.15;
    accuracy *= mult;
    damage *= mult;
    effects.push(`Slayer helmet on task (+${style === "melee" ? "16.7" : "15"}%)`);
  }

  // Void: the full set, and the correct helm for the style.
  const voidPieces =
    has(items, /Void knight top|Elite void top/i) &&
    has(items, /Void knight robe|Elite void robe/i) &&
    has(items, /Void knight gloves/i);
  if (voidPieces) {
    if (style === "melee" && has(items, /Void melee helm/i)) {
      accuracy *= 1.1;
      damage *= 1.1;
      effects.push("Void melee set (+10%)");
    } else if (style === "ranged" && has(items, /Void ranger helm/i)) {
      accuracy *= 1.1;
      damage *= 1.1;
      effects.push("Void ranger set (+10% acc, +10% dmg)");
    } else if (style === "magic" && has(items, /Void mage helm/i)) {
      accuracy *= 1.45;
      effects.push("Void mage set (+45% acc)");
    }
  }

  return { accuracy, damage, effects };
}

/** Which of the five attack types this loadout actually rolls against. */
function bestAttackType(weapon: EquipmentItem | null, style: CombatStyle): AttackType {
  if (style === "ranged") return "ranged";
  if (style === "magic") return "magic";
  if (!weapon) return "crush";
  const o = weapon.offensive;
  const melee: [AttackType, number][] = [
    ["stab", o.stab],
    ["slash", o.slash],
    ["crush", o.crush],
  ];
  return melee.reduce((best, cur) => (cur[1] > best[1] ? cur : best))[0];
}

function monsterDefenceBonus(monster: Monster, type: AttackType): number {
  const d = monster.defensive;
  switch (type) {
    case "stab":
      return d.stab;
    case "slash":
      return d.slash;
    case "crush":
      return d.crush;
    case "magic":
      return d.magic;
    case "ranged":
      // The ranged split is by ammo weight. Standard is the honest default without modelling
      // which bolt is loaded.
      return d.standard ?? d.light ?? 0;
  }
}

export function computeDps(
  loadout: EquipmentItem[],
  monster: Monster,
  skills: PlayerSkills,
  style: CombatStyle,
  opts: DpsOptions = {},
): DpsResult {
  const weapon = weaponOf(loadout);
  const attackType = bestAttackType(weapon, style);
  const speed = weapon?.speed ?? 4;
  const { accuracy: accMult, damage: dmgMult, effects } = gearMultipliers(
    loadout,
    monster,
    style,
    opts,
  );

  const prayerAtk = opts.prayerAttack ?? 1;
  const prayerStr = opts.prayerStrength ?? 1;

  // Style bonus: +3 to the relevant stat on an aggressive/accurate style. Held at the neutral
  // +1 (controlled/rapid) so no loadout is flattered by a style the user never chose.
  const STYLE_BONUS = 1;

  let effectiveAttack: number;
  let effectiveStrength: number;
  let equipAttack: number;
  let equipStrength: number;

  if (style === "melee") {
    effectiveAttack = Math.floor(Math.floor(skills.attack * prayerAtk) + STYLE_BONUS + 8);
    effectiveStrength = Math.floor(Math.floor(skills.strength * prayerStr) + STYLE_BONUS + 8);
    equipAttack = sum(loadout, (i) =>
      attackType === "stab" ? i.offensive.stab : attackType === "slash" ? i.offensive.slash : i.offensive.crush,
    );
    equipStrength = sum(loadout, (i) => i.bonuses.str);
  } else if (style === "ranged") {
    effectiveAttack = Math.floor(Math.floor(skills.ranged * prayerAtk) + STYLE_BONUS + 8);
    effectiveStrength = Math.floor(Math.floor(skills.ranged * prayerStr) + STYLE_BONUS + 8);
    equipAttack = sum(loadout, (i) => i.offensive.ranged);
    equipStrength = sum(loadout, (i) => i.bonuses.ranged_str);
  } else {
    effectiveAttack = Math.floor(Math.floor(skills.magic * prayerAtk) + STYLE_BONUS + 8);
    effectiveStrength = skills.magic;
    equipAttack = sum(loadout, (i) => i.offensive.magic);
    equipStrength = sum(loadout, (i) => i.bonuses.magic_str);
  }

  const attackRoll = Math.floor(effectiveAttack * (equipAttack + 64) * accMult);

  const defenceLevel = monster.skills.def;
  const defenceRoll = (defenceLevel + 9) * (monsterDefenceBonus(monster, attackType) + 64);

  // Standard OSRS hit chance: the higher roll wins more often, and the loser's roll is compared
  // against a uniform draw. Asymmetric by design -- this is the game's formula, not an average.
  const accuracy =
    attackRoll > defenceRoll
      ? 1 - (defenceRoll + 2) / (2 * (attackRoll + 1))
      : attackRoll / (2 * (defenceRoll + 1));

  let maxHit: number;
  if (style === "magic") {
    // Without a spell selected there is no base damage to scale, so magic is reported as the
    // staff's own strength contribution and flagged as the weakest part of the model.
    maxHit = Math.floor((equipStrength / 100 + 1) * 10 * dmgMult);
  } else {
    const base = 0.5 + (effectiveStrength * (equipStrength + 64)) / 640;
    maxHit = Math.floor(Math.floor(base) * dmgMult);
  }

  const attackSeconds = speed * TICK_SECONDS;
  const dps = (accuracy * ((maxHit + 1) / 2)) / attackSeconds;
  const timeToKill = dps > 0 ? monster.skills.hp / dps : Infinity;

  return {
    dps,
    maxHit,
    accuracy,
    attackSpeedTicks: speed,
    timeToKill,
    style,
    attackType,
    effects,
  };
}
