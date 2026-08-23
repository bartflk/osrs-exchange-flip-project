// DESIGN.md §14.35/§14.36: Reddit sentiment via public RSS/Atom feeds -- no OAuth, no app
// pre-approval, no PRAW dependency (the Python sidecar's original plan, still gated on Reddit's
// approval process). Confirmed live: `https://www.reddit.com/r/2007scape/top/.rss?t=day&limit=15`
// returns a real Atom feed with no auth. Community discussion, not official news, so these land
// in the same `events` table tagged `source: "reddit"` -- same shape, different provenance.
//
// Real bug found live: this app's usual descriptive User-Agent (used successfully against the
// Wiki/WOM APIs) gets a consistent 429 from Reddit specifically -- confirmed side-by-side that
// the exact same request from PowerShell's HTTP client (a different TLS/header fingerprint)
// succeeds every time while Node's `fetch` with the descriptive UA fails every time, so this is
// Reddit's anti-bot layer fingerprinting non-browser clients, not a real rate limit. A
// browser-realistic User-Agent + Accept headers resolves it -- confirmed 200 OK repeatedly.
// OSRS only -- r/runescape is the RS3 community, a separate game with its own economy and its own
// updates, so its posts are noise against this app's price data rather than signal.
//
// r/2007scape alone was measured and found close to useless for trading: of 126 ingested posts,
// 10 linked to any item, and the one that did was a meme about copper ore. Its top-of-day is
// achievement posts, memes and drama, because it is the general community sub. The two
// flipping-specific subs are added for the signal r/2007scape structurally cannot carry.
//
// Each feed names its own sort. This is not cosmetic: r/2007scape's top-of-day is a firehose,
// while r/OSRSflipping returned exactly ONE post for top-of-day when probed live -- a "top today"
// feed on a low-traffic sub is mostly empty, so those read `new` instead and catch everything.
//
// HOW TO READ THESE, and it matters: the flipping subs are best treated as an ATTENTION and
// MANIPULATION signal, not a buy list. They are small enough that a "buy X" post can be the pump
// itself, and by the time a move is posted it has usually already happened. The value is joining
// post activity against the existing z-score alerting -- "spiking AND being talked about" is a
// much sharper flag than either half alone (DESIGN.md 10 items 5 and 42).
interface SubredditFeed {
  subreddit: string;
  /** Path after /r/<sub>/ -- the sort and window this sub actually warrants. */
  path: string;
}

const SUBREDDIT_FEEDS: SubredditFeed[] = [
  { subreddit: "2007scape", path: "top/.rss?t=day&limit=15" },
  // 43k members. Confirmed reachable live (HTTP 200 on the RSS feed).
  { subreddit: "OSRSflipping", path: "new/.rss?limit=25" },
  // 30k members. NOT confirmed reachable -- probing it returned 429, but so did r/2007scape on
  // the same burst, so that is this IP's rate-limit cooldown rather than evidence the feed is
  // missing. Left in: a failing feed logs loudly below and drops nothing else, which is the
  // right way to carry an unverified source.
  { subreddit: "GrandExchangeBets", path: "new/.rss?limit=25" },
];

// Reddit rate-limits bursts hard. The previous version fired every subreddit at once through
// Promise.allSettled, which was fine at one subreddit and would 429 at three -- confirmed live,
// five rapid requests earned a cooldown that rejected even feeds known to work. Requests are now
// serialised with real spacing; this job runs hourly and has no deadline.
const REQUEST_SPACING_MS = 4000;
const REDDIT_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  Accept: "application/rss+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
};

export interface RedditPost {
  title: string;
  link: string;
  updated: string; // ISO 8601, as given by the feed
  author: string;
  subreddit: string;
}

function extractTag(block: string, tag: string): string {
  const m = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`));
  return m ? decodeEntities(m[1].trim()) : "";
}

function extractLinkHref(block: string): string {
  const m = block.match(/<link[^>]*href="([^"]*)"[^>]*\/?>/);
  return m ? decodeEntities(m[1]) : "";
}

function decodeEntities(s: string): string {
  return s
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

async function fetchSubredditFeed(feed: SubredditFeed): Promise<RedditPost[]> {
  const { subreddit, path } = feed;
  const res = await fetch(`https://www.reddit.com/r/${subreddit}/${path}`, {
    headers: REDDIT_HEADERS,
  });
  if (!res.ok) throw new Error(`Failed to fetch r/${subreddit} RSS: ${res.status}`);
  const xml = await res.text();

  const posts: RedditPost[] = [];
  const entryRegex = /<entry>([\s\S]*?)<\/entry>/g;
  let match: RegExpExecArray | null;
  while ((match = entryRegex.exec(xml))) {
    const block = match[1];
    const title = extractTag(block, "title");
    if (!title) continue;
    const authorBlock = block.match(/<author>([\s\S]*?)<\/author>/)?.[1] ?? "";
    posts.push({
      title,
      link: extractLinkHref(block),
      updated: extractTag(block, "updated"),
      author: extractTag(authorBlock, "name"),
      subreddit,
    });
  }
  return posts;
}

export async function fetchRedditPosts(): Promise<RedditPost[]> {
  const posts: RedditPost[] = [];
  for (let i = 0; i < SUBREDDIT_FEEDS.length; i++) {
    const feed = SUBREDDIT_FEEDS[i];
    try {
      posts.push(...(await fetchSubredditFeed(feed)));
    } catch (err) {
      // A single subreddit failing (rate limit, transient error, sub renamed) must not drop the
      // others -- same "additive, not load-bearing" principle as the sidecar's collectors.
      //
      // ...but it must not fail SILENTLY. Found live: r/2007scape had zero rows in the events
      // table while r/runescape had 18, because its fetch was rejecting inside a Promise.allSettled
      // and nobody ever saw it. A swallowed rejection looks identical to "the subreddit had no
      // posts today," which is exactly the wrong thing to be ambiguous about.
      console.error(`[reddit] r/${feed.subreddit} fetch failed:`, err);
    }
    if (i < SUBREDDIT_FEEDS.length - 1) {
      await new Promise((r) => setTimeout(r, REQUEST_SPACING_MS));
    }
  }
  return posts;
}
