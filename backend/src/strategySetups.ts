import { db } from "./db.js";

// The wiki's own "Inventory setups" from a boss's Strategies page, rendered as the real equipment
// silhouette and a 28-slot inventory rather than as a list of names.
//
// The money-making guides carry an `Item` list, but it is prose: "Elite Void Knight equipment",
// "Food and potions", "Ava's assembler (or other Ava's device)". Useful, and not a loadout. The
// Strategies pages carry the actual thing, in three well-structured templates:
//
//   {{Equipment|head=|cape=|neck=|ammo=|weapon=|torso=|legs=|shield=|gloves=|boots=|ring=}}
//   {{Inventory|1=|2=|...|28=}}
//   {{Rune pouch|1=|2=|3=|4=}}
//
// wrapped in a <tabber> whose section names are the variants players actually choose between
// ("Max Ranged", "Budget"). That last part is what makes this worth scraping: a budget setup and
// a max setup are different answers to "what can I afford", which is the question this app is
// built around, and the wiki has already done the work of separating them.
//
// Fetched ON DEMAND, per boss, when a row is expanded. There are 639 guides and only a fraction
// are bosses with a Strategies page; scraping them all on refresh would be several hundred
// requests to answer a question nobody asked.

const API = "https://oldschool.runescape.wiki/api.php";
const USER_AGENT = "osrs-flip-assistant/1.0 (local single-user GE tool)";
const CACHE_TTL_SECONDS = 7 * 24 * 60 * 60;

/** Worn slots, in the order the in-game equipment interface lays them out. */
export const EQUIPMENT_SLOTS = [
  "head",
  "cape",
  "neck",
  "ammo",
  "weapon",
  "torso",
  "shield",
  "legs",
  "gloves",
  "boots",
  "ring",
] as const;

export type EquipmentSlot = (typeof EQUIPMENT_SLOTS)[number];

export interface SetupItem {
  name: string;
  itemId: number | null;
  icon: string | null;
  price: number | null;
}

export interface StrategySetup {
  /** The tabber section name: "Max Ranged", "Budget", and so on. */
  variant: string;
  equipment: Partial<Record<EquipmentSlot, SetupItem>>;
  /** 28 entries, nulls for empty slots, so the grid renders in the right shape. */
  inventory: (SetupItem | null)[];
  runePouch: SetupItem[];
  /**
   * What the tradeable half of this setup costs at live prices.
   *
   * A floor, and labelled as one everywhere it is shown. Untradeables (void, quest items, capes)
   * resolve to no price, and quoting a total that silently omits them would understate the real
   * barrier to entry on exactly the setups where the barrier is the point.
   */
  cost: number;
  pricedCount: number;
  totalCount: number;
}

export interface StrategySetupsResult {
  /** The wiki page the setups came from, so the claim is checkable. */
  page: string | null;
  setups: StrategySetup[];
}

db.exec(`
  CREATE TABLE IF NOT EXISTS strategy_setups (
    monster TEXT PRIMARY KEY,
    page TEXT,
    setups_json TEXT NOT NULL,
    fetched_at INTEGER NOT NULL
  )
`);

const getCacheStmt = db.prepare(
  `SELECT page, setups_json, fetched_at FROM strategy_setups WHERE monster = ?`,
);
const putCacheStmt = db.prepare(
  `INSERT INTO strategy_setups (monster, page, setups_json, fetched_at)
   VALUES (?, ?, ?, ?)
   ON CONFLICT(monster) DO UPDATE SET
     page = excluded.page, setups_json = excluded.setups_json, fetched_at = excluded.fetched_at`,
);

const itemStmt = db.prepare(
  `SELECT i.id, i.icon, s.low, s.high FROM items i
   LEFT JOIN latest_snapshot s ON s.item_id = i.id
   WHERE LOWER(i.name) = LOWER(?) LIMIT 1`,
);

/**
 * A money-maker activity turned into candidate Strategies page titles.
 *
 * Guide titles and page titles do not line up, and the mismatches are systematic rather than
 * random: guides carry a method suffix ("using Dragon hunter crossbow"), a scope in parentheses
 * ("(Delve 1-16)", "(duo)"), and sometimes a leading article the article-less page drops
 * ("Killing The Doom of Mokhaiotl" vs "Doom of Mokhaiotl/Strategies"). Rather than guess which
 * transformation applies, every candidate is generated and all of them are checked in ONE
 * `titles=A|B|C` request, which the API accepts natively.
 */
