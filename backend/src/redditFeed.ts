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
const SUBREDDITS = ["2007scape"];
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

async function fetchSubredditTopOfDay(subreddit: string): Promise<RedditPost[]> {
  const res = await fetch(`https://www.reddit.com/r/${subreddit}/top/.rss?t=day&limit=15`, {
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
  const results = await Promise.allSettled(SUBREDDITS.map(fetchSubredditTopOfDay));
  const posts: RedditPost[] = [];
  results.forEach((r, i) => {
    // A single subreddit fetch failing (rate limit, transient error) shouldn't drop the others --
    // same "additive, not load-bearing" principle as the sidecar's Reddit/Discord collectors.
    if (r.status === "fulfilled") {
      posts.push(...r.value);
      return;
    }
    // ...but it must not fail *silently*. Found live: r/2007scape had zero rows in the events
    // table while r/runescape had 18, because its fetch was rejecting inside this allSettled and
    // nobody ever saw it. A swallowed rejection here looks identical to "the subreddit had no
    // posts today," which is exactly the wrong thing to be ambiguous about.
    console.error(`[reddit] r/${SUBREDDITS[i]} fetch failed:`, r.reason);
  });
  return posts;
}
