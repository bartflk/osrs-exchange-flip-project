import { db } from "./db.js";

// Item group membership, taken from the wiki's own category graph instead of a hand-written list.
//
// DESIGN.md §16. The curated alternative already exists in sectors.ts: six baskets covering 44
// items of 4,510 priced. Its real problem is not the coverage but that a hardcoded array needs a
// human to remember every new raid, every new boss and every rebalance, forever.
//
// `list=categorymembers` hands over a whole category in one request, and the wiki maintains it as
// a side effect of writing item pages. Content categories carry monsters and mechanics next to
// items -- Chambers of Xeric lists "Abyssal portal" and "Acidic miasma" beside the Twisted bow --
// and intersecting with this app's priced catalogue solves that for free, because an NPC has no GE
// price. Chambers of Xeric reduces from 196 members to exactly its 14 priced uniques.

const API = "https://oldschool.runescape.wiki/api.php";
const USER_AGENT = "osrs-flip-assistant/1.0 (local single-user GE tool)";
const CACHE_TTL_SECONDS = 7 * 24 * 60 * 60;
const REQUEST_SPACING_MS = 150;

export interface IndexDefinition {
  key: string;
  label: string;
  group: string;
  /** Wiki category name, without the "Category:" prefix. */
  category: string;
}

/**
 * Every index and the wiki category behind it.
 *
 * The list is curated, the MEMBERSHIP is not, and that is the whole point: choosing which forty
 * groupings are worth a row is a judgement call that changes about never, while choosing which
 * items belong in "Ranged weapons" changes with every update.
 *
 * Each entry was checked live before being added. Categories that turn out to be empty are
 * recorded in DESIGN.md §16.3 rather than left here to fail quietly: `Bars`, `Planks`, `Raw fish`,
 * `Secondary ingredients`, `Clue scroll items`, `Third Age`, `Revenants`, `Desert Treasure II` and
 * `Nightmare of Ashihama` all return nothing. The live names are `Metal bars`, `Fish` and so on.
 */
