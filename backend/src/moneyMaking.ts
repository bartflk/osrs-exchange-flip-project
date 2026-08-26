import { db } from "./db.js";
import { geTax } from "./signals.js";
import { parseQuantity } from "./wikiExpr.js";

// The OSRS Wiki's money-making guides, re-priced against this app's own live market data.
//
// The wiki publishes a gp/hr on each guide, but it is a snapshot baked in whenever the page was
// last edited. What the guides actually give -- and what is worth having -- is the RECIPE: how
// many of each item you consume and produce per hour. Multiply that by prices this app already
// polls every minute and the result is current, which the wiki's own figure is not.
//
// `{{Mmgtable}}` is a well-structured template: `kph`, `Input1..N`/`Input{N}num`,
// `Output1..N`/`Output{N}num`, plus `Skill` requirements and an `Item` gear list. Verified against
// the live page for Vorkath (Dragon hunter crossbow) before writing the parser.

const API = "https://oldschool.runescape.wiki/api.php";
const USER_AGENT = "osrs-flip-assistant/1.0 (local single-user GE tool)";
const PREFIX = "Money making guide/";
// The API accepts 50 titles per query, so 500+ guides cost ~11 requests rather than 500.
const TITLES_PER_QUERY = 50;
const REQUEST_SPACING_MS = 700;

export interface MmgItem {
  name: string;
  itemId: number | null;
  qtyPerHour: number;
}

export interface MmgRequirement {
  skill: string;
  level: number;
}

export interface MoneyMaker {
  title: string;
  activity: string;
  category: string | null;
  members: boolean;
  /** Kills or actions per hour, when the guide states one. */
  kph: number | null;
  inputs: MmgItem[];
  outputs: MmgItem[];
  requirements: MmgRequirement[];
  /** Item names linked in the guide's gear list, in wiki order. */
  gear: string[];
  /**
   * Lines that could not be read, counted SEPARATELY by side because they bias in opposite
   * directions and conflating them hides the dangerous one.
   *
   * A missing OUTPUT understates profit -- the figure is a floor, and safe to act on.
   * A missing INPUT understates COST, which overstates profit, and is not safe to act on.
   *
   * Found live: "Dismantling bracelets of ethereum" states no quantity for its bracelet input, so
   * the whole cost side went to zero and it topped the board at 147m/hr against a real figure a
   * fraction of that. Ranked purely on revenue, a guide with no cost line always wins.
   */
  missingInputs: number;
  missingOutputs: number;
}

function headers() {
  return { "User-Agent": USER_AGENT, Accept: "application/json" };
}

async function listGuideTitles(): Promise<string[]> {
  const titles: string[] = [];
  let cont: string | undefined;
  do {
    const url =
      `${API}?action=query&list=allpages&apprefix=${encodeURIComponent(PREFIX)}` +
      `&aplimit=500&apfilterredir=nonredirects&format=json` +
      (cont ? `&apcontinue=${encodeURIComponent(cont)}` : "");
    const res = await fetch(url, { headers: headers() });
    if (!res.ok) throw new Error(`wiki allpages failed: ${res.status}`);
    const json = (await res.json()) as {
      query: { allpages: { title: string }[] };
      continue?: { apcontinue: string };
    };
    for (const p of json.query.allpages) titles.push(p.title);
    cont = json.continue?.apcontinue;
    if (cont) await new Promise((r) => setTimeout(r, REQUEST_SPACING_MS));
  } while (cont);
  return titles;
}

