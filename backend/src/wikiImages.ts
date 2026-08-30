import { db } from "./db.js";

// Item icons for names that are not in the GE catalogue, resolved through the wiki's own API.
//
// The GE catalogue covers tradeables and nothing else, so it has no icon for roughly half of what
// appears in a real loadout -- Darklight, an infernal cape, void, Rada's blessing. The first
// attempt at filling those gaps guessed a filename from the item name ("Saradomin brew" ->
// "Saradomin_brew.png") and mostly 404'd, because the wiki's files carry dose and charge suffixes
// the guides do not: the actual file is "Saradomin brew(4) detail.png", and the Scythe of Vitur
// lives at "Scythe of Vitur (uncharged) detail.png". A dozen inventory slots rendered as truncated
// text instead of icons.
//
// `prop=pageimages` answers the question properly: it maps a PAGE to that page's lead image, and
// MediaWiki resolves redirects and title normalisation on the way, so "Eye of Ayak (uncharged)"
// follows its redirect to "Eye of Ayak" and returns that page's image. Every name that failed the
// guess resolves this way. Fifty titles per request, so a whole boss setup costs one call.

const API = "https://oldschool.runescape.wiki/api.php";
const USER_AGENT = "osrs-flip-assistant/1.0 (local single-user GE tool)";
const TITLES_PER_QUERY = 50;
// Resolutions are cached, including MISSES. A name with no wiki page is a permanent fact about the
// name, not a transient failure, and re-asking on every render would put a request on the wiki for
// every "Cheap food" line in the list.
const CACHE_TTL_SECONDS = 30 * 24 * 60 * 60;
const MISS = "";

db.exec(`
  CREATE TABLE IF NOT EXISTS wiki_item_images (
    name TEXT PRIMARY KEY,
    url TEXT NOT NULL,
    fetched_at INTEGER NOT NULL
  )
`);

const getStmt = db.prepare(`SELECT url, fetched_at FROM wiki_item_images WHERE name = ?`);
const putStmt = db.prepare(
  `INSERT INTO wiki_item_images (name, url, fetched_at) VALUES (?, ?, ?)
   ON CONFLICT(name) DO UPDATE SET url = excluded.url, fetched_at = excluded.fetched_at`,
);

function headers() {
  return { "User-Agent": USER_AGENT, Accept: "application/json" };
}

/**
 * Whether a string can be sent as a MediaWiki page title at all.
 *
 * This guard exists because of a real and badly-behaved failure. Titles are batched into a single
 * `titles=A|B|C` parameter, so ONE name containing a pipe silently splits into several and the
 * request blows the 50-value limit -- taking the whole batch with it. A wikitext comment blob was
 * leaking out of the guide parser as an "item name", carrying `|||}}` and `|=green` inside it, and
 * every one of the 49 innocent names batched alongside it was recorded as having no image. That is
 * how a single malformed name cost roughly half the icons on the page.
 */
function isValidTitle(name: string): boolean {
  // The characters MediaWiki forbids in titles, plus the 255-byte length cap.
  return !/[|#<>[\]{}]/.test(name) && Buffer.byteLength(name, "utf8") <= 255;
}

/** Cached URL, or undefined when this name has never been looked up (or has gone stale). */
function cached(name: string): string | undefined {
  const row = getStmt.get(name.toLowerCase()) as
    | { url: string; fetched_at: number }
    | undefined;
  if (!row) return undefined;
  if (Math.floor(Date.now() / 1000) - row.fetched_at > CACHE_TTL_SECONDS) return undefined;
  return row.url;
}

/**
 * Wiki thumbnail URLs for the given item names, as a name -> url map.
 *
 * Names with no wiki page are simply absent from the result, so a caller can treat "no entry" and
 * "no image" identically -- there is nothing useful it could do differently.
 */
export async function resolveWikiImages(names: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const unknown: string[] = [];

  for (const name of new Set(names.map((n) => n.trim()).filter(Boolean))) {
    if (!isValidTitle(name)) continue;
    const hit = cached(name);
    if (hit === undefined) unknown.push(name);
    else if (hit !== MISS) out.set(name, hit);
  }
  if (unknown.length === 0) return out;

  const now = Math.floor(Date.now() / 1000);
  for (let i = 0; i < unknown.length; i += TITLES_PER_QUERY) {
    const batch = unknown.slice(i, i + TITLES_PER_QUERY);
    try {
      const url =
        `${API}?action=query&format=json&formatversion=2&redirects=1` +
        `&prop=pageimages&piprop=thumbnail&pithumbsize=64&pilimit=${TITLES_PER_QUERY}` +
        `&titles=${encodeURIComponent(batch.join("|"))}`;
      const res = await fetch(url, { headers: headers() });
      if (!res.ok) continue;
      const json = (await res.json()) as {
        error?: { code: string; info: string };
        query?: {
          pages?: { title: string; missing?: boolean; thumbnail?: { source: string } }[];
          normalized?: { from: string; to: string }[];
          redirects?: { from: string; to: string }[];
        };
      };
      // MediaWiki returns errors as HTTP 200 with an `error` body, so `res.ok` proves nothing.
      // Without this check a rejected batch looked like a batch where nothing had an image, and
      // all 50 names were cached as permanent misses for a month.
      if (json.error || !json.query) {
        console.error(`[wiki-images] batch rejected: ${json.error?.info ?? "no query in response"}`);
        continue;
      }

      // The API answers under the RESOLVED title, so a requested name that redirected has to be
      // mapped back or its result is silently dropped and re-fetched forever.
      const resolvedName = new Map<string, string>();
      for (const r of [...(json.query?.normalized ?? []), ...(json.query?.redirects ?? [])]) {
        resolvedName.set(r.from, r.to);
      }
      const byTitle = new Map<string, string>();
      for (const page of json.query?.pages ?? []) {
        if (page.thumbnail?.source) byTitle.set(page.title, page.thumbnail.source);
      }

      for (const name of batch) {
        // A redirect can chain (requested -> normalised -> redirect target), so follow until it
        // stops moving rather than assuming one hop.
        let title = name;
        for (let hop = 0; hop < 4; hop++) {
          const next = resolvedName.get(title);
          if (!next || next === title) break;
          title = next;
        }
        const found = byTitle.get(title) ?? byTitle.get(name);
        putStmt.run(name.toLowerCase(), found ?? MISS, now);
        if (found) out.set(name, found);
      }
    } catch {
      // Icons are decoration. A failed batch leaves those names uncached so the next render
      // retries, and the grid falls back to item names in the meantime.
    }
  }
  return out;
}
