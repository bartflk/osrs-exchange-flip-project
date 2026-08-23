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

// DESIGN.md §6.4/§14.35/§14.39: official patch notes + Reddit top-of-day posts (r/2007scape only
// -- RS3's r/runescape was removed as irrelevant), both landing in the same events table,
// source-tagged. LLM item-linking
// ({item_name, claimed_impact, confidence}) isn't built yet -- this is titles/links/dates only,
// chronological, newest first.
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
          Official OSRS patch notes (daily) and top-of-day posts from r/2007scape (hourly):
          titles, links, and post dates only, no comments or per-item impact tagging yet.
        </p>
        <p className="text-xs text-gray-500 mt-1">
          These same events show as markers on item price charts, so you can eyeball whether a
          patch or a busy Reddit day lined up with a price move. See DESIGN.md §14.35 for the
          Reddit ingestion details.
        </p>
      </div>

      {events.length === 0 ? (
        <div className="glass rounded-xl p-10 text-center text-gray-400">
          No news fetched yet, the first poll runs within a minute of the backend starting.
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
                    <span
                      className={`text-[10px] uppercase tracking-wide px-2 py-0.5 rounded-full border ${
                        e.source === "reddit"
                          ? "bg-orange-500/15 text-orange-400 border-orange-500/30"
                          : "bg-white/5 text-gray-400 border-white/10"
                      }`}
                    >
                      {e.source === "reddit" ? "Reddit" : "Official"}
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