export function strategyPageCandidates(activity: string): string[] {
  const base = activity
    .replace(/^(Killing|Fighting|Completing|Defeating)\s+/i, "")
    .split(/ using | with /i)[0]
    .trim();

  const withoutScope = base.replace(/\s*\([^)]*\)\s*$/, "").trim();
  const names = new Set<string>();
  for (const n of [base, withoutScope]) {
    if (!n) continue;
    names.add(n);
    // "The Doom of Mokhaiotl" is the guide's wording; the page is "Doom of Mokhaiotl".
    names.add(n.replace(/^The\s+/i, ""));
    // Plural guide wording against a singular page: "Killing green dragons".
    if (/s$/i.test(n)) names.add(n.replace(/s$/i, ""));
  }
  return [...names].filter(Boolean).map((n) => `${n}/Strategies`);
}

function headers() {
  return { "User-Agent": USER_AGENT, Accept: "application/json" };
}

/** Which of the candidate pages actually exists, in candidate order. */
async function resolveStrategyPage(candidates: string[]): Promise<string | null> {
  if (candidates.length === 0) return null;
  const url =
    `${API}?action=query&format=json&formatversion=2&redirects=1` +
    `&titles=${encodeURIComponent(candidates.join("|"))}`;
  const res = await fetch(url, { headers: headers() });
  if (!res.ok) return null;
  const json = (await res.json()) as {
    query?: {
      pages?: { title: string; missing?: boolean }[];
      normalized?: { from: string; to: string }[];
      redirects?: { from: string; to: string }[];
    };
  };
  const pages = json.query?.pages ?? [];
  const existing = new Set(pages.filter((p) => !p.missing).map((p) => p.title));
  if (existing.size === 0) return null;

  // Candidate ORDER is the priority order -- the most specific title first -- so the API's own
  // page ordering must not be allowed to decide. Redirects and title normalisation are followed
  // so a candidate that resolved indirectly still matches its landing page.
  const rename = new Map<string, string>();
  for (const r of [...(json.query?.normalized ?? []), ...(json.query?.redirects ?? [])]) {
    rename.set(r.from, r.to);
  }
  for (const candidate of candidates) {
    const resolved = rename.get(candidate) ?? candidate;
    if (existing.has(resolved)) return resolved;
    if (existing.has(candidate)) return candidate;
  }
  return [...existing][0];
}

/**
 * Template parameters, split at depth 0 so nested links and templates keep their pipes.
 *
 * Handles POSITIONAL parameters as well as named ones, and it has to: the wiki uses both forms of
 * {{Inventory}} interchangeably. The Doom of Mokhaiotl writes `|1 = Darklight`, while Phosani's
 * Nightmare writes the 28 items bare, `|Tumeken's shadow|Ancestral hat|...`. Reading only the
 * named form parsed the equipment on those pages and silently returned an empty inventory beside
 * it, which looks like a boss you fight with nothing in your bag rather than like a parser bug.
 *
 * Positional numbering counts only unnamed parameters, exactly as MediaWiki does, so a
 * `buttons = No` sitting among them does not shift every following item by one slot.
 */
function splitTemplateParams(body: string): Map<string, string> {
  const params = new Map<string, string>();
  let depth = 0;
  let current = "";
  let positional = 0;
  const flush = () => {
    const eq = current.indexOf("=");
    if (eq > 0) {
      params.set(current.slice(0, eq).trim().toLowerCase(), current.slice(eq + 1).trim());
    } else if (current.trim()) {
      positional++;
      params.set(String(positional), current.trim());
    }
    current = "";
  };
  for (let i = 0; i < body.length; i++) {
    const two = body.slice(i, i + 2);
    if (two === "{{" || two === "[[") {
      depth++;
      current += two;
      i++;
      continue;
    }
    if (two === "}}" || two === "]]") {
      depth--;
      current += two;
      i++;
      continue;
    }
    if (body[i] === "|" && depth === 0) {
      flush();
      continue;
    }
    current += body[i];
  }
  flush();
  return params;
}