async function fetchWikitext(titles: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (let i = 0; i < titles.length; i += TITLES_PER_QUERY) {
    const batch = titles.slice(i, i + TITLES_PER_QUERY);
    const url =
      `${API}?action=query&prop=revisions&rvprop=content&rvslots=main&format=json` +
      `&titles=${encodeURIComponent(batch.join("|"))}`;
    const res = await fetch(url, { headers: headers() });
    if (!res.ok) throw new Error(`wiki content fetch failed: ${res.status}`);
    const json = (await res.json()) as {
      query: {
        pages: Record<
          string,
          { title: string; revisions?: { slots: { main: { "*": string } } }[] }
        >;
      };
    };
    for (const page of Object.values(json.query.pages)) {
      const text = page.revisions?.[0]?.slots?.main?.["*"];
      if (text) out.set(page.title, text);
    }
    if (i + TITLES_PER_QUERY < titles.length) {
      await new Promise((r) => setTimeout(r, REQUEST_SPACING_MS));
    }
  }
  return out;
}

/**
 * Split a template's parameters at top level.
 *
 * A naive split on "|" breaks immediately: values contain nested templates and wiki links whose
 * own pipes ({{SCP|Ranged|90+}}, [[Rune sword|sword]]) would each be read as a new parameter.
 * Depth counting keeps them inside their value.
 */
function splitParams(body: string): Map<string, string> {
  const params = new Map<string, string>();
  let depth = 0;
  let current = "";
  const flush = () => {
    const eq = current.indexOf("=");
    if (eq > 0) {
      params.set(current.slice(0, eq).trim(), current.slice(eq + 1).trim());
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

function extractTemplate(wikitext: string, name: string): string | null {
  const start = wikitext.search(new RegExp(`\\{\\{\\s*${name}`, "i"));
  if (start < 0) return null;
  let depth = 0;
  for (let i = start; i < wikitext.length; i++) {
    if (wikitext.slice(i, i + 2) === "{{") {
      depth++;
      i++;
    } else if (wikitext.slice(i, i + 2) === "}}") {
      depth--;
      i++;
      if (depth === 0) {
        const body = wikitext.slice(start + 2, i - 1);
        return body.slice(body.indexOf("|") + 1);
      }
    }
  }
  return null;
}

/** First wiki-link target, or the plain text if there is no link. */
function itemName(raw: string): string {
  const link = raw.match(/\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/);
  const text = link ? link[1] : raw;
  return (
    text
      .replace(/\{\{[^}]*\}\}/g, "")
      // Wiki bold/italic is TWO or more apostrophes. Stripping single ones renamed every
      // possessive item in the game -- "Zulrah's scales" became "Zulrahs scales" and stopped
      // resolving, across eleven guides.
      .replace(/''+/g, "")
      .replace(/\*/g, "")
      .trim()
  );
}

/**
 * Wikitext flattened to readable prose: links keep their display text, templates go.
 *
 * Used for the activity title, which was previously read with itemName() -- so it took the FIRST
 * LINK instead of the sentence, and "Catching lobsters" displayed as "lobsters" while
 * "Killing Vorkath using Dragon hunter crossbow" displayed as "Vorkath".
 */
function flattenWikitext(raw: string): string {
  return raw
    .replace(/\[\[([^\]|]+)\|([^\]]*)\]\]/g, "$2")
    .replace(/\[\[([^\]]+)\]\]/g, "$1")
    .replace(/\{\{[^}]*\}\}/g, "")
    .replace(/''+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function parseRequirements(skillParam: string | undefined): MmgRequirement[] {
  if (!skillParam) return [];
  const out: MmgRequirement[] = [];
  // {{SCP|Ranged|90+}} -- the level may carry a trailing "+" or be absent entirely.
  const re = /\{\{\s*SCP\s*\|\s*([A-Za-z ]+?)\s*(?:\|\s*([0-9]+)\s*\+?\s*)?\}\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(skillParam))) {
    const level = m[2] ? Number(m[2]) : 1;
    if (Number.isFinite(level)) out.push({ skill: m[1].trim().toLowerCase(), level });
  }
  return out;
}

function parseGearList(itemParam: string | undefined): string[] {
  if (!itemParam) return [];
  const names: string[] = [];
  const re = /\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(itemParam))) {
    const n = m[1].trim();
    if (n && !names.includes(n)) names.push(n);
  }
  return names;
}

