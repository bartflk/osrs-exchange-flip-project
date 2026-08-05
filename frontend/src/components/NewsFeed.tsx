import { useEffect, useState } from "preact/hooks";
import { fetchNews, type NewsEvent } from "../api";

function formatDate(dateStr: string): string {
  return new Date(`${dateStr}T00:00:00Z`).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

// DESIGN.md §6.4: Update News & Sentiment tab, official-news slice only for now. Reddit
// sentiment and Claude's item-linking ({item_name, claimed_impact, confidence}) aren't built
// yet -- Reddit needs a 2-4 week app pre-approval, Claude is blocked on Anthropic API billing
// (§14.8). This is the skeleton: fetch, store, display, in the shape the other two sources will
// slot into once they exist (chronological feed, source-tagged, newest first).
export function NewsFeed() {
  const [events, setEvents] = useState<NewsEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchNews()
      .then((res) => {
        if (!cancelled) setEvents(res.events);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "Failed to load news");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (loading) return <div className="text-sm text-gray-500 p-4">Loading news…</div>;
  if (error) return <div className="text-sm text-rose-400 p-4">{error}</div>;

  return (
    <div>
      <div className="glass rounded-xl p-4 mb-4">
        <p className="text-sm text-gray-300">
          Official OSRS patch notes, pulled daily from the game's own RSS feed.
        </p>
        <p className="text-xs text-gray-500 mt-1">
          Reddit sentiment and per-item impact tagging aren't wired in yet — Reddit needs a 2-4 week
          app approval, item-linking needs Claude (currently blocked on Anthropic API billing). See
          DESIGN.md §6.4 for the full plan.
        </p>
      </div>

      {events.length === 0 ? (
        <div className="glass rounded-xl p-10 text-center text-gray-400">
          No news fetched yet — the first poll runs within a minute of the backend starting.
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {events.map((e) => (
            <div key={e.id} className="glass rounded-xl p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    {e.link ? (
                      <a
                        href={e.link}
                        target="_blank"
                        rel="noreferrer"
                        className="text-gray-100 font-medium hover:text-white hover:underline"
                      >
                        {e.title}
                      </a>
                    ) : (
                      <span className="text-gray-100 font-medium">{e.title}</span>
                    )}
                    {e.tags && (
                      <span className="text-[10px] uppercase tracking-wide px-2 py-0.5 rounded-full bg-sky-500/15 text-sky-400 border border-sky-500/30">
                        {e.tags}
                      </span>
                    )}
                    <span className="text-[10px] uppercase tracking-wide px-2 py-0.5 rounded-full bg-white/5 text-gray-400 border border-white/10">
                      Official
                    </span>
                  </div>
                  <p className="text-sm text-gray-400 mt-1">{e.summary}</p>
                </div>
                <span className="text-xs text-gray-500 shrink-0 whitespace-nowrap">
                  {formatDate(e.eventDate)}
                </span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
