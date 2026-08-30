import { db } from "./db.js";
import { geTax } from "./signals.js";
import { extractVarDefines, parseQuantity } from "./wikiExpr.js";

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
  /**
   * Price the GUIDE states for this line, overriding the GE.
   *
   * `Input4value = 6000` on the sunfire-rune guide prices twisted extract, which has no GE price
   * at all. Ignoring it dropped 61m/hr of cost from a single line and was most of why that guide
   * read 64.95m against the wiki's 4.14m.
   *
   * Stored as the raw EXPRESSION, not a number, because it is frequently priced off other items:
   * the air-rune guide charges a ring of the elements teleport as
   * `{{GEP|Air rune|1}} + {{GEP|Water rune|1}} + ...`. Those have to be resolved against live
   * prices, which are only available at pricing time, not while parsing wikitext.
   *
   * When a line states a value that cannot be resolved, it is treated as UNPRICED and never falls
   * back to the item's own GE price. The guide stating a value is a statement that the item's
   * price is the wrong number for this line -- on the air-rune guide the difference is a ~500gp
   * teleport charge versus a ~675k ring, charged 172 times an hour, which alone reported that
   * guide at -116m/hr against the wiki's +820k.
   */
  valueExpr?: string | null;
  /**
   * Quantity per KILL/action, before kph scaling, on guides that state per-kill numbers.
   *
   * Kept because it is a drop RATE, and a rate is what separates a boss's bread-and-butter loot
   * from its jackpot. Vorkath's dragonbone necklace is `1/1000`; its superior dragon bones are
   * `2`. Both are revenue, but only one of them is money you can count on in a session.
   */
  perAction?: number | null;
  /** Interchangeable items this line picks between. See extremePriceCandidates(). */
  maxPriceOf?: string[] | null;
  /** "max" picks the dearest of maxPriceOf, "min" the cheapest. */
  maxPriceMode?: "max" | "min" | null;
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
  /**
   * The wiki's OWN hourly profit for this guide, scraped from the overview table.
   *
   * Not a stale snapshot: the Money making guide page states that "All prices are calculated using
   * current Grand Exchange market prices", and the table exposes the unrounded figure in each
   * row's `data-sort-value`. It is computed by the same template the guide authors wrote against,
   * so it honours every parameter, including ones this parser does not implement.
   *
   * Carried alongside our own recomputation rather than replacing it, because the two answer
   * different questions and their DISAGREEMENT is the useful signal -- see profitPerHour.
   */
  wikiProfitPerHour: number | null;
  /** "Low" / "Moderate" / "High" -- the guide's own click-intensity rating. */
  intensity: string | null;
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

/**
 * The wiki's own hourly-profit table, which is the number the user actually sees on the wiki.
 *
 * Worth taking directly rather than only recomputing, for a reason this file learned the hard
 * way. Our recomputation reimplements the `{{Mmgtable}}` template from the outside, and every
 * parameter it does not implement is a silent error in an unknown direction: `Input{n}value`
 * overrides, absent quantities defaulting to one, per-line `isph` flags, `{{#vardefine}}` maths.
 * Each of those was a real bug found in this file, and each was found by NOTICING a number that
 * looked wrong, which is not a reliable way to find the ones nobody notices.
 *
 * The wiki's figure is computed by the template itself, so it is right by construction, and it is
 * live rather than stale -- the page states that all prices use current Grand Exchange prices,
 * and the table publishes the unrounded value in each row's `data-sort-value`.
 *
 * It is not a replacement for our own figure, because it is priced from the wiki's cache rather
 * than this app's minute-by-minute poll, and a cached price on a moving item is exactly what this
 * app exists to beat. Both are kept. Agreement means the recipe was read correctly and the price
 * is steady; a large gap means one of the two is wrong and the row should not be trusted blindly.
 */
export interface WikiTableRow {
  title: string;
  profitPerHour: number;
  intensity: string | null;
}

const OVERVIEW_PAGE = "Money making guide";

