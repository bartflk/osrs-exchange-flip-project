import { db, kvGet, kvSet } from "./db.js";
import { parseLuaReturnTable } from "./luaTable.js";
import { geTax } from "./signals.js";

// Every trainable action in the game, priced live: what one action costs, what it costs per point
// of experience, and, where the wiki states a rate, how fast it goes.
//
// The source is `Module:Skill calc/<Skill>`, the data behind the wiki's own skill calculators.
// That matters. The training GUIDES ("Pay-to-play Fletching training") are hand-written prose with
// a differently shaped table on every page, and scraping seventeen of those would be seventeen
// parsers rotting in parallel. The calculator modules are one schema across all seventeen skills,
// maintained by the same people, and they carry exactly the four facts a cost model needs: level,
// experience, materials with quantities, and what comes out.
//
// What the modules do NOT carry is a speed. There is no actions-per-hour field, so the "fastest"
// half of the question cannot be answered from this data alone. Rates therefore come from a small
// curated table below, every entry quoting the wiki sentence it came from, and a method with no
// sourced rate reports no experience per hour at all rather than a plausible-looking guess. The
// asymmetry is deliberate: a wrong cost is off by a percentage, a wrong rate is off by a factor.

const API = "https://oldschool.runescape.wiki/api.php";
const USER_AGENT = "osrs-flip-assistant/1.0 (local single-user GE tool)";
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const REQUEST_SPACING_MS = 150;

export const TRAINABLE_SKILLS = [
  "Agility",
  "Construction",
  "Cooking",
  "Crafting",
  "Farming",
  "Firemaking",
  "Fishing",
  "Fletching",
  "Herblore",
  "Hunter",
  "Magic",
  "Mining",
  "Prayer",
  "Runecraft",
  "Smithing",
  "Thieving",
  "Woodcutting",
] as const;

export type TrainableSkill = (typeof TRAINABLE_SKILLS)[number];

/**
 * Skills whose product is an item you can sell afterwards.
 *
 * The distinction decides whether the cost of an action is "materials" or "materials minus what
 * the product fetches", and getting it backwards is not a rounding error. Prayer's row for dragon
 * bones names the bones as both the material and the product, because the calculator identifies an
 * action by what you use it on; crediting the player for selling bones they just burned would make
 * the most expensive training in the game read as free.
 */
const SELLS_OUTPUT: ReadonlySet<string> = new Set([
  "Cooking",
  "Crafting",
  "Fletching",
  "Herblore",
  "Runecraft",
  "Smithing",
]);

/** Skills with no materials at all: the cost axis is meaningless, only the speed axis applies. */
const GATHERING: ReadonlySet<string> = new Set([
  "Agility",
  "Fishing",
  "Hunter",
  "Mining",
  "Thieving",
  "Woodcutting",
]);

interface RawMethod {
  name: string;
  title?: string;
  level: number;
  xp: number;
  type?: string;
  members?: string;
  materials?: { name: string; quantity: number }[];
  outputQuantity?: number;
  outputCost?: number;
  outputItem?: string;
}

/**
 * Actions per hour, by skill and the wiki's own method type, each quoting its source.
 *
 * Short on purpose. Every entry here is a sentence someone wrote on a training guide, and the ones
 * missing are missing because no such sentence exists, not because they were forgotten. The note
 * travels with the number all the way to the screen so the assumption is never invisible: a rate
 * is the difference between "this method is cheap" and "this method is cheap and will take you
 * four hundred hours".
 */
