import { useEffect, useState } from "preact/hooks";
import { fetchItemMentions, type ItemMention } from "../api";

// DESIGN.md §10 item 57: real-time correlation between news/Reddit chatter and this specific
// item, via the local Ollama model's item-linking pass (eventItemLinking.ts). Renders nothing
// when there are no linked mentions -- most items won't have any, and an empty "no mentions" card
// on every single item modal would be pure noise, unlike the other panels here which always have
// something real to say.

function sourceLabel(source: string): string {
  return source === "official" ? "Official news" : source === "reddit" ? "r/2007scape" : source;
}

export function ItemMentions({ itemId }: { itemId: number }) {
  const [mentions, setMentions] = useState<ItemMention[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    setMentions(null);
    fetchItemMentions(itemId)
      .then((res) => !cancelled && setMentions(res.events))
      .catch(() => !cancelled && setMentions([]));
    return () => {
      cancelled = true;
    };
  }, [itemId]);

  if (!mentions || mentions.length === 0) return null;

  return (
    <div className="glass rounded-xl p-4 mb-4">
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs uppercase tracking-wide text-gray-500">Recent mentions</span>
        <span
          className="text-[10px] text-gray-600"
          title="Matched by the local model against the real item catalogue -- informal names (e.g. 'tbow') won't match, and this only covers what the model was confident enough to name explicitly"
        >
          item-linked news &amp; Reddit posts
        </span>
      </div>
      <ul className="space-y-1.5">
        {mentions.map((m) => (
          <li key={m.id} className="text-xs">
            <a
              href={m.link ?? undefined}
              target="_blank"
              rel="noreferrer"
              className={`text-gray-300 hover:text-white ${m.link ? "hover:underline" : "pointer-events-none"}`}
            >
              {m.title}
            </a>
            <span className="text-gray-600">
              {" "}
              — {sourceLabel(m.source)} · {m.eventDate}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
