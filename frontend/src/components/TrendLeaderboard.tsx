import { useEffect, useState } from "preact/hooks";
import { fetchTrends, type TrendEntry, type TrendWindow, type MarketItem } from "../api";
import { formatGp } from "../format";
import { Chip } from "./ui";

// DESIGN.md §10 item 9 / §14.17: browsable ranked movers across several time windows, distinct
// from alerts.ts's crash/spike detector (event-triggered, fires once per crossing) -- this is
// checkable any time rather than waiting for a threshold to trip.
const WINDOWS: { key: TrendWindow; label: string }[] = [
  { key: "1h", label: "1h" },
  { key: "4h", label: "4h" },
  { key: "12h", label: "12h" },
  { key: "24h", label: "24h" },
  { key: "7d", label: "7d" },
  { key: "30d", label: "30d" },
];

function iconUrl(icon: string): string {
  if (!icon) return "";
  return `https://oldschool.runescape.wiki/images/${encodeURIComponent(icon.replace(/ /g, "_"))}`;
}

function Row({ entry, onClick }: { entry: TrendEntry; onClick: () => void }) {
  const positive = entry.changePct >= 0;
  return (
    <button
      onClick={onClick}
      className="w-full flex items-center justify-between gap-2 py-1.5 px-2 rounded-lg hover:bg-white/5 text-left transition-colors"
    >
      <div className="flex items-center gap-2 min-w-0">
        {entry.icon && (
          <img src={iconUrl(entry.icon)} alt="" className="w-4 h-4 object-contain shrink-0" />
        )}
        <span className="text-sm text-gray-200 truncate">{entry.name}</span>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        <span className="text-xs text-gray-500 font-mono">{formatGp(entry.toPrice)}</span>
        <span
          className={`text-xs font-mono w-16 text-right ${positive ? "text-emerald-400" : "text-rose-400"}`}
        >
          {positive ? "+" : ""}
          {(entry.changePct * 100).toFixed(1)}%
        </span>
      </div>
    </button>
  );
}

export function TrendLeaderboard({
  items,
  onSelectItem,
}: {
  items: MarketItem[];
  onSelectItem: (item: MarketItem) => void;
}) {
  const [timeWindow, setTimeWindow] = useState<TrendWindow>("24h");
  const [entries, setEntries] = useState<TrendEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetchTrends(timeWindow)
      .then((res) => !cancelled && setEntries(res.entries))
      .catch((err) => !cancelled && setError(err instanceof Error ? err.message : "Failed to load"))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [timeWindow]);

  function open(entry: TrendEntry) {
    const item = items.find((i) => i.id === entry.itemId);
    if (item) onSelectItem(item);
  }

  const gainers = entries.filter((e) => e.changePct > 0).slice(0, 8);
  const losers = entries
    .filter((e) => e.changePct < 0)
    .slice()
    .sort((a, b) => a.changePct - b.changePct)
    .slice(0, 8);

  return (
    <div className="glass rounded-xl p-4 mb-4">
      <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
        <h3 className="text-sm font-medium text-gray-200">Trending movers</h3>
        <div className="flex items-center gap-1.5">
          {WINDOWS.map((w) => (
            <Chip key={w.key} active={timeWindow === w.key} onClick={() => setTimeWindow(w.key)}>
              {w.label}
            </Chip>
          ))}
        </div>
      </div>

      {loading && <p className="text-xs text-gray-500 py-2">Loading…</p>}
      {error && <p className="text-xs text-rose-400 py-2">{error}</p>}
      {!loading && !error && entries.length === 0 && (
        <p className="text-xs text-gray-500 py-2">
          {timeWindow === "7d" || timeWindow === "30d"
            ? "Not enough local price history yet for this window, the daily rollup needs to run for that many days first."
            : "No qualifying movers right now."}
        </p>
      )}

      {entries.length > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6">
          <div>
            <div className="text-[10px] uppercase tracking-wide text-gray-500 mb-1">Gainers</div>
            {gainers.length === 0 ? (
              <p className="text-xs text-gray-600 py-1">None</p>
            ) : (
              gainers.map((e) => <Row key={e.itemId} entry={e} onClick={() => open(e)} />)
            )}
          </div>
          <div>
            <div className="text-[10px] uppercase tracking-wide text-gray-500 mb-1">Losers</div>
            {losers.length === 0 ? (
              <p className="text-xs text-gray-600 py-1">None</p>
            ) : (
              losers.map((e) => <Row key={e.itemId} entry={e} onClick={() => open(e)} />)
            )}
          </div>
        </div>
      )}
    </div>
  );
}