const RATES: Record<string, { actionsPerHour: number; note: string }> = {
  "Herblore/Regular potions": {
    actionsPerHour: 2500,
    note: "Wiki: around 2,500 potions per hour when banking quickly after each inventory.",
  },
  "Herblore/Regular potions, Popular": {
    actionsPerHour: 2500,
    note: "Wiki: around 2,500 potions per hour when banking quickly after each inventory.",
  },
  "Herblore/Divine potions": {
    actionsPerHour: 2500,
    note: "Wiki: around 2,500 potions per hour when banking quickly after each inventory.",
  },
  "Herblore/Barbarian potions": {
    actionsPerHour: 2500,
    note: "Wiki: around 2,500 potions per hour when banking quickly after each inventory.",
  },
  "Herblore/Cleaning grimy herbs": {
    actionsPerHour: 3000,
    note: "Wiki: up to 3,000 herbs per hour using the auto-clean method.",
  },
  "Fletching/Bows": {
    actionsPerHour: 1800,
    note: "Wiki: 1,800 actions per hour, or about 2,700 with a fletching knife.",
  },
  "Fletching/Crossbows": {
    actionsPerHour: 1800,
    note: "Wiki: 1,800 actions per hour, or about 2,700 with a fletching knife.",
  },
  "Fletching/Shields": {
    actionsPerHour: 1800,
    note: "Wiki: 1,800 actions per hour, or about 2,700 with a fletching knife.",
  },
  "Fletching/Arrows": {
    actionsPerHour: 2000,
    note: "Wiki: the ammunition tables assume roughly 2,000 actions per hour.",
  },
  "Fletching/Bolts": {
    actionsPerHour: 2000,
    note: "Wiki: the ammunition tables assume roughly 2,000 actions per hour.",
  },
  "Fletching/Javelins": {
    actionsPerHour: 2000,
    note: "Wiki: the ammunition tables assume roughly 2,000 actions per hour.",
  },
  "Fletching/Darts": {
    actionsPerHour: 2000,
    note: "Wiki: the ammunition tables assume roughly 2,000 actions per hour.",
  },
  "Cooking/Baked": {
    actionsPerHour: 1885,
    note: "Wiki: the pie tables assume 1,885 pies baked per hour.",
  },
  "Prayer/Regular": {
    actionsPerHour: 2550,
    note: "Wiki: 2,550 bones per hour using bones on an altar manually, with good banking.",
  },
  "Firemaking/Regular": {
    actionsPerHour: 1485,
    note: "Wiki: the burning table assumes 1,485 logs per hour.",
  },
  "Firemaking/Pyre": {
    actionsPerHour: 1470,
    note: "Wiki: 1,470 pyre logs per hour without tick manipulation, 4,600 when 1-ticking.",
  },
  "Runecraft/Tiara": {
    actionsPerHour: 1450,
    note: "Wiki: the tiara rates assume 1,450 made per hour.",
  },
  "Crafting/Battlestaff": {
    actionsPerHour: 2625,
    note: "Wiki: up to 2,625 battlestaves crafted per hour with perfect banking.",
  },
  "Magic/Alchemy": {
    actionsPerHour: 1200,
    note: "Wiki: about 1,200 casts per hour at optimal clicking speed.",
  },
};

// --- fetching and caching -----------------------------------------------------------------

async function fetchModule(skill: string): Promise<string> {
  const page = encodeURIComponent(`Module:Skill calc/${skill}`);
  const url = `${API}?action=parse&page=${page}&prop=wikitext&format=json&formatversion=2`;
  const res = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
  const body = (await res.json()) as { parse?: { wikitext?: string }; error?: { info?: string } };
  // MediaWiki reports failures as HTTP 200 with an `error` body, so res.ok proves nothing here.
  if (body.error) throw new Error(`wiki error for ${skill}: ${body.error.info ?? "unknown"}`);
  const text = body.parse?.wikitext;
  if (!text) throw new Error(`no wikitext for ${skill}`);
  return text;
}

function cacheKey(skill: string): string {
  return `skillcalc:${skill}`;
}

/**
 * Raw method rows for one skill, from cache when fresh.
 *
 * A fetch or parse failure falls back to whatever is cached rather than throwing, because the
 * alternative is that one malformed edit on the wiki empties a page of this app until somebody
 * fixes it over there.
 */
async function loadSkill(skill: string, force = false): Promise<RawMethod[]> {
  const cached = kvGet(cacheKey(skill));
  const fresh = cached != null && Date.now() - cached.updatedAt < CACHE_TTL_MS;
  if (cached && fresh && !force) {
    try {
      return JSON.parse(cached.value) as RawMethod[];
    } catch {
      // Corrupt cache entry, fall through and refetch.
    }
  }

  try {
    const text = await fetchModule(skill);
    const rows = parseLuaReturnTable(text) as unknown as RawMethod[];
    if (!Array.isArray(rows) || rows.length === 0) throw new Error(`empty table for ${skill}`);
    kvSet(cacheKey(skill), JSON.stringify(rows));
    return rows;
  } catch (err) {
    if (cached) {
      try {
        return JSON.parse(cached.value) as RawMethod[];
      } catch {
        // Nothing usable cached either, report the live failure below.
      }
    }
    throw err;
  }
}

export async function refreshSkillTraining(
  force = false,
): Promise<{ skill: string; rows: number }[]> {
  const out: { skill: string; rows: number }[] = [];
  for (const skill of TRAINABLE_SKILLS) {
    try {
      const rows = await loadSkill(skill, force);
      out.push({ skill, rows: rows.length });
    } catch {
      out.push({ skill, rows: 0 });
    }
    await new Promise((resolve) => setTimeout(resolve, REQUEST_SPACING_MS));
  }
  return out;
}

