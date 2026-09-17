import { db, getOfficialEventsWithBody, getRecentRedditEvents } from "./db.js";
import {
  classifySentence,
  escapeRegex,
  isDistinctiveName,
  isTitleWorthyName,
  isWholeItemMention,
  IS_CHANGELOG,
  sentenceAround,
  titleMentionsItem,
  type PriceImpact,
} from "./newsImpact.js";

// "Official news says something about an item you are holding."
//
// The motivating request was narrower -- warn me when an item I hold is getting nerfed -- and
// that is still the headline case and what the ranking below is built around. But the reliable
// half of the job and the speculative half are very different in kind, and they are kept apart on
// purpose:
//
//   FINDING the mention is deterministic. An item's name either appears in the changelog or it
//   does not. This part does not guess and is never wrong in a way that matters.
//
//   READING it is a heuristic. Whether a sentence means the price goes up or down is a judgement
//   about a game update, made from keywords, and it will sometimes be wrong.
//
// So a match is always reported with the sentence that produced it, and the direction travels as
// a label ON that evidence rather than as a replacement for it. The reader can overrule the guess
// in the time it takes to read one line, which is the only honest arrangement for a classifier
// this crude sitting underneath a decision about real money.
//
// That second half lives in newsImpact.ts, which is pure string work and has tests. This file is
// the part that needs a database: which items, which articles, and joining the two.
//
// No LLM. eventItemLinking.ts asks a local Ollama model which items a post mentions, and that is
// the right tool for Reddit, where posts say "tbow" and "the new amulet". Patch notes are not
// written that way: they use exact in-game names, because they are written against the same item
// list the game uses. Exact matching is therefore both more accurate AND more available here --
// it keeps working while Ollama is down, which is the state this machine was in when the feature
// was built, and it can show its reasoning, which a model's answer cannot.

// Rarely-changing catalogue read, fetched per scan rather than cached across scans -- the
// alternative is a stale name map surviving an item rename for the life of the process.
const heldNamesStmt = db.prepare(`SELECT id, name FROM items`);

// How far back to read. Patch notes older than this describe a market that has already absorbed
// them: the point of the alert is to reach you before the price does, and a nerf from four months
// ago is priced in and is simply history by now.
const DEFAULT_LOOKBACK_DAYS = 45;

export interface NerfWatchMatch {
  itemId: number;
  itemName: string;
  eventId: number;
  eventDate: string;
  title: string;
  link: string | null;
  impact: PriceImpact;
  basis: string;
  /** The sentence from the changelog, verbatim. The reader's means of overruling the label. */
  quote: string;
}

/**
 * Scan recent official changelogs for the given items.
 *
 * Takes ids rather than scanning the whole catalogue against every article. That is a precision
 * decision before it is a performance one: across 4,600 items some name collides with ordinary
 * English in almost any article, and a false "the thing you are holding is being nerfed" costs
 * far more trust than a missed mention costs value.
 */
export function scanForHeldItems(
  itemIds: number[],
  lookbackDays = DEFAULT_LOOKBACK_DAYS,
): NerfWatchMatch[] {
  if (itemIds.length === 0) return [];

  const wanted = new Set(itemIds);
  const rows = heldNamesStmt.all() as unknown as { id: number; name: string }[];
  const held = rows.filter((r) => wanted.has(r.id) && isDistinctiveName(r.name));
  if (held.length === 0) return [];

  // The WHOLE catalogue, not just the held rows: the longer name that swallows a match is
  // usually something the reader does not own (nobody holding Rune essence necessarily holds a
  // Rune Essence Pouch), so checking only their own items would miss exactly the collisions this
  // is here to catch.
  const catalogue = new Set(rows.map((r) => r.name.toLowerCase()));

  const cutoff = new Date(Date.now() - lookbackDays * 86_400_000).toISOString().slice(0, 10);
  const events = getOfficialEventsWithBody(60)
    .filter((e) => e.event_date >= cutoff)
    .filter((e) => IS_CHANGELOG.test(e.body));

  const matches: NerfWatchMatch[] = [];
  for (const event of events) {
    for (const item of held) {
      // Word-boundary so "Rune platebody" cannot be found inside "Runecrafting", and
      // case-insensitive because prose lowercases names mid-sentence.
      const re = new RegExp(`\\b${escapeRegex(item.name)}\\b`, "gi");
      let m: RegExpExecArray | null = null;
      let found: RegExpExecArray | null = null;
      // Keep looking past a swallowed match rather than giving up on the article: the first
      // "Rune essence" in a patch note is often inside "Rune Essence Pouch" while a later one
      // genuinely names the item, and stopping at the first hit would lose that.
      while ((m = re.exec(event.body)) != null) {
        if (isWholeItemMention(event.body, m.index, m[0].length, item.name, catalogue)) {
          found = m;
          break;
        }
      }
      if (!found) continue;

      const quote = sentenceAround(event.body, found.index, found[0].length);
      const { impact, basis } = classifySentence(quote);
      matches.push({
        itemId: item.id,
        itemName: item.name,
        eventId: event.id,
        eventDate: event.event_date,
        title: event.title,
        link: event.link,
        impact,
        basis,
        quote,
      });
    }
  }

  // Nerfs first, then buffs, then bare mentions, newest first inside each band. The ordering is
  // half the feature: this is a list you skim, so the thing that costs money if missed belongs at
  // the top of it.
  const rank: Record<PriceImpact, number> = { nerf: 0, buff: 1, unclear: 2 };
  return matches.sort(
    (a, b) => rank[a.impact] - rank[b.impact] || b.eventDate.localeCompare(a.eventDate),
  );
}