const itemIdByNameStmt = db.prepare(`SELECT id FROM items WHERE LOWER(name) = LOWER(?) LIMIT 1`);

/**
 * Face-value currencies, which have no GE price because they cannot be traded on it.
 *
 * 104 guide lines pay out coins directly. This is the same gap that made a pasted bank containing
 * 315m in coins report 0 (§14.53): the Wiki's item mapping lists tradeable items, and coins are
 * not one. Their value is a game rule, not a market price.
 */
const CURRENCY_VALUE: Record<string, number> = {
  coins: 1,
  coin: 1,
  "platinum token": 1000,
};

export function currencyValue(name: string): number | null {
  return CURRENCY_VALUE[name.trim().toLowerCase()] ?? null;
}

function resolveItemId(name: string): number | null {
  const row = itemIdByNameStmt.get(name) as { id: number } | undefined;
  return row?.id ?? null;
}

function parseGuide(title: string, wikitext: string): MoneyMaker | null {
  const body = extractTemplate(wikitext, "Mmgtable");
  if (!body) return null;
  const p = splitParams(body);

  const activity = flattenWikitext(p.get("Activity") ?? "") || title.replace(PREFIX, "");
  const kph = parseQuantity(p.get("kph"));

  // `isperkill = y` means the quantities on this guide are stated PER KILL, not per hour, and
  // must be scaled by `kph`. Missing this made every boss look worthless: Vorkath drops 2
  // superior dragon bones per kill at 30 kills/hr, and counting that as 2 per HOUR turned a
  // ~3m/hr boss into -0.58m/hr, because the per-hour supply costs were still charged in full.
  //
  // Individual lines can opt out with `{kind}{n}isph = y` -- "this one is already per hour" --
  // which is how the same guide states 100 bolts/hr alongside per-kill drops.
  const perKill = /^(y|yes|true)$/i.test((p.get("isperkill") ?? "").trim());

  const collect = (kind: "Input" | "Output"): { items: MmgItem[]; unresolved: number } => {
    const items: MmgItem[] = [];
    let unresolved = 0;
    for (let i = 1; i <= 60; i++) {
      const rawName = p.get(`${kind}${i}`);
      if (!rawName) continue;
      const rawQty = parseQuantity(p.get(`${kind}${i}num`));
      const lineIsPerHour = /^(y|yes|true)$/i.test((p.get(`${kind}${i}isph`) ?? "").trim());
      // Scaling needs a kph to scale by. Without one the quantity cannot be converted, so the
      // line is dropped rather than silently left at its per-kill value.
      const qty =
        rawQty == null
          ? null
          : perKill && !lineIsPerHour
            ? kph != null && kph > 0
              ? rawQty * kph
              : null
            : rawQty;
      // A line whose value is a bare template -- {{Cheap food}}, {{Prayer potion}} -- has no item
      // link to read, and stripping templates left it empty and silently dropped. That is the
      // worst outcome: an unaccounted COST that disappears from the breakdown entirely, so the
      // reader cannot even see that something is missing. Vorkath's cheap food was exactly this.
      // Keep the template's own name so the line shows as an unpriced cost instead of vanishing.
      const templateName = rawName.trim().match(/^\{\{\s*([^|}]+?)\s*(?:\|[^}]*)?\}\}$/);
      const name = itemName(rawName) || (templateName ? templateName[1].trim() : "");
      if (!name || qty == null) {
        // A row whose quantity could not be read exactly is counted, not guessed. It is the
        // difference between "this guide is worth 4m/hr" and "worth 4m/hr plus something".
        unresolved++;
        continue;
      }
      const id = resolveItemId(name);
      if (id == null && currencyValue(name) == null) unresolved++;
      items.push({ name, itemId: id, qtyPerHour: qty });
    }
    return { items, unresolved };
  };

  const ins = collect("Input");
  const outs = collect("Output");

  return {
    title,
    activity,
    category: p.get("Category")?.trim() || null,
    members: /yes|y|true/i.test(p.get("Members") ?? "yes"),
    kph,
    inputs: ins.items,
    outputs: outs.items,
    requirements: parseRequirements(p.get("Skill")),
    gear: parseGearList(p.get("Item")),
    missingInputs: ins.unresolved,
    missingOutputs: outs.unresolved,
  };
}