export function skillTrainingPopulated(): boolean {
  return TRAINABLE_SKILLS.some((s) => kvGet(cacheKey(s)) != null);
}

// --- pricing ------------------------------------------------------------------------------

interface PricedItem {
  id: number;
  name: string;
  icon: string | null;
  high: number | null;
  low: number | null;
  /** Units traded in the last hour, both sides. */
  volume: number;
}

const catalogueStmt = db.prepare(`
  SELECT i.id AS id, i.name AS name, i.icon AS icon, s.high AS high, s.low AS low,
         COALESCE(s.vol_high_1h, 0) + COALESCE(s.vol_low_1h, 0) AS volume
  FROM items i LEFT JOIN latest_snapshot s ON s.item_id = i.id
`);

function priceCatalogue(): Map<string, PricedItem> {
  const rows = catalogueStmt.all() as unknown as PricedItem[];
  const map = new Map<string, PricedItem>();
  for (const r of rows) map.set(r.name.toLowerCase(), r);
  return map;
}

export interface TrainingMaterial {
  name: string;
  quantity: number;
  itemId: number | null;
  icon: string | null;
  /** Buy price per unit, or null when this material is not traded on the GE. */
  unitPrice: number | null;
}

export interface TrainingMethod {
  id: string;
  skill: string;
  /** Item or action produced. */
  name: string;
  /** What the wiki calls this row, which separates e.g. stringing a bow from fletching one. */
  title: string;
  type: string;
  level: number;
  /** Experience for one action. */
  xp: number;
  members: boolean;
  materials: TrainingMaterial[];
  outputItemId: number | null;
  outputIcon: string | null;
  outputQuantity: number;
  /** Gp back per action after GE tax. Zero for skills that consume what they make. */
  outputValue: number;
  /** Materials minus output. Positive costs you money, negative pays you to train. */
  costPerAction: number | null;
  /** The headline: gp burnt per experience point. Negative means the method turns a profit. */
  gpPerXp: number | null;
  actionsPerHour: number | null;
  rateNote: string | null;
  xpPerHour: number | null;
  /** Gp per hour at that rate. Negative is a cost, which is the usual case. */
  gpPerHour: number | null;
  /** Materials with no live GE price, which is why costPerAction can be null. */
  unpricedMaterials: string[];
  /** True when the product has no sale value here, so the cost is the materials alone. */
  consumesOutput: boolean;
  /**
   * Units of the product traded per hour, or null when nothing is sold.
   *
   * The reason this is on the row at all: without it the profit ranking is topped by junk. Fried
   * mushrooms priced out at 96k profit per cook and bronze claws at 48k, both because a dead item
   * with two trades a day carries whatever price the last two traders agreed on. The number is
   * more honest than a hidden filter, because "profitable but nobody buys it" is a real and
   * useful thing to know, as long as it is labelled.
   */
  outputVolume: number | null;
}