export async function fetchWikiProfitTable(): Promise<Map<string, WikiTableRow>> {
  const url =
    `${API}?action=parse&page=${encodeURIComponent(OVERVIEW_PAGE)}` +
    `&prop=text&format=json&formatversion=2`;
  const res = await fetch(url, { headers: headers() });
  if (!res.ok) throw new Error(`wiki overview parse failed: ${res.status}`);
  const json = (await res.json()) as { parse: { text: string } };
  const html = json.parse.text;

  const out = new Map<string, WikiTableRow>();
  // Row-wise regex rather than an HTML parser: this is one known table on one known page, and
  // adding a DOM dependency to read two attributes out of it is not a trade worth making. The
  // shape is checked below -- if the page changes, the count collapses and the caller says so.
  for (const row of html.split("<tr>")) {
    const link = row.match(/<a href="\/w\/(Money_making_guide[^"]*)" title="([^"]*)"/);
    // The unrounded figure. The visible cell is rounded to four significant figures, which would
    // quantise a 14.4m activity to the nearest 1,000gp for no reason.
    const sort = row.match(/data-sort-value="(-?[\d.]+)"/);
    if (!link || !sort) continue;
    const profit = Number(sort[1]);
    if (!Number.isFinite(profit)) continue;
    const intensity = row.match(/<td[^>]*>\s*(Low|Moderate|High|Very high)\s*<\/td>/i);
    out.set(decodeEntities(link[2]), {
      title: decodeEntities(link[2]),
      profitPerHour: profit,
      intensity: intensity ? intensity[1] : null,
    });
  }
  return out;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function parseGuide(title: string, wikitext: string): MoneyMaker | null {
  const body = extractTemplate(wikitext, "Mmgtable");
  if (!body) return null;
  const p = splitParams(body);
  // Page-scoped variables must be read from the WHOLE page, not the template body -- the
  // {{#vardefine:}} block sits outside {{Mmgtable}} on every guide that uses them.
  const vars = extractVarDefines(wikitext);

  const activity = flattenWikitext(p.get("Activity") ?? "") || title.replace(PREFIX, "");
  const kph = parseQuantity(p.get("kph"), vars);

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
      // An ABSENT quantity means one, which is the template's own default, not a parse failure.
      // Treating it as unreadable and dropping the line was the single most damaging bug in this
      // file, and it is biased: a line stating no quantity is nearly always an input consumed one
      // at a time, so the cost side is what vanished.
      //
      // Measured, not assumed. "Cutting raw marlin" declares `Input1 = Raw marlin` with no
      // `Input1num` at 11,000 actions/hr. Dropping it booked 11,000 free marlin an hour and
      // reported 36.86m/hr against the wiki's 2.13m. With the default applied the same guide
      // computes 2.48m/hr, which is the wiki's figure plus ordinary price drift.
      //
      // "Dismantling bracelets of ethereum" is the same bug with a sharper edge: one input, no
      // quantity, so its ENTIRE cost side was zero and it topped the board at 147m/hr. Priced
      // correctly it is 147.0m revenue against 149.3m of bracelets -- a LOSS of about 2.3m/hr,
      // which is exactly what that guide's own notes warn about.
      const statedQty = parseQuantity(p.get(`${kind}${i}num`), vars);
      const rawQty = p.has(`${kind}${i}num`) ? statedQty : 1;
      const valueExpr = p.get(`${kind}${i}value`)?.trim() || null;
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
      const extreme = extremePriceCandidates(rawName);
      const candidates = extreme?.names ?? null;
      // Named for the first candidate so the row is readable before pricing runs; the actual
      // pick is made against live prices, which is the whole point of the template.
      const name =
        candidates?.[0] ?? (itemName(rawName) || (templateName ? templateName[1].trim() : ""));
      if (!name || qty == null) {
        // A row whose quantity could not be read exactly is counted, not guessed. It is the
        // difference between "this guide is worth 4m/hr" and "worth 4m/hr plus something".
        unresolved++;
        continue;
      }
      const id = resolveItemId(name);
      // A stated value is a price, so a line carrying one is priced even when nothing in the GE
      // catalogue matches its name -- which is the whole reason the guide states one.
      if (id == null && currencyValue(name) == null && valueExpr == null && !candidates) {
        unresolved++;
      }
      items.push({
        name,
        itemId: id,
        qtyPerHour: qty,
        valueExpr,
        perAction: perKill && !lineIsPerHour ? rawQty : null,
        maxPriceOf: candidates,
        maxPriceMode: extreme?.mode ?? null,
      });
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
    // Filled in by the caller, which has the overview table. The guide page itself does not state
    // its own computed profit anywhere readable.
    wikiProfitPerHour: null,
    intensity: p.get("Intensity")?.trim() || null,
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
for (const [column, decl] of [
  ["missing_inputs", "INTEGER NOT NULL DEFAULT 0"],
  ["missing_outputs", "INTEGER NOT NULL DEFAULT 0"],
  ["wiki_profit_per_hour", "REAL"],
  ["intensity", "TEXT"],
] as const) {
  const cols = db.prepare(`PRAGMA table_info(money_makers)`).all() as unknown as { name: string }[];
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE money_makers ADD COLUMN ${column} ${decl}`);
  }
}

const upsertStmt = db.prepare(`
  INSERT INTO money_makers
    (title, activity, category, members, kph, inputs_json, outputs_json, requirements_json,
     gear_json, fully_priced, missing_inputs, missing_outputs, wiki_profit_per_hour,
     intensity, updated_at)
  VALUES (@title, @activity, @category, @members, @kph, @inputs_json, @outputs_json,
          @requirements_json, @gear_json, @fully_priced, @missing_inputs, @missing_outputs,
          @wiki_profit_per_hour, @intensity, @updated_at)
  ON CONFLICT(title) DO UPDATE SET
    activity=excluded.activity, category=excluded.category, members=excluded.members,
    kph=excluded.kph, inputs_json=excluded.inputs_json, outputs_json=excluded.outputs_json,
    requirements_json=excluded.requirements_json, gear_json=excluded.gear_json,
    fully_priced=excluded.fully_priced, missing_inputs=excluded.missing_inputs,
    missing_outputs=excluded.missing_outputs,
    wiki_profit_per_hour=excluded.wiki_profit_per_hour, intensity=excluded.intensity,
    updated_at=excluded.updated_at
`);

export async function refreshMoneyMakers(): Promise<{
  found: number;
  stored: number;
  wikiRows: number;
}> {
  const titles = (await listGuideTitles()).filter((t) => !/\/Ideas$/i.test(t));
  const texts = await fetchWikitext(titles);

  // Additive, not load-bearing: if the overview page fails or its markup changes, every guide is
  // still stored and still recomputed from live prices. The wiki's own column simply goes blank,
  // which is visible, rather than the refresh failing wholesale over a nice-to-have.
  let wikiTable = new Map<string, WikiTableRow>();
  try {
    wikiTable = await fetchWikiProfitTable();
    console.log(`[mmg] wiki overview table: ${wikiTable.size} rows`);
  } catch (err) {
    console.error("[mmg] wiki overview table failed, continuing without it:", err);
  }

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
        wiki_profit_per_hour: wikiTable.get(title)?.profitPerHour ?? null,
        // The guide's own Intensity parameter wins; the overview table's column is the fallback
        // for guides that omit it.
        intensity: guide.intensity ?? wikiTable.get(title)?.intensity ?? null,
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
  return { found: titles.length, stored, wikiRows: wikiTable.size };
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
  wiki_profit_per_hour: number | null;
  intensity: string | null;
  updated_at: number;
}

const allStmt = db.prepare(`SELECT * FROM money_makers`);
const priceStmt = db.prepare(`SELECT low, high FROM latest_snapshot WHERE item_id = ?`);
const itemMetaStmt = db.prepare(
  `SELECT i.id, i.icon, s.low, s.high FROM items i
   LEFT JOIN latest_snapshot s ON s.item_id = i.id
   WHERE LOWER(i.name) = LOWER(?) LIMIT 1`,
);
const iconStmt = db.prepare(`SELECT icon FROM items WHERE id = ?`);

/**
 * A guide's stated line value, with {{GEP|Item|n}} lookups resolved against live prices.
 *
 * GEP is the wiki's Grand Exchange Price template and its second argument is a MULTIPLIER, not a
 * fallback. Verified directly against the wiki's own parser rather than inferred:
 * `{{GEP|Yew logs}}` renders 110 and `{{GEP|Yew logs|3}}` renders 330.
 *
 * The difference is not academic. Reading it as a fallback priced "Anima-infused bark" at
 * `{{GEP|Felling axe handle|.0001}}` = the handle's full 1.98m rather than 198gp, and reported
 * "Cutting yew logs" at 2.96 BILLION gp/hr against the wiki's 366k.
 */
function resolveValueExpr(expr: string): number | null {
  let unresolved = false;
  const resolved = expr.replace(
    /\{\{\s*GEP\s*\|\s*([^|}]+?)\s*(?:\|\s*([^}]*?)\s*)?\}\}/gi,
    (_m, name: string, mult: string | undefined) => {
      const live = livePrice(name);
      if (live == null) {
        unresolved = true;
        return "0";
      }
      const m = mult == null || mult.trim() === "" ? 1 : Number(mult.replace(/,/g, ""));
      if (!Number.isFinite(m)) {
        unresolved = true;
        return "0";
      }
      return String(live * m);
    },
  );
  if (unresolved) return null;
  const n = parseQuantity(resolved);
  return n != null && Number.isFinite(n) ? n : null;
}

function livePrice(name: string): number | null {
  const meta = itemMetaStmt.get(name.trim()) as
    | { low: number | null; high: number | null }
    | undefined;
  return meta?.high ?? meta?.low ?? null;
}

/**
 * {{MaxPrice|...}} / {{MinPrice|...}} -- "whichever of these is worth most / least right now".
 *
 * Guides producing any one of several interchangeable products use MaxPrice so they always quote
 * the best (rune 2h sword vs platelegs vs plateskirt); guides consuming an interchangeable input
 * use MinPrice so they quote the cheapest way to buy it. Neither carries a wiki link, so the name
 * resolved to the literal string "MaxPrice"/"MinPrice" and priced at nothing.
 *
 * The two fail in OPPOSITE directions, which is why both matter. An unpriced MaxPrice OUTPUT
 * books full cost against zero revenue -- "Smithing rune items" read -33.1m/hr against the wiki's
 * +464k. An unpriced MinPrice INPUT is the dangerous one: it drops a cost silently, and "Making
 * Super combat potions" read 6.96m/hr against the wiki's 508k.
 *
 * Resolved at pricing time because "which is cheapest" is a question about today's prices.
 */
const EXTREME_PRICE_RE = /^\{\{\s*(Max|Min)Price\s*\|(.+?)\}\}$/is;

function extremePriceCandidates(raw: string): { mode: "max" | "min"; names: string[] } | null {
  const m = raw.trim().match(EXTREME_PRICE_RE);
  if (!m) return null;
  const names = m[2]
    .split("|")
    .map((part) => part.trim())
    // Named arguments (var=item, format=item, link=n) configure the template; the bare ones are
    // the item names it chooses between.
    .filter((part) => part.length > 0 && !part.includes("="));
  if (names.length === 0) return null;
  return { mode: m[1].toLowerCase() === "min" ? "min" : "max", names };
}

function iconFor(itemId: number | null): string | null {
  if (itemId == null) return null;
  const row = iconStmt.get(itemId) as { icon: string | null } | undefined;
  return row?.icon ?? null;
}

export interface PricedLine extends MmgItem {
  unitPrice: number | null;
  value: number;
  /** Wiki filename for the item icon, when the line resolved to a real GE item. */
  icon: string | null;
  /**
   * A rare drop: stated at under one per RARE_DROP_RATE kills.
   *
   * Only meaningful on per-kill guides, where the quantity is a drop rate rather than a count.
   */
  rare: boolean;
}

export interface GearPiece {
  name: string;
  itemId: number | null;
  icon: string | null;
  price: number | null;
}

/**
 * A drop stated at under 1-in-100 per kill is treated as a jackpot rather than income.
 *
 * The threshold is a judgement call and is deliberately generous. The point is not to draw a
 * precise line between "common" and "rare" -- it is that an hourly average silently promises you
 * a share of a drop you will usually not see. At 30 kills/hr, a 1/1000 drop is one every 33 hours,
 * yet it is folded into "gp/hr" as though it arrived in even slices. For a player deciding what to
 * do for the next two hours, the figure WITHOUT those drops is the honest one, and the gap between
 * the two is how much of the advertised rate is a lottery ticket.
 */
const RARE_DROP_RATE = 1 / 100;

export interface PricedMoneyMaker {
  title: string;
  activity: string;
  category: string | null;
  members: boolean;
  kph: number | null;
  requirements: MmgRequirement[];
  gear: GearPiece[];
  /** Live cost of the gear pieces that resolved to real GE items. A floor, not the full kit. */
  gearCost: number;
  gearPricedCount: number;
  inputs: PricedLine[];
  outputs: PricedLine[];
  inputCost: number;
  outputRevenue: number;
  /** Revenue after GE tax on every sold output, minus input cost. */
  profitPerHour: number;
  /**
   * The wiki's own published figure for this guide, live-priced by the wiki. Null when the guide
   * is not listed in the overview table.
   */
  wikiProfitPerHour: number | null;
  /**
   * The number to LEAD with, and where it came from.
   *
   * The wiki's own figure wins whenever it exists. That is a deliberate reversal of this file's
   * original design, and it was decided on measurement rather than taste. Recomputing the guides
   * from live prices means reimplementing `{{Mmgtable}}` from the outside, and every parameter
   * not implemented is a silent error in an unknown direction. Five separate ones were found in
   * a single afternoon -- absent quantities defaulting to 1, `{{GEP|item|n}}` being a multiplier
   * rather than a fallback, `Input{n}value` overrides, `{{MaxPrice}}`, `{{MinPrice}}` -- each
   * found by NOTICING a number that looked wrong, which says nothing reassuring about the ones
   * nobody happened to notice.
   *
   * After all five fixes, our figure lands within 10% of the wiki's on 310 of 518 comparable
   * guides and within 25% on 374, with a median gap of 5.6%. That is good enough to serve as a
   * live cross-check and not good enough to rank on unsupervised, because the remaining tail is
   * still 41 guides more than 2x out.
   *
   * The live figure keeps its place beside it. The wiki's is priced from the wiki's cache, and a
   * cached price on a moving item is precisely what this app exists to beat, so where the two
   * agree the live one is the fresher truth and where they disagree the row is worth distrusting.
   */
  headlineProfitPerHour: number;
  headlineSource: "wiki" | "live";
  /** |live - wiki| / |wiki|, or null when the guide is not in the wiki's table. */
  divergence: number | null;
  /**
   * profitPerHour with every rare drop removed -- the money you can actually expect from a short
   * session. Null when the guide is not stated per kill, where the concept does not apply.
   */
  profitPerHourNoUniques: number | null;
  /** Share of gross revenue that comes from rare drops, 0..1. Null when not per-kill. */
  rareShare: number | null;
  intensity: string | null;
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
  /**
   * No cost was counted AT ALL, despite the guide listing inputs.
   *
   * A stronger claim than "overstated", and worth separating. The Doom of Mokhaiotl is overstated
   * because two of its nine supply lines are spell costs with no GE price -- 580k of real supplies
   * still got counted, and the number is usable with that caveat. "Dismantling bracelets of
   * ethereum" states no quantity for its ONLY input, so its entire cost side is zero and it books
   * pure revenue at 147m/hr. The first belongs in the list with a flag; the second is not a
   * comparable number at all.
   */
  costsUnknown: boolean;
  updatedAt: number;
}

export function getPricedMoneyMakers(): PricedMoneyMaker[] {
  const rows = allStmt.all() as unknown as StoredRow[];
  return rows.map((r) => {
    // A MaxPrice line is not a fixed item, so it is resolved to a concrete one FIRST and
    // everything downstream -- price, icon, name -- then works on a normal line.
    const resolveMaxPrice = (line: MmgItem): MmgItem => {
      if (!line.maxPriceOf || line.maxPriceOf.length === 0) return line;
      const wantMin = line.maxPriceMode === "min";
      let best: { name: string; price: number } | null = null;
      for (const candidate of line.maxPriceOf) {
        const p = livePrice(candidate);
        if (p == null) continue;
        if (best == null || (wantMin ? p < best.price : p > best.price)) {
          best = { name: candidate, price: p };
        }
      }
      if (!best) return line;
      return { ...line, name: best.name, itemId: resolveItemId(best.name) };
    };

    const price = (line: MmgItem, side: "low" | "high"): number | null => {
      // A stated value wins over everything, and its ABSENCE of a resolution is authoritative
      // too: null here means unpriced, never "fall back to the item".
      if (line.valueExpr != null) return resolveValueExpr(line.valueExpr);
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
    const inputs: PricedLine[] = (JSON.parse(r.inputs_json) as MmgItem[]).map((raw) => {
      const it = resolveMaxPrice(raw);
      const unit = price(it, "high");
      if (unit == null) {
        unpriced++;
        unpricedInputs++;
      }
      return {
        ...it,
        unitPrice: unit,
        value: unit == null ? 0 : unit * it.qtyPerHour,
        icon: iconFor(it.itemId),
        rare: false,
      };
    });

    const outputs: PricedLine[] = (JSON.parse(r.outputs_json) as MmgItem[]).map((raw) => {
      const it = resolveMaxPrice(raw);
      const unit = price(it, "low");
      if (unit == null) unpriced++;
      const gross = unit == null ? 0 : unit * it.qtyPerHour;
      // Coins dropped by a monster are not sold, so no GE tax is taken from them. Taxing a coin
      // drop would quietly shave 2% off every boss in the list.
      const taxed = currencyValue(it.name) != null ? 0 : geTax(Math.round(unit ?? 0)) * it.qtyPerHour;
      const net = unit == null ? 0 : gross - taxed;
      return {
        ...it,
        unitPrice: unit,
        value: net,
        icon: iconFor(it.itemId),
        rare: it.perAction != null && it.perAction > 0 && it.perAction < RARE_DROP_RATE,
      };
    });

    const inputCost = inputs.reduce((s, x) => s + x.value, 0);
    const outputRevenue = outputs.reduce((s, x) => s + x.value, 0);

    // Only meaningful where quantities are drop rates. On a processing guide "3 marlin scales"
    // is a yield, not a 3-in-1 drop chance, and stripping lines by rate would be nonsense.
    const perKillGuide = outputs.some((o) => o.perAction != null);
    const rareRevenue = perKillGuide
      ? outputs.filter((o) => o.rare).reduce((s, x) => s + x.value, 0)
      : 0;

    const gear: GearPiece[] = (JSON.parse(r.gear_json) as string[]).map((name) => {
      const meta = itemMetaStmt.get(name) as
        | { id: number; icon: string | null; low: number | null; high: number | null }
        | undefined;
      return {
        name,
        itemId: meta?.id ?? null,
        icon: meta?.icon ?? null,
        // Gear is BOUGHT, so it costs the insta-buy price, same convention as inputs.
        price: meta?.high ?? meta?.low ?? null,
      };
    });
    const pricedGear = gear.filter((g) => g.price != null);

    // Guides whose wiki figure rounds to nothing are treated as absent rather than compared: a
    // divergence ratio against a near-zero denominator is noise, not information.
    const wiki = r.wiki_profit_per_hour;
    const comparable = wiki != null && Math.abs(wiki) > 10000;
    const liveProfit = outputRevenue - inputCost;

    return {
      headlineProfitPerHour: wiki ?? liveProfit,
      headlineSource: wiki != null ? ("wiki" as const) : ("live" as const),
      divergence: comparable ? Math.abs(liveProfit - wiki) / Math.abs(wiki) : null,
      gear,
      gearCost: pricedGear.reduce((s, g) => s + (g.price ?? 0), 0),
      gearPricedCount: pricedGear.length,
      wikiProfitPerHour: r.wiki_profit_per_hour,
      intensity: r.intensity,
      profitPerHourNoUniques: perKillGuide ? outputRevenue - rareRevenue - inputCost : null,
      rareShare: perKillGuide && outputRevenue > 0 ? rareRevenue / outputRevenue : null,
      title: r.title,
      activity: r.activity,
      category: r.category,
      members: r.members === 1,
      kph: r.kph,
      requirements: JSON.parse(r.requirements_json) as MmgRequirement[],
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
      costsUnknown:
        (r.missing_inputs > 0 || unpricedInputs > 0) && Math.round(inputCost) === 0 &&
        (inputs.length > 0 || r.missing_inputs > 0),
      updatedAt: r.updated_at,
    };
  });
}

export function moneyMakerCount(): number {
  const row = db.prepare(`SELECT COUNT(*) AS c FROM money_makers`).get() as { c: number };
  return row.c;
}
