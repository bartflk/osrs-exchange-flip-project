// Reading a patch note: which articles are worth scanning, which names are worth looking for,
// which sentence a match sits in, and whether that sentence sounds like good or bad news for
// someone holding the item.
//
// Split out of nerfWatch.ts so it can be tested. Everything here is a pure function of strings --
// no database, no network, no clock -- which is exactly the part that needed tests, because it is
// a pile of heuristics tuned against real patch notes and the failure mode is a confident wrong
// answer rather than a crash. nerfWatch.ts keeps the half that talks to the database, and
// newsImpact.test.ts pins the half that does the guessing.

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
export const IS_CHANGELOG = /\b(changelog|patch notes|hotfix)\b/i;

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

export function isDistinctiveName(name: string): boolean {
  const trimmed = name.trim();
  if (trimmed.includes(" ")) return trimmed.length >= MIN_COMPOUND_LENGTH;
  return trimmed.length >= MIN_SINGLE_WORD_LENGTH;
}

// A Reddit post title is scanned under looser rules than a changelog, and the reason is the
// amount of text, not the source's quality.
//
// isDistinctiveName above exists because a 28,000-character article will contain the word "Shark"
// for reasons having nothing to do with the item. A post title is twenty characters and is a
// TOPIC LABEL: "Coal near all time lows" is not prose that happens to contain "Coal", it is a post
// about coal. The collision risk that justified the longer floor is mostly absent, and applying
// that floor here would throw away the clearest signals on the board -- Coal, Bones and Yew logs
// are staples people post about precisely because they are flipped constantly.
//
// A floor remains, because two- and three-letter names would match initialisms and stray words.
const MIN_TITLE_NAME_LENGTH = 4;

export function isTitleWorthyName(name: string): boolean {
  return name.trim().length >= MIN_TITLE_NAME_LENGTH;
}

/**
 * Is this item the subject of a post title?
 *
 * Deliberately no sentiment reading. The classifier below is tuned on changelog grammar -- "we
 * have reduced the drop rate of X" -- and a Reddit title is a different language: "OCCULT AMULETS
 * TO MOON?", "Snape grass fomo", "Do we think Yew Logs will ever make a comeback?". Running
 * patch-note rules over that would produce confident nonsense, and the honest signal is the one
 * that needs no interpretation: people are posting about a thing you own, and here are the
 * headlines. The reader can weigh a title faster than any keyword rule could.
 */
export function titleMentionsItem(title: string, name: string, catalogue: Set<string>): boolean {
  if (!isTitleWorthyName(name)) return false;
  const re = new RegExp(`\\b${escapeRegex(name)}\\b`, "gi");
  let m: RegExpExecArray | null = null;
  while ((m = re.exec(title)) != null) {
    if (isWholeItemMention(title, m.index, m[0].length, name, catalogue)) return true;
  }
  return false;
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

// "more often" and "less often" are here because a test caught their absence: "we reduced the
// drop rate from Vorkath but added a second source, so it drops more often overall" was called a
// straight buff, because only the "reduced" half was recognised. A sentence that changes supply
// in both directions has to be seen as doing so, otherwise the half the rules happen to know
// about wins by default -- which is the worst kind of wrong answer, a confident one arrived at by
// not looking.
const MORE_SUPPLY =
  /\b(increas(?:e|es|ed|ing)|improv(?:e|es|ed)|buff(?:ed|s)?|more common|more often|higher|better|now (?:also )?drops?)\b/i;
const LESS_SUPPLY =
  /\b(decreas(?:e|es|ed|ing)|reduc(?:e|es|ed|tion)|lower(?:ed)?|rarer|less common|less often|removed from|no longer drops?)\b/i;

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

export function sentenceAround(body: string, matchIndex: number, matchLength: number): string {
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

export function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
export function isWholeItemMention(
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