// ---------------------------------------------------------------------------- storage

db.exec(`
  CREATE TABLE IF NOT EXISTS money_makers (
    title TEXT PRIMARY KEY,
    activity TEXT NOT NULL,
    category TEXT,
    members INTEGER NOT NULL,
    kph REAL,
    inputs_json TEXT NOT NULL,
    outputs_json TEXT NOT NULL,
    requirements_json TEXT NOT NULL,
    gear_json TEXT NOT NULL,
    fully_priced INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )
`);

// CREATE TABLE IF NOT EXISTS does nothing to an existing table, so columns added after the table
// shipped need an explicit migration or every existing install keeps the old shape.
for (const column of ["missing_inputs", "missing_outputs"]) {
  const cols = db.prepare(`PRAGMA table_info(money_makers)`).all() as unknown as { name: string }[];
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE money_makers ADD COLUMN ${column} INTEGER NOT NULL DEFAULT 0`);
  }
}

const upsertStmt = db.prepare(`
  INSERT INTO money_makers
    (title, activity, category, members, kph, inputs_json, outputs_json, requirements_json,
     gear_json, fully_priced, missing_inputs, missing_outputs, updated_at)
  VALUES (@title, @activity, @category, @members, @kph, @inputs_json, @outputs_json,
          @requirements_json, @gear_json, @fully_priced, @missing_inputs, @missing_outputs,
          @updated_at)
  ON CONFLICT(title) DO UPDATE SET
    activity=excluded.activity, category=excluded.category, members=excluded.members,
    kph=excluded.kph, inputs_json=excluded.inputs_json, outputs_json=excluded.outputs_json,
    requirements_json=excluded.requirements_json, gear_json=excluded.gear_json,
    fully_priced=excluded.fully_priced, missing_inputs=excluded.missing_inputs,
    missing_outputs=excluded.missing_outputs, updated_at=excluded.updated_at
`);

export async function refreshMoneyMakers(): Promise<{ found: number; stored: number }> {
  const titles = (await listGuideTitles()).filter((t) => !/\/Ideas$/i.test(t));
  const texts = await fetchWikitext(titles);

  const now = Math.floor(Date.now() / 1000);
  let stored = 0;
  db.exec("BEGIN");
  try {
    for (const [title, text] of texts) {
      const guide = parseGuide(title, text);
      if (!guide) continue;
      upsertStmt.run({
        title: guide.title,
        activity: guide.activity,
        category: guide.category,
        members: guide.members ? 1 : 0,
        kph: guide.kph,
        inputs_json: JSON.stringify(guide.inputs),
        outputs_json: JSON.stringify(guide.outputs),
        requirements_json: JSON.stringify(guide.requirements),
        gear_json: JSON.stringify(guide.gear),
        fully_priced: guide.missingInputs === 0 && guide.missingOutputs === 0 ? 1 : 0,
        missing_inputs: guide.missingInputs,
        missing_outputs: guide.missingOutputs,
        updated_at: now,
      });
      stored++;
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  console.log(`[mmg] ${stored} guides stored of ${titles.length} pages`);
  return { found: titles.length, stored };
}

// ---------------------------------------------------------------- pricing

interface StoredRow {
  title: string;
  activity: string;
  category: string | null;
  members: number;
  kph: number | null;
  inputs_json: string;
  outputs_json: string;
  requirements_json: string;
  gear_json: string;
  fully_priced: number;
  missing_inputs: number;
  missing_outputs: number;
  updated_at: number;
}

const allStmt = db.prepare(`SELECT * FROM money_makers`);
const priceStmt = db.prepare(`SELECT low, high FROM latest_snapshot WHERE item_id = ?`);

export interface PricedLine extends MmgItem {
  unitPrice: number | null;
  value: number;
}

export interface PricedMoneyMaker {
  title: string;
  activity: string;
  category: string | null;
  members: boolean;
  kph: number | null;
  requirements: MmgRequirement[];
  gear: string[];
  inputs: PricedLine[];
  outputs: PricedLine[];
  inputCost: number;
  outputRevenue: number;
  /** Revenue after GE tax on every sold output, minus input cost. */
  profitPerHour: number;
  complete: boolean;
  unpricedLines: number;
  /**
   * Which direction the number can be wrong in.
   *  exact      -- every line read and priced.
   *  floor      -- an output is missing, so the real figure is HIGHER. Safe to act on.
   *  overstated -- an input is missing, so a cost is unaccounted for and the real figure is
   *                LOWER. Not safe to rank on, and never shown as a headline.
   */
  reliability: "exact" | "floor" | "overstated";
  updatedAt: number;
}

export function getPricedMoneyMakers(): PricedMoneyMaker[] {
  const rows = allStmt.all() as unknown as StoredRow[];
  return rows.map((r) => {
    const price = (line: MmgItem, side: "low" | "high"): number | null => {
      const face = currencyValue(line.name);
      if (face != null) return face;
      if (line.itemId == null) return null;
      const row = priceStmt.get(line.itemId) as
        | { low: number | null; high: number | null }
        | undefined;
      return row?.[side] ?? null;
    };

    let unpriced = 0;
    let unpricedInputs = 0;

    // Inputs are BOUGHT, so they cost the insta-buy price (`high`). Outputs are SOLD, so they
    // fetch the insta-sell price (`low`) minus tax. Using the mid for both would overstate every
    // guide by roughly the spread, on both sides.
    const inputs: PricedLine[] = (JSON.parse(r.inputs_json) as MmgItem[]).map((it) => {
      const unit = price(it, "high");
      if (unit == null) {
        unpriced++;
        unpricedInputs++;
      }
      return { ...it, unitPrice: unit, value: unit == null ? 0 : unit * it.qtyPerHour };
    });

    const outputs: PricedLine[] = (JSON.parse(r.outputs_json) as MmgItem[]).map((it) => {
      const unit = price(it, "low");
      if (unit == null) unpriced++;
      const gross = unit == null ? 0 : unit * it.qtyPerHour;
      // Coins dropped by a monster are not sold, so no GE tax is taken from them. Taxing a coin
      // drop would quietly shave 2% off every boss in the list.
      const taxed = currencyValue(it.name) != null ? 0 : geTax(Math.round(unit ?? 0)) * it.qtyPerHour;
      const net = unit == null ? 0 : gross - taxed;
      return { ...it, unitPrice: unit, value: net };
    });

    const inputCost = inputs.reduce((s, x) => s + x.value, 0);
    const outputRevenue = outputs.reduce((s, x) => s + x.value, 0);

    return {
      title: r.title,
      activity: r.activity,
      category: r.category,
      members: r.members === 1,
      kph: r.kph,
      requirements: JSON.parse(r.requirements_json) as MmgRequirement[],
      gear: JSON.parse(r.gear_json) as string[],
      inputs,
      outputs,
      inputCost: Math.round(inputCost),
      outputRevenue: Math.round(outputRevenue),
      profitPerHour: Math.round(outputRevenue - inputCost),
      complete: r.fully_priced === 1 && unpriced === 0,
      unpricedLines: unpriced,
      reliability:
        r.missing_inputs > 0 || unpricedInputs > 0
          ? "overstated"
          : r.missing_outputs > 0 || unpriced > 0
            ? "floor"
            : "exact",
      updatedAt: r.updated_at,
    };
  });
}

export function moneyMakerCount(): number {
  const row = db.prepare(`SELECT COUNT(*) AS c FROM money_makers`).get() as { c: number };
  return row.c;
}
