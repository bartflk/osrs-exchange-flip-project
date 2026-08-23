import { useEffect, useState } from "preact/hooks";
import { fetchNews } from "../api";
import { StatCard } from "./ui";

// DESIGN.md §10 item 3: update-cycle calendar awareness. OSRS updates release weekly
// (Wednesdays ~11:30 UTC) -- a "days since/until update" indicator contextualizes whether
// current price action is update-driven noise or a stable trend. Genuinely free: the official
// news feed is already polled daily (news.ts) and stored in the events table, so "last update"
// is the most recent real official-news entry, not an assumed fixed cadence -- accounts for
// skipped/delayed weeks rather than just computing "last Wednesday" blindly.
const UPDATE_WEEKDAY_UTC = 3; // Wednesday (0 = Sunday)
const UPDATE_HOUR_UTC = 11;
const UPDATE_MINUTE_UTC = 30;

function nextUpdateDate(from: Date): Date {
  const next = new Date(
    Date.UTC(
      from.getUTCFullYear(),
      from.getUTCMonth(),
      from.getUTCDate(),
      UPDATE_HOUR_UTC,
      UPDATE_MINUTE_UTC,
    ),
  );
  while (next.getUTCDay() !== UPDATE_WEEKDAY_UTC || next.getTime() <= from.getTime()) {
    next.setUTCDate(next.getUTCDate() + 1);
  }
  return next;
}

function formatDaysAgo(days: number): string {
  if (days <= 0) return "today";
  if (days === 1) return "1 day ago";
  return `${days} days ago`;
}

function formatDaysUntil(ms: number): string {
  const hours = Math.round(ms / (60 * 60 * 1000));
  if (hours <= 0) return "now";
  if (hours < 24) return `~${hours}h`;
  const days = Math.round(hours / 24);
  return `~${days}d`;
}

export function UpdateCycleBadge() {
  const [lastUpdateDate, setLastUpdateDate] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchNews()
      .then((res) => !cancelled && setLastUpdateDate(res.events[0]?.eventDate ?? null))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const now = new Date();
  const next = nextUpdateDate(now);
  const untilLabel = formatDaysUntil(next.getTime() - now.getTime());

  const sinceLabel = lastUpdateDate
    ? formatDaysAgo(
        Math.floor((now.getTime() - Date.parse(lastUpdateDate + "T00:00:00Z")) / 86400000),
      )
    : "-";

  return (
    <StatCard
      label="Update cycle"
      value={untilLabel}
      hint={`Last patch ${sinceLabel} · weekly, Wed ~11:30 UTC`}
    />
  );
}