/** Every {{name|...}} occurrence in the text, brace-matched rather than regex-terminated. */
function findTemplates(text: string, name: string): { body: string; start: number }[] {
  const out: { body: string; start: number }[] = [];
  const re = new RegExp(`\\{\\{\\s*${name}\\s*[|}]`, "gi");
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    let depth = 0;
    for (let i = m.index; i < text.length; i++) {
      if (text.slice(i, i + 2) === "{{") {
        depth++;
        i++;
      } else if (text.slice(i, i + 2) === "}}") {
        depth--;
        i++;
        if (depth === 0) {
          const whole = text.slice(m.index + 2, i - 1);
          const pipe = whole.indexOf("|");
          out.push({ body: pipe < 0 ? "" : whole.slice(pipe + 1), start: m.index });
          re.lastIndex = i;
          break;
        }
      }
    }
  }
  return out;
}

function cleanItemName(raw: string): string {
  return raw
    .replace(/\[\[([^\]|]+)\|([^\]]*)\]\]/g, "$1")
    .replace(/\[\[([^\]]+)\]\]/g, "$1")
    .replace(/\{\{[^}]*\}\}/g, "")
    .replace(/''+/g, "")
    .replace(/<[^>]*>/g, "")
    .trim();
}

function lookupItem(rawName: string): SetupItem | null {
  const name = cleanItemName(rawName);
  if (!name || /^(none|n\/a|-)$/i.test(name)) return null;
  const row = itemStmt.get(name) as
    | { id: number; icon: string | null; low: number | null; high: number | null }
    | undefined;
  return {
    name,
    itemId: row?.id ?? null,
    icon: row?.icon ?? null,
    // Gear is bought, so the insta-buy price is the honest one, matching every other cost in
    // this app.
    price: row?.high ?? row?.low ?? null,
  };
}

/** One <tabber> block split into its named sections. */
function splitTabber(inner: string): { variant: string; text: string }[] {
  const out: { variant: string; text: string }[] = [];
  // Sections are separated by "|-|" and each opens with "Name =".
  for (const chunk of inner.split(/\|-\|/)) {
    const m = chunk.match(/^\s*([^=|\n][^=\n]*?)\s*=\s*([\s\S]*)$/);
    if (!m) continue;
    out.push({ variant: m[1].trim(), text: m[2] });
  }
  return out;
}

/**
 * Every candidate group of setups on the page, found by locating the TEMPLATES rather than by
 * scoping to a heading.
 *
 * The first version of this scoped to a heading whitelist and found setups on exactly one of the
 * four bosses it was tested against. The headings are simply not standardised: the Doom of
 * Mokhaiotl files them under "Inventory setups", Zulrah under "Setup" with "Equipment" and
 * "Inventory Setups" beneath it, and both Phosani's Nightmare and the Maggot King under a bare
 * "Equipment". Any whitelist long enough to catch those four is still a guess about the fifth.
 *
 * Where the {{Equipment}} and {{Inventory}} templates sit is not a guess, so that is what is
 * searched. The risk this trades for is picking up a situational aside -- "wear this for phase
 * two" -- and that is handled by scoring rather than by filtering: the group with the most filled
 * slots wins, because a real loadout always has more in it than a one-off note.
 */
function collectSetupGroups(wikitext: string): StrategySetup[] {
  const groups: StrategySetup[][] = [];

  const tabberRe = /<tabber>([\s\S]*?)<\/tabber>/gi;
  let m: RegExpExecArray | null;
  while ((m = tabberRe.exec(wikitext))) {
    const parsed: StrategySetup[] = [];
    for (const { variant, text } of splitTabber(m[1])) {
      const setup = parseSetup(variant, text);
      if (setup) parsed.push(setup);
    }
    if (parsed.length > 0) groups.push(parsed);
  }

  if (groups.length === 0) {
    // No tabber at all: a single recommended loadout stated inline.
    const setup = parseSetup("Recommended", wikitext);
    if (setup) groups.push([setup]);
  }

  let best: StrategySetup[] = [];
  let bestScore = -1;
  for (const group of groups) {
    const score = group.reduce((s, g) => s + g.totalCount, 0);
    if (score > bestScore) {
      bestScore = score;
      best = group;
    }
  }
  return best;
}