export const INDEX_DEFINITIONS: IndexDefinition[] = [
  // --- Combat gear, by what the item is
  { key: "two-handed", label: "Two-handed", group: "Combat gear", category: "Two-handed slot items" },
  { key: "melee-weapons", label: "Melee weapons", group: "Combat gear", category: "Melee weapons" },
  { key: "ranged-weapons", label: "Ranged weapons", group: "Combat gear", category: "Ranged weapons" },
  { key: "magic-weapons", label: "Magic weapons", group: "Combat gear", category: "Magic weapons" },
  { key: "melee-armour", label: "Melee armour", group: "Combat gear", category: "Melee armour" },
  { key: "ranged-armour", label: "Ranged armour", group: "Combat gear", category: "Ranged armour" },
  { key: "magic-armour", label: "Magic armour", group: "Combat gear", category: "Magic armour" },
  { key: "helmets", label: "Helmets", group: "Combat gear", category: "Helmets" },
  { key: "amulets", label: "Amulets", group: "Combat gear", category: "Amulets" },
  { key: "rings", label: "Rings", group: "Combat gear", category: "Rings" },
  { key: "boots", label: "Boots", group: "Combat gear", category: "Boots" },
  { key: "gloves", label: "Gloves", group: "Combat gear", category: "Gloves" },
  { key: "capes", label: "Capes", group: "Combat gear", category: "Capes" },

  // --- Ammunition
  { key: "bolts", label: "Bolts", group: "Ammunition", category: "Bolts" },
  { key: "arrows", label: "Arrows", group: "Ammunition", category: "Arrows" },
  { key: "darts", label: "Darts", group: "Ammunition", category: "Darts" },
  { key: "javelins", label: "Javelins", group: "Ammunition", category: "Javelins" },

  // --- Skilling materials
  { key: "herbs", label: "Herbs", group: "Materials", category: "Herbs" },
  { key: "bars", label: "Metal bars", group: "Materials", category: "Metal bars" },
  { key: "gems", label: "Gems", group: "Materials", category: "Gems" },
  { key: "fish", label: "Fish", group: "Materials", category: "Fish" },
  { key: "ores", label: "Ores", group: "Materials", category: "Ores" },
  { key: "seeds", label: "Seeds", group: "Materials", category: "Seeds" },
  { key: "logs", label: "Logs", group: "Materials", category: "Logs" },

  // --- Consumables
  { key: "runes", label: "Runes", group: "Consumables", category: "Runes" },
  { key: "food", label: "Food", group: "Consumables", category: "Food" },
  { key: "potions", label: "Potions", group: "Consumables", category: "Potions" },
  { key: "bones", label: "Bones", group: "Consumables", category: "Bones" },

  // --- By skill
  { key: "smithing", label: "Smithing", group: "By skill", category: "Smithing" },
  { key: "crafting", label: "Crafting", group: "By skill", category: "Crafting" },
  { key: "prayer", label: "Prayer", group: "By skill", category: "Prayer items" },
  { key: "fletching", label: "Fletching", group: "By skill", category: "Fletching" },
  { key: "herblore", label: "Herblore", group: "By skill", category: "Herblore" },
  { key: "farming", label: "Farming", group: "By skill", category: "Farming" },
  { key: "cooking", label: "Cooking", group: "By skill", category: "Cooking" },
  { key: "construction", label: "Construction", group: "By skill", category: "Construction" },

  // --- Where it drops
  { key: "cox", label: "Chambers of Xeric", group: "Content", category: "Chambers of Xeric" },
  { key: "gwd", label: "God Wars Dungeon", group: "Content", category: "God Wars Dungeon" },
  { key: "toa", label: "Tombs of Amascut", group: "Content", category: "Tombs of Amascut" },
  { key: "wilderness", label: "Wilderness", group: "Content", category: "Wilderness" },
  { key: "tob", label: "Theatre of Blood", group: "Content", category: "Theatre of Blood" },
  { key: "barrows", label: "Barrows", group: "Content", category: "Barrows equipment" },
];

db.exec(`
  CREATE TABLE IF NOT EXISTS item_categories (
    category TEXT NOT NULL,
    item_id INTEGER NOT NULL,
    PRIMARY KEY (category, item_id)
  )
`);
db.exec(`
  CREATE TABLE IF NOT EXISTS item_category_fetches (
    category TEXT PRIMARY KEY,
    members INTEGER NOT NULL,
    fetched_at INTEGER NOT NULL
  )
`);

const fetchStateStmt = db.prepare(
  `SELECT members, fetched_at FROM item_category_fetches WHERE category = ?`,
);
const putFetchStmt = db.prepare(
  `INSERT INTO item_category_fetches (category, members, fetched_at) VALUES (?, ?, ?)
   ON CONFLICT(category) DO UPDATE SET members = excluded.members, fetched_at = excluded.fetched_at`,
);
const clearMembersStmt = db.prepare(`DELETE FROM item_categories WHERE category = ?`);
const addMemberStmt = db.prepare(
  `INSERT OR IGNORE INTO item_categories (category, item_id) VALUES (?, ?)`,
);
const membersStmt = db.prepare(`SELECT item_id FROM item_categories WHERE category = ?`);
const itemIdsStmt = db.prepare(
  `SELECT i.id, i.name FROM items i JOIN latest_snapshot s ON s.item_id = i.id
   WHERE s.high IS NOT NULL`,
);

function headers() {
  return { "User-Agent": USER_AGENT, Accept: "application/json" };
}

/** Priced items keyed by lowercased name, which is how wiki titles are matched. */
function pricedByName(): Map<string, number> {
  const rows = itemIdsStmt.all() as unknown as { id: number; name: string }[];
  return new Map(rows.map((r) => [r.name.toLowerCase(), r.id]));
}

