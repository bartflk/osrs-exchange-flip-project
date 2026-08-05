// DESIGN.md §6.4: official patch notes / news feed -- the first of three sources planned for the
// Update News & Sentiment tab. Reddit sentiment (PRAW) is still gated on Reddit's app
// pre-approval and LLM item-linking isn't built yet (§14.8), so this is deliberately just the
// official-news skeleton: fetch, parse, store, display -- no classification/linking logic yet.
// The RSS feed has no stable per-item id, so dedup happens by (title, event_date) in
// warehouse.ts rather than an upsert key.

const FEED_URL = "https://secure.runescape.com/m=news/latest_news.rss?oldschool=true";

export interface OfficialNewsItem {
  title: string;
  link: string;
  pubDate: string; // RFC 822, as given by the feed
  description: string;
  category: string;
}

function extractTag(block: string, tag: string): string {
  const m = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`));
  if (!m) return "";
  let text = m[1];
  const cdata = text.match(/<!\[CDATA\[([\s\S]*?)\]\]>/);
  if (cdata) text = cdata[1];
  return decodeEntities(text.trim());
}

function decodeEntities(s: string): string {
  return s
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

export async function fetchOfficialNews(): Promise<OfficialNewsItem[]> {
  const res = await fetch(FEED_URL);
  if (!res.ok) throw new Error(`Failed to fetch OSRS news RSS: ${res.status}`);
  const xml = await res.text();

  const items: OfficialNewsItem[] = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/g;
  let match: RegExpExecArray | null;
  while ((match = itemRegex.exec(xml))) {
    const block = match[1];
    const title = extractTag(block, "title");
    if (!title) continue;
    items.push({
      title,
      link: extractTag(block, "link"),
      pubDate: extractTag(block, "pubDate"),
      description: extractTag(block, "description"),
      category: extractTag(block, "category"),
    });
  }
  return items;
}
