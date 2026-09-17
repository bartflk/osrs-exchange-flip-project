import { getEventsNeedingBody, setEventBody } from "./db.js";

// The text of an official news post, fetched from the page the RSS item links to.
//
// news.ts deliberately stops at the feed, and for its purpose that was right: title, date, link
// and a one-line teaser are everything the News tab renders. Reading the news for market impact
// needs more than a teaser. Official summaries average 92 characters and say things like "We've
// got improvements to pet behaviours, Z-buffer fixes and more!", while the changelog on the
// linked page runs to tens of thousands of characters and is where items are actually named and
// their changes described. An item you hold cannot be found in a sentence that was never stored.
//
// So this fetches the article once and keeps it. Patch notes are immutable after publication, so
// a body is fetched exactly once per event and never revalidated -- the cheapest possible policy,
// and the correct one for an archive.

const USER_AGENT =
  "osrs-exchange-flip-project/1.0 (personal flipping tool; reads public OSRS news pages)";

// One page at a time, spaced. Same discipline as eventItemLinking.ts's model calls and
// slotProfiles.ts's refresh: a budget rather than a target, against someone else's server.
const REQUEST_SPACING_MS = 1500;
const FETCH_TIMEOUT_MS = 20_000;

// The whole archive is a few dozen posts and is fetched once, so a small per-pass budget still
// drains the backlog within a few poll cycles and leaves the site alone after that.
const DEFAULT_BUDGET = 6;

// Past this the page is not a news post -- a redirect to a login wall or an error shell. Storing
// it would put junk into the scanner's input, and the empty-string marker below is the honest
// record of "we looked and there was nothing to read".
const MIN_USEFUL_LENGTH = 400;

/**
 * Plain text from a Jagex news page.
 *
 * A regex strip rather than a parsed DOM. That is usually the wrong instinct, but the consumer
 * here is a keyword scanner that wants a flat run of prose, not a tree: there is no structure to
 * preserve, and the failure mode of a missed tag is a stray angle bracket in text nobody reads
 * directly, not a broken parse. It also keeps the backend free of an HTML-parsing dependency for
 * one page shape.
 *
 * Script and style contents are removed FIRST and as whole blocks, because their innards are not
 * markup -- left in, a page's inline JSON would land in the text and its string literals would be
 * scanned for item names as though Jagex had written them in a changelog.
 */
export function extractArticleText(html: string): string {
  return (
    html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<!--[\s\S]*?-->/g, " ")
      // Block-level tags become a full stop, not a space. The scanner works sentence by sentence,
      // and without this a bulleted changelog -- which is exactly what patch notes are -- collapses
      // into one enormous run-on "sentence" spanning every unrelated change in the update, so an
      // item in the first bullet would be read against wording from the last.
      .replace(/<\/(p|div|li|h[1-6]|tr|td|section|article|br)\s*>/gi, ". ")
      .replace(/<br\s*\/?>/gi, ". ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&quot;/g, '"')
      .replace(/&#39;|&apos;/g, "'")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      // Collapse the punctuation the block-tag rule above over-produces (". . . ." between nested
      // closing tags) back into single sentence breaks.
      .replace(/(\s*\.\s*){2,}/g, ". ")
      .replace(/\s+/g, " ")
      .trim()
  );
}

/** Thrown for a status that will never succeed, so the caller can stop asking. */
class PermanentlyGone extends Error {}

async function fetchArticle(link: string): Promise<string> {
  const res = await fetch(link, {
    headers: { "User-Agent": USER_AGENT },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) {
    // 4xx is the page's final answer; 5xx and network errors are this minute's answer. Fourteen
    // articles in the stored feed already 404 -- Jagex renames or retires slugs and the RSS entry
    // outlives the page -- so without this split the backfill would spend every pass, forever,
    // re-requesting the same fourteen dead URLs and never reaching anything new.
    if (res.status >= 400 && res.status < 500) {
      throw new PermanentlyGone(`news article gone: ${res.status}`);
    }
    throw new Error(`news article fetch failed: ${res.status}`);
  }
  return extractArticleText(await res.text());
}

export interface BodyBackfillResult {
  attempted: number;
  stored: number;
  /** Fetched but unusable, or permanently gone. Marked so, and never asked for again. */
  empty: number;
  /** Failed in a way that might not fail next time. Left for a later pass. */
  failed: number;
}

/**
 * Fill in missing article bodies, newest first.
 *
 * A page that comes back too short is stored as an empty string rather than left NULL. The
 * distinction matters for a backfill that runs forever on a timer: NULL means "not looked at",
 * empty means "looked at, nothing there", and conflating them would send the poller back to the
 * same dead link every few minutes for the life of the install. A page that throws IS left NULL,
 * because a timeout or a 503 is a reason to try again later.
 */
export async function backfillEventBodies(budget = DEFAULT_BUDGET): Promise<BodyBackfillResult> {
  const pending = getEventsNeedingBody(budget);
  if (pending.length === 0) return { attempted: 0, stored: 0, empty: 0, failed: 0 };

  let stored = 0;
  let empty = 0;
  let failed = 0;

  for (const event of pending) {
    try {
      const text = await fetchArticle(event.link!);
      if (text.length >= MIN_USEFUL_LENGTH) {
        setEventBody(event.id, text);
        stored++;
      } else {
        setEventBody(event.id, "");
        empty++;
      }
    } catch (err) {
      if (err instanceof PermanentlyGone) {
        // Recorded as looked-at-and-empty, the same terminal state as a page that came back too
        // short, because that is what it is: there is nothing at this URL and there never will be.
        setEventBody(event.id, "");
        empty++;
      } else {
        // Left NULL on purpose, so the next pass retries it -- same additive stance as the Reddit
        // collector and the linking job: one bad page must not abort the run or poison the row.
        failed++;
      }
    }
    await new Promise((r) => setTimeout(r, REQUEST_SPACING_MS));
  }

  return { attempted: pending.length, stored, empty, failed };
}