// Reddit chatter, reported separately and never mixed into the list above.
//
// A changelog is a fact about the game. A Reddit thread is a fact about a conversation, and the
// two are different enough that merging them would let the weaker one borrow the stronger one's
// authority -- the whole reason this is a second function and a second list rather than another
// source column on the same rows.
//
// It still earns its place. Chatter frequently leads the price: r/OSRSflipping notices a supply
// shock or starts a squeeze before it shows up in the candles, and "eleven posts about something
// you are holding" is worth a look however little any single post is worth. So what gets reported
// is the VOLUME and the headlines, not a reading of them.

// Shorter than the official window on purpose. Patch notes keep mattering for as long as the
// change is live, while a thread is stale within days -- last month's hype is not a signal, it is
// a thing that already happened to the price.
const CHATTER_LOOKBACK_DAYS = 14;

// Enough posts to look at, not so many that the section becomes a feed. Ordered by volume, so a
// cut here only ever drops the quietest items.
const MAX_CHATTER_ITEMS = 12;
const MAX_POSTS_PER_ITEM = 5;

export interface ChatterPost {
  eventId: number;
  eventDate: string;
  title: string;
  link: string | null;
  /** Subreddit, as stored in tags. Which room the talking happened in changes what it is worth. */
  tags: string | null;
  /** True when the model linked this post rather than the title matching by name. */
  viaModel: boolean;
}

export interface ChatterItem {
  itemId: number;
  itemName: string;
  posts: ChatterPost[];
}

export function scanChatter(
  itemIds: number[],
  lookbackDays = CHATTER_LOOKBACK_DAYS,
): ChatterItem[] {
  if (itemIds.length === 0) return [];

  const wanted = new Set(itemIds);
  const rows = heldNamesStmt.all() as unknown as { id: number; name: string }[];
  const held = rows.filter((r) => wanted.has(r.id) && isTitleWorthyName(r.name));
  if (held.length === 0) return [];

  const catalogue = new Set(rows.map((r) => r.name.toLowerCase()));
  const since = new Date(Date.now() - lookbackDays * 86_400_000).toISOString().slice(0, 10);
  const events = getRecentRedditEvents(since, 300);

  const byItem = new Map<number, ChatterItem>();
  for (const event of events) {
    // Two ways in, unioned. The model catches slang a name match never will ("Tbow made me more
    // money here than my last 10 cox chests" links to Twisted bow); the name match keeps working
    // when the model is unavailable, which is most of the time on this install. Neither alone
    // covers the board.
    const linked = new Set<number>();
    if (event.linked_item_ids) {
      try {
        for (const id of JSON.parse(event.linked_item_ids) as number[]) linked.add(id);
      } catch {
        // A malformed links column is not a reason to drop the post -- the title match below
        // still stands on its own.
      }
    }

    for (const item of held) {
      const byModel = linked.has(item.id);
      if (!byModel && !titleMentionsItem(event.title, item.name, catalogue)) continue;

      let entry = byItem.get(item.id);
      if (!entry) {
        entry = { itemId: item.id, itemName: item.name, posts: [] };
        byItem.set(item.id, entry);
      }
      if (entry.posts.length < MAX_POSTS_PER_ITEM) {
        entry.posts.push({
          eventId: event.id,
          eventDate: event.event_date,
          title: event.title,
          link: event.link,
          tags: event.tags,
          viaModel: byModel,
        });
      }
    }
  }

  // Loudest first: with no sentiment being claimed, how much is being said IS the signal, and one
  // stray post about an item is exactly the thing not worth a row.
  return [...byItem.values()]
    .sort((a, b) => b.posts.length - a.posts.length || a.itemName.localeCompare(b.itemName))
    .slice(0, MAX_CHATTER_ITEMS);
}
