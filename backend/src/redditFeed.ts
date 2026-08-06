// DESIGN.md §14.35: Reddit sentiment via public RSS/Atom feeds -- no OAuth, no app pre-approval,
// no PRAW dependency (the Python sidecar's original plan, still gated on Reddit's approval
// process). Confirmed live: `https://www.reddit.com/r/2007scape/top/.rss?t=day&limit=15` returns
// a real Atom feed with no auth, 200 OK. Community discussion, not official news, so these land
// in the same `events` table tagged `source: "reddit"` -- same shape, different provenance.
const SUBREDDITS = ["2007scape", "runescape"];
const USER_AGENT = "osrs-flip-assistant/1.0 (local single-user GE flip tool)";

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
    headers: { "User-Agent": USER_AGENT },
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
  for (const r of results) {
    if (r.status === "fulfilled") posts.push(...r.value);
    // A single subreddit fetch failing (rate limit, transient error) shouldn't drop the others --
    // same "additive, not load-bearing" principle as the sidecar's Reddit/Discord collectors.
  }
  return posts;
}
