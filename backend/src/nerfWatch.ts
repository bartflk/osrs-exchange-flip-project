import { db, getOfficialEventsWithBody } from "./db.js";

// "Official news says something about an item you are holding."
//
// The motivating request was narrower -- warn me when an item I hold is getting nerfed -- and
// that is still the headline case and what the ranking below is built around. But the reliable
// half of the job and the speculative half are very different in kind, and this module keeps them
// apart on purpose:
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

// Only articles that actually carry a changelog get scanned.
//
// The official feed is a newsroom, not a patch log. Of 28 fetched articles only 8 contained a
// changelog; the rest were podcast episodes, community spotlights, charity events and launcher
// announcements. Those are still prose full of item names, and scanning them produced exactly the
// mentions you would expect -- "I realized I lost my tinderbox so I started a new account", from
// an interview. Nobody holding a tinderbox needs to hear about that.
//
// Rewards blogs are excluded by this too, and that is a real cost, since a rewards blog is often
// the first public word that an item is changing. It is accepted deliberately: a blog proposes
// and a changelog records, so a blog's claims are conditional on a poll that may fail, and the
// alert is more useful being quiet and right than early and speculative.
const IS_CHANGELOG = /\b(changelog|patch notes|hotfix)\b/i;

// A bank import is a few hundred items, most of them incidental -- runes, food, teleports, stray
// clue rewards. Scanning a 28,000-character changelog for "Shark" fires on every fishing tweak,
// and every one of those hits is noise, because a short single-word name is a word the English
// language was already using.
//
// The filter is shape, not a blocklist. In-game names for anything worth flipping are nearly
// always compound ("Twisted bow", "Dragon warhammer", "Bandos chestplate"), while the names that
// collide with ordinary prose are short single words ("Shark", "Bones", "Coal", "Rope"). A
// blocklist would need endless maintenance and would still miss the next collision; requiring a
// name to be structurally distinctive costs one rule and generalises.
const MIN_COMPOUND_LENGTH = 6; // "Iron bar" qualifies, "Pot" would not
const MIN_SINGLE_WORD_LENGTH = 9; // "Feather" (7) is out; anything valuable is compound anyway

function isDistinctiveName(name: string): boolean {
  const trimmed = name.trim();
  if (trimmed.includes(" ")) return trimmed.length >= MIN_COMPOUND_LENGTH;
  return trimmed.length >= MIN_SINGLE_WORD_LENGTH;
}

/**
 * Does this update push the price up or down?
 *
 * Expressed from the FLIPPER's side, which is not the same as the player's, and that distinction
 * is what the whole classifier turns on. A drop rate made more generous is good news for a player
 * and bad news for anyone holding the item, because it is a supply increase. Getting that
 * backwards would make the alert worse than useless, so supply wording is tested before item
 * wording and wins outright when both appear.
 */
export type PriceImpact = "nerf" | "buff" | "unclear";

// Is this sentence about GETTING the item, or about USING it? "Increased" means opposite things
// either side of that line -- an increased drop rate is more supply, an increased attack bonus is
// more demand -- so the line has to be drawn before the direction can be read.
const SUPPLY_CONTEXT = /\b(drop rate|drop chance|droprate|drop table|rarity|rarer)\b/i;

const MORE_SUPPLY =
  /\b(increas(?:e|es|ed|ing)|improv(?:e|es|ed)|buff(?:ed|s)?|more common|higher|better|now (?:also )?drops?)\b/i;
const LESS_SUPPLY =
  /\b(decreas(?:e|es|ed|ing)|reduc(?:e|es|ed|tion)|lower(?:ed)?|rarer|less common|removed from|no longer drops?)\b/i;

// Wording about the item itself, deliberately narrow: the literal words "nerf" and "buff".
//
// This started far wider -- reduced/decreased/weakened/removed against
// increased/improved/boosted -- and a scan of six weeks of real patch notes showed that version
// getting the direction wrong more often than right. Every failure was the same kind. "The
// hitpoints requirement for equipping a Nightmare Staff has been removed" is a BUFF, read as a
// nerf on "removed". "These amulets serving as a slight increase over the Occult Necklace" is
// bearish for the necklace, read as a buff on "increase" because the sentence names a rival.
// "Blood essence ... will not boost extra runes" is a limitation, read as a buff on "boost".
//
// The common thread is that those verbs need a subject to mean anything, and finding the subject
// is parsing, not matching. So the rule now claims a direction only where the patch notes state
// one outright, and everything else is reported as a mention with the sentence attached. A wrong
// label is worse than no label here: it is a confident claim about money, and one bad call costs
// more trust than a dozen honest "mentioned" rows ever earn.
const EXPLICIT_NERF = /\bnerf(?:ed|s|ing)?\b/i;
const EXPLICIT_BUFF = /\bbuff(?:ed|s|ing)?\b/i;