/** Every page in a category, following continuation. */
async function fetchCategoryMembers(category: string): Promise<string[]> {
  const titles: string[] = [];
  let cont: string | undefined;
  do {
    const url =
      `${API}?action=query&format=json&formatversion=2&list=categorymembers` +
      `&cmtitle=${encodeURIComponent(`Category:${category}`)}` +
      // Namespace 0 only: a category also holds its own subcategories and Talk pages, and those
      // are not items.
      `&cmlimit=500&cmnamespace=0` +
      (cont ? `&cmcontinue=${encodeURIComponent(cont)}` : "");
    const res = await fetch(url, { headers: headers() });
    if (!res.ok) throw new Error(`categorymembers ${category} failed: ${res.status}`);
    const json = (await res.json()) as {
      error?: { info: string };
      query?: { categorymembers?: { title: string }[] };
      continue?: { cmcontinue: string };
    };
    // MediaWiki returns errors as HTTP 200 with an `error` body, so res.ok proves nothing. The
    // same trap cost wikiImages.ts half its icons before it was guarded.
    if (json.error) throw new Error(`categorymembers ${category}: ${json.error.info}`);
    for (const m of json.query?.categorymembers ?? []) titles.push(m.title);
    cont = json.continue?.cmcontinue;
  } while (cont);
  return titles;
}

export interface CategoryRefreshResult {
  category: string;
  wikiMembers: number;
  pricedMembers: number;
}

/**
 * Refresh membership for every index whose cache has expired.
 *
 * Additive, not load-bearing: one category failing logs and leaves the other thirty-nine working,
 * which matters because this runs on a schedule and a wiki hiccup must not take the page with it.
 */
export async function refreshItemCategories(
  force = false,
): Promise<{ refreshed: CategoryRefreshResult[]; skipped: number; failed: string[] }> {
  const priced = pricedByName();
  const now = Math.floor(Date.now() / 1000);
  const refreshed: CategoryRefreshResult[] = [];
  const failed: string[] = [];
  let skipped = 0;

  for (const def of INDEX_DEFINITIONS) {
    const state = fetchStateStmt.get(def.category) as
      | { members: number; fetched_at: number }
      | undefined;
    if (!force && state && now - state.fetched_at < CACHE_TTL_SECONDS) {
      skipped++;
      continue;
    }

    try {
      const titles = await fetchCategoryMembers(def.category);
      const ids = titles
        .map((t) => priced.get(t.toLowerCase()))
        .filter((id): id is number => id != null);

      // Replaced wholesale rather than merged. An item removed from a wiki category has genuinely
      // left the group, and merging would keep it forever.
      clearMembersStmt.run(def.category);
      for (const id of ids) addMemberStmt.run(def.category, id);
      putFetchStmt.run(def.category, ids.length, now);

      refreshed.push({
        category: def.category,
        wikiMembers: titles.length,
        pricedMembers: ids.length,
      });
      // A category that resolves to nothing is a broken definition, not an empty market, and it
      // must be loud. Nine plausible-looking names were tried during research and returned zero.
      if (ids.length === 0) {
        console.error(`[categories] "${def.category}" resolved to 0 priced items, check the name`);
      }
    } catch (err) {
      console.error(`[categories] ${def.category} failed:`, err);
      failed.push(def.category);
    }
    await new Promise((r) => setTimeout(r, REQUEST_SPACING_MS));
  }

  console.log(
    `[categories] refreshed ${refreshed.length}, skipped ${skipped} still fresh, ${failed.length} failed`,
  );
  return { refreshed, skipped, failed };
}

/** Cached item ids for a category. Empty when it has never been fetched. */
export function categoryMemberIds(category: string): number[] {
  return (membersStmt.all(category) as unknown as { item_id: number }[]).map((r) => r.item_id);
}

/** Whether anything has been fetched yet, so callers can trigger a first load. */
export function categoriesPopulated(): boolean {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM item_categories`).get() as unknown as {
    n: number;
  };
  return row.n > 0;
}