function stripMarkup(text: string): string {
  return text
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function priceMethod(
  skill: string,
  raw: RawMethod,
  catalogue: Map<string, PricedItem>,
): TrainingMethod | null {
  if (!raw.name || typeof raw.xp !== "number" || typeof raw.level !== "number") return null;

  // The wiki writes some titles with a line break in them ("Ninja impling<br>(Puro-Puro)"), which
  // is markup for its own tables, not part of the name.
  const title = stripMarkup(raw.title ?? raw.name);
  const type = raw.type ?? "Other";
  const materials: TrainingMaterial[] = [];
  const unpricedMaterials: string[] = [];
  let inputCost = 0;
  let costKnown = true;

  for (const m of raw.materials ?? []) {
    const item = catalogue.get(m.name.toLowerCase());
    // Buy at `low`: that is where an offer at the current bid actually fills, and knowing that
    // number rather than reading a stale wiki price is the entire reason this app exists.
    const unit = item?.low ?? item?.high ?? null;
    materials.push({
      name: m.name,
      quantity: m.quantity,
      itemId: item?.id ?? null,
      icon: item?.icon ?? null,
      unitPrice: unit,
    });
    if (unit == null) {
      unpricedMaterials.push(m.name);
      costKnown = false;
    } else {
      inputCost += unit * m.quantity;
    }
  }

  const outputName = raw.outputItem ?? raw.name;
  const outputItem = catalogue.get(outputName.toLowerCase()) ?? null;
  const outputQuantity = raw.outputQuantity ?? 1;
  // An explicit `outputItem` is the module saying this action turns one item into a different
  // one, so it always sells even in a skill that normally consumes what it touches. Without this
  // every bolt enchant read as costing the price of the bolts, which is the opposite of the truth:
  // you get the bolts back, enchanted and worth more.
  const consumesOutput =
    raw.outputItem == null && (!SELLS_OUTPUT.has(skill) || raw.outputCost === 0);

  let outputValue = 0;
  if (raw.outputCost != null) {
    // The module states a value explicitly, usually 0 for furniture and other built things.
    outputValue = raw.outputCost;
  } else if (!consumesOutput && outputItem?.high != null) {
    const gross = outputItem.high;
    outputValue = (gross - geTax(gross)) * outputQuantity;
  }

  const costPerAction = costKnown ? inputCost - outputValue : null;
  const gpPerXp = costPerAction != null && raw.xp > 0 ? costPerAction / raw.xp : null;

  const rate = RATES[`${skill}/${type}`] ?? null;
  const actionsPerHour = rate?.actionsPerHour ?? null;

  return {
    id: `${skill}:${title}:${raw.level}`,
    skill,
    name: raw.name,
    title,
    type,
    level: raw.level,
    xp: raw.xp,
    members: raw.members !== "No",
    materials,
    outputItemId: consumesOutput ? null : (outputItem?.id ?? null),
    outputIcon: consumesOutput ? null : (outputItem?.icon ?? null),
    outputQuantity,
    outputValue,
    costPerAction,
    gpPerXp,
    actionsPerHour,
    rateNote: rate?.note ?? null,
    xpPerHour: actionsPerHour != null ? raw.xp * actionsPerHour : null,
    gpPerHour:
      actionsPerHour != null && costPerAction != null ? -costPerAction * actionsPerHour : null,
    unpricedMaterials,
    consumesOutput,
    outputVolume: consumesOutput ? null : (outputItem?.volume ?? null),
  };
}

/**
 * Make repeated rows tell themselves apart.
 *
 * The wiki names four different actions "Lvl-7 Enchant", one per piece of onyx jewellery, and they
 * differ only in their materials. Left alone the page shows four identical lines with wildly
 * different prices, which reads as a bug in this app rather than a fact about the spell.
 */
function disambiguate(methods: TrainingMethod[]): TrainingMethod[] {
  const counts = new Map<string, number>();
  for (const m of methods) counts.set(m.title, (counts.get(m.title) ?? 0) + 1);
  const seen = new Map<string, number>();
  return methods.map((m) => {
    if ((counts.get(m.title) ?? 0) < 2) return m;
    const n = (seen.get(m.title) ?? 0) + 1;
    seen.set(m.title, n);
    // The last non-rune material is what actually varies between these rows: the four Lvl-7
    // Enchants differ by which piece of onyx jewellery goes in, and every one of them also takes
    // a cosmic rune. Naming the rune would label all four identically again.
    const notRune = [...m.materials].reverse().find((x) => !/runes?$/i.test(x.name));
    const distinguishing = (notRune ?? m.materials[m.materials.length - 1])?.name;
    return {
      ...m,
      id: `${m.id}#${n}`,
      title: distinguishing ? `${m.title} (${distinguishing})` : `${m.title} ${n}`,
    };
  });
}

export interface SkillTrainingResult {
  methods: TrainingMethod[];
  /** Skills that failed to load, so the UI can say so rather than pass a short list off as whole. */
  failed: string[];
  gatheringSkills: string[];
}

export async function getTrainingMethods(skills?: string[]): Promise<SkillTrainingResult> {
  const wanted = (skills?.length ? skills : [...TRAINABLE_SKILLS]).filter((s) =>
    (TRAINABLE_SKILLS as readonly string[]).includes(s),
  );
  const catalogue = priceCatalogue();
  const methods: TrainingMethod[] = [];
  const failed: string[] = [];

  for (const skill of wanted) {
    let rows: RawMethod[];
    try {
      rows = await loadSkill(skill);
    } catch {
      failed.push(skill);
      continue;
    }
    const forSkill: TrainingMethod[] = [];
    for (const raw of rows) {
      const priced = priceMethod(skill, raw, catalogue);
      if (priced) forSkill.push(priced);
    }
    methods.push(...disambiguate(forSkill));
  }

  return { methods, failed, gatheringSkills: [...GATHERING] };
}
