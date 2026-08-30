import type { ComponentChildren } from "preact";
import { useEffect, useMemo, useState } from "preact/hooks";
import { fetchNews, type NewsEvent } from "../api";

function formatDate(dateStr: string): string {
  return new Date(`${dateStr}T00:00:00Z`).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

// DESIGN.md §6.4/§14.35/§14.39: official patch notes plus posts from the flipping subreddits, both
// landing in the same events table, source-tagged.
//
// Split into two sections rather than one chronological list. They are not the same kind of
// information and reading them interleaved was actively worse than reading either alone: an
// official patch note is a fact about the game that will move prices, while a Reddit post is one
// player's opinion that may itself BE the pump. Merging them by date implies a comparability that
// isn't there, and in practice the higher-volume source simply buried the other -- Reddit posts
// outnumber official ones roughly 3:1 even after r/2007scape was retired.
export function NewsFeed() {
  const [events, setEvents] = useState<NewsEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [subreddit, setSubreddit] = useState<string>("all");

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

  const official = useMemo(() => events.filter((e) => e.source === "official"), [events]);
  const reddit = useMemo(() => events.filter((e) => e.source === "reddit"), [events]);

  // Built from what actually arrived, not from a hardcoded list, so retiring or adding a feed in
  // redditFeed.ts needs no matching edit here.
  const subreddits = useMemo(() => {
    const set = new Set<string>();
    for (const e of reddit) if (e.tags) set.add(e.tags);
    return [...set].sort();
  }, [reddit]);

  const visibleReddit = useMemo(
    () => (subreddit === "all" ? reddit : reddit.filter((e) => e.tags === subreddit)),
    [reddit, subreddit],
  );

  if (loading) return <div className="text-sm text-gray-500 p-4">Loading news…</div>;
  if (error) return <div className="text-sm text-rose-400 p-4">{error}</div>;

  return (
    <div className="flex flex-col gap-6">
      <section>
        <SectionHeader
          title="Game news"
          count={official.length}
          note="Official OSRS patch notes and blog posts, polled daily. These are facts about the game, so a relevant one is a reason to expect a price move rather than a hint that others might."
        />
        <EventList events={official} empty="No official news fetched yet. The first poll runs within a minute of the backend starting." />
      </section>

      <section>
        <SectionHeader
          title="Reddit"
          count={visibleReddit.length}
          note="Flipping-focused subreddits, polled hourly. Read these as an ATTENTION signal, not a buy list: these subs are small enough that a 'buy X' post can be the pump itself, and by the time a move is posted it has usually already happened. The value is in a post landing on an item your alerts are already flagging."
          right={
            subreddits.length > 1 ? (
              <div className="flex gap-1">
                <FilterChip label="All" active={subreddit === "all"} onClick={() => setSubreddit("all")} />
                {subreddits.map((s) => (
                  <FilterChip
                    key={s}
                    label={s}
                    active={subreddit === s}
                    onClick={() => setSubreddit(s)}
                  />
                ))}
              </div>
            ) : null
          }
        />
        <EventList
          events={visibleReddit}
          empty={
            subreddit === "all"
              ? "No Reddit posts fetched yet. The first poll runs within a minute of the backend starting."
              : `No posts from ${subreddit} in the current window.`
          }
        />
      </section>

      <p className="text-xs text-gray-500">
        Both sections also draw markers on item price charts, so you can eyeball whether a patch or
        a busy Reddit day lined up with a price move. See DESIGN.md §14.35 for ingestion details.
      </p>
    </div>
  );
}

function SectionHeader({
  title,
  count,
  note,
  right,
}: {
  title: string;
  count: number;
  note: string;
  right?: ComponentChildren;
}) {
  return (
    <div className="mb-3">
      <div className="flex items-baseline justify-between gap-3 flex-wrap mb-1">
        <h3 className="text-sm font-medium text-gray-200">
          {title} <span className="text-xs text-gray-600 font-normal">({count})</span>
        </h3>
        {right}
      </div>
      <p className="text-xs text-gray-500 max-w-3xl">{note}</p>
    </div>
  );
}

function FilterChip({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`text-[10px] px-2 py-0.5 rounded-full border transition-colors ${
        active
          ? "bg-violet-500/20 text-violet-300 border-violet-500/40"
          : "bg-white/5 text-gray-400 border-white/10 hover:text-gray-200"
      }`}
    >
      {label}
    </button>
  );
}

function EventList({ events, empty }: { events: NewsEvent[]; empty: string }) {
  if (events.length === 0) {
    return (
      <div className="glass rounded-xl p-8 text-center text-sm text-gray-500">{empty}</div>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      {events.map((e) => (
        <div key={e.id} className="glass rounded-xl px-4 py-3">
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
                  <span
                    className={`text-[10px] uppercase tracking-wide px-2 py-0.5 rounded-full border ${
                      e.source === "reddit"
                        ? "bg-orange-500/15 text-orange-400 border-orange-500/30"
                        : "bg-sky-500/15 text-sky-400 border-sky-500/30"
                    }`}
                  >
                    {e.tags}
                  </span>
                )}
              </div>
              {e.summary && <p className="text-sm text-gray-400 mt-1">{e.summary}</p>}
            </div>
            <span className="text-xs text-gray-500 shrink-0 whitespace-nowrap">
              {formatDate(e.eventDate)}
            </span>
          </div>
        </div>
      ))}
    </div>
  );
}