// Cosmetic and interface changes name items constantly and move no market. Left in, they were the
// single largest source of false nerfs -- "The Bronze scimitar crate on Ape Atoll no longer shows
// a picture of an Iron scimitar" is a sprite fix that read as two separate nerfs.
const COSMETIC =
  /\b(shows? a picture|picture of|sprite|icon|graphic(?:al|s)?|animation|displayed?|display|tooltip|interface|typo|spelling|wording|colour|color|model|examine text|right-click|menu entry)\b/i;

export interface ImpactReading {
  impact: PriceImpact;
  /** Why it said that, in the words of the rule that fired. Shown to the reader, never inferred. */
  basis: string;
}

export function classifySentence(sentence: string): ImpactReading {
  if (COSMETIC.test(sentence)) {
    return { impact: "unclear", basis: "looks like a cosmetic or interface change" };
  }

  // Explicit wording beats inference, in both directions, and is checked first so that a patch
  // note saying "nerf" is never talked out of it by surrounding supply language.
  const saysNerf = EXPLICIT_NERF.test(sentence);
  const saysBuff = EXPLICIT_BUFF.test(sentence);
  if (saysNerf && !saysBuff) return { impact: "nerf", basis: "the patch notes call it a nerf" };
  if (saysBuff && !saysNerf) return { impact: "buff", basis: "the patch notes call it a buff" };

  if (SUPPLY_CONTEXT.test(sentence)) {
    const more = MORE_SUPPLY.test(sentence);
    const less = LESS_SUPPLY.test(sentence);
    // Both directions in one sentence is a compound change ("reduced the rate from X, but added a
    // second source"), and picking one would be a coin toss presented as a finding.
    if (more && !less) return { impact: "nerf", basis: "dropped more often, so more supply" };
    if (less && !more) return { impact: "buff", basis: "dropped less often, so less supply" };
    return { impact: "unclear", basis: "changes how it drops, but cuts both ways" };
  }

  return { impact: "unclear", basis: "named in the update, direction not stated" };
}

// Bounded on both sides, because a changelog that lost its bullet structure can run for thousands
// of characters without a full stop, and an unbounded slice would quote half the patch notes as
// evidence for one item.
const MAX_SENTENCE_CHARS = 320;

function sentenceAround(body: string, matchIndex: number, matchLength: number): string {
  const from = Math.max(0, matchIndex - MAX_SENTENCE_CHARS);
  const to = Math.min(body.length, matchIndex + matchLength + MAX_SENTENCE_CHARS);
  const window = body.slice(from, to);
  const localIdx = matchIndex - from;

  const before = window.lastIndexOf(". ", localIdx);
  const after = window.indexOf(". ", localIdx + matchLength);
  const start = before === -1 ? 0 : before + 2;
  const end = after === -1 ? window.length : after + 1;
  return window.slice(start, end).trim();
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Is this match really THIS item, or the front of a longer item's name?
 *
 * A word boundary stops "Rune platebody" being found inside "Runecrafting", but it is perfectly
 * happy to find "Rune essence" inside "Rune Essence Pouch" -- which is a different item, from a
 * different market, and was the first false positive a real scan produced.
 *
 * The fix is to ask the catalogue rather than to guess: extend the match by one word in each
 * direction and see whether that longer string is also an item. If it is, the changelog was
 * talking about the longer one. This costs a set lookup and generalises to every such pair
 * ("Dragon bolts" inside "Dragon bolts (e)", "Magic logs" inside "Magic logs noted") without a
 * list of special cases to maintain.
 */
function isWholeItemMention(
  body: string,
  matchIndex: number,
  matchLength: number,
  name: string,
  catalogue: Set<string>,
): boolean {
  const nextWord = /^\s+([A-Za-z()'-]+)/.exec(body.slice(matchIndex + matchLength));
  if (nextWord && catalogue.has(`${name} ${nextWord[1]}`.toLowerCase())) return false;

  const prevWord = /([A-Za-z()'-]+)\s+$/.exec(body.slice(Math.max(0, matchIndex - 40), matchIndex));
  if (prevWord && catalogue.has(`${prevWord[1]} ${name}`.toLowerCase())) return false;

  // Containers and variants named after their contents, which the catalogue cannot rule out
  // because they are not themselves tradeable. "Increased the drop rate of the Rune Essence
  // Pouch" is about a pouch that has no item row, so the check above passes it through as a
  // mention of Rune essence -- a real false positive from a real scan, and one that produced the
  // only directional call in the whole run.
  //
  // A short curated list rather than a rule, and openly so: the general version ("followed by any
  // capitalised word") would swallow legitimate mentions at the end of a sentence, and these few
  // nouns cover the pattern that actually occurs in patch notes.
  if (nextWord && CONTAINER_SUFFIXES.has(nextWord[1].toLowerCase())) return false;

  return true;
}

const CONTAINER_SUFFIXES = new Set([
  "pouch",
  "pouches",
  "case",
  "crate",
  "box",
  "sack",
  "bag",
  "pack",
  "kit",
  "set",
  "storage",
]);

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
      m = found;

      const quote = sentenceAround(event.body, m.index, m[0].length);
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