function parseSetup(variant: string, text: string): StrategySetup | null {
  const equipmentTpl = findTemplates(text, "Equipment")[0];
  const inventoryTpl = findTemplates(text, "Inventory")[0];
  if (!equipmentTpl && !inventoryTpl) return null;

  const equipment: Partial<Record<EquipmentSlot, SetupItem>> = {};
  if (equipmentTpl) {
    const params = splitTemplateParams(equipmentTpl.body);
    for (const slot of EQUIPMENT_SLOTS) {
      const item = lookupItem(params.get(slot) ?? "");
      if (item) equipment[slot] = item;
    }
  }

  const inventory: (SetupItem | null)[] = new Array(28).fill(null);
  if (inventoryTpl) {
    const params = splitTemplateParams(inventoryTpl.body);
    for (let i = 1; i <= 28; i++) {
      inventory[i - 1] = lookupItem(params.get(String(i)) ?? "");
    }
  }

  const pouchTpl = findTemplates(text, "Rune pouch")[0];
  const runePouch: SetupItem[] = [];
  if (pouchTpl) {
    const params = splitTemplateParams(pouchTpl.body);
    for (let i = 1; i <= 4; i++) {
      const item = lookupItem(params.get(String(i)) ?? "");
      if (item) runePouch.push(item);
    }
  }

  const all = [...Object.values(equipment), ...inventory.filter((x): x is SetupItem => x != null)];
  const priced = all.filter((x) => x.price != null);
  return {
    variant,
    equipment,
    inventory,
    runePouch,
    cost: priced.reduce((s, x) => s + (x.price ?? 0), 0),
    pricedCount: priced.length,
    totalCount: all.length,
  };
}

export async function getStrategySetups(activity: string): Promise<StrategySetupsResult> {
  const key = activity.toLowerCase();
  const cached = getCacheStmt.get(key) as
    | { page: string | null; setups_json: string; fetched_at: number }
    | undefined;
  const now = Math.floor(Date.now() / 1000);

  // Cached setups are re-PRICED on every read rather than served as stored. The item list changes
  // when an editor touches the page, which is rare; the prices change every minute, which is the
  // entire point of this app. Serving a week-old cost would be the wiki's own staleness problem
  // reintroduced in the one place this app is supposed to beat it.
  if (cached && now - cached.fetched_at < CACHE_TTL_SECONDS) {
    const setups = JSON.parse(cached.setups_json) as StrategySetup[];
    return { page: cached.page, setups: setups.map(reprice) };
  }

  const page = await resolveStrategyPage(strategyPageCandidates(activity));
  if (!page) {
    putCacheStmt.run(key, null, "[]", now);
    return { page: null, setups: [] };
  }

  const url =
    `${API}?action=parse&page=${encodeURIComponent(page)}` +
    `&prop=wikitext&format=json&formatversion=2`;
  const res = await fetch(url, { headers: headers() });
  if (!res.ok) return { page, setups: [] };
  const json = (await res.json()) as { parse?: { wikitext: string } };
  const wikitext = json.parse?.wikitext ?? "";

  const setups = collectSetupGroups(wikitext);

  putCacheStmt.run(key, page, JSON.stringify(setups), now);
  return { page, setups };
}

/** Re-look-up every item's live price, keeping the cached item LIST. */
function reprice(setup: StrategySetup): StrategySetup {
  const fix = (item: SetupItem | null): SetupItem | null =>
    item == null ? null : (lookupItem(item.name) ?? item);
  const equipment: Partial<Record<EquipmentSlot, SetupItem>> = {};
  for (const [slot, item] of Object.entries(setup.equipment)) {
    const updated = fix(item as SetupItem);
    if (updated) equipment[slot as EquipmentSlot] = updated;
  }
  const inventory = setup.inventory.map(fix);
  const all = [...Object.values(equipment), ...inventory.filter((x): x is SetupItem => x != null)];
  const priced = all.filter((x) => x.price != null);
  return {
    ...setup,
    equipment,
    inventory,
    runePouch: setup.runePouch.map((r) => fix(r) ?? r),
    cost: priced.reduce((s, x) => s + (x.price ?? 0), 0),
    pricedCount: priced.length,
    totalCount: all.length,
  };
}
