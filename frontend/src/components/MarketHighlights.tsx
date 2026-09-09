import { useEffect, useState } from "preact/hooks";
import {
  fetchHighlights,
  fetchItems,
  type HighlightEntry,
  type HighlightList,
  type HighlightWindow,
  type MarketItem,
} from "../api";
import { formatGp } from "../format";
import { Chip } from "./ui";

// Market Highlights: nine curated leaderboards under the Market table, replacing the old
// Trending movers / Sector indices / Substitution flags stack. The table above answers "what
// should I flip given these filters"; this answers "what is the market doing right now" for
// someone who has not decided what to look at yet, which is the reason it sits below rather
// than competing with the table for attention. All ranking happens server-side over the whole
// tracked universe (backend highlights.ts), not over the table's filtered top 300.

const PREVIEW_ROWS = 8;

// Day / week / month. The gainers and losers cards are the only ones this touches -- the rest of
// the panel reads the current order book, where a window has no meaning -- so the control is
// labelled as a movers window rather than sitting over the grid as if it filtered everything.
const WINDOWS: { key: HighlightWindow; label: string }[] = [
  { key: "1d", label: "1d" },
  { key: "7d", label: "7d" },
  { key: "30d", label: "30d" },
];

// Whole-market turnover runs into the trillions, which formatGp (billions at the top) would
// render as "4921.00b". Only this one number is that large, so it gets a local formatter rather
// than a new tier on the shared one.
function formatTurnover(value: number): string {
  if (value >= 1e12) return `${(value / 1e12).toFixed(2)}t`;
  return formatGp(value);
}

function iconUrl(icon: string): string {
  if (!icon) return "";
  return `https://oldschool.runescape.wiki/images/${encodeURIComponent(icon.replace(/ /g, "_"))}`;
}

function Row({
  entry,
  metric,
  timeWindow,
  onClick,
}: {
  entry: HighlightEntry;
  metric: HighlightList["metric"];
  timeWindow: HighlightWindow;
  onClick: () => void;
}) {
  const signed = metric === "change";
  const positive = (entry.value ?? 0) >= 0;
  const valueClass = signed
    ? positive
      ? "text-emerald-400"
      : "text-rose-400"
    : "text-emerald-400";

  return (
    <button
      onClick={onClick}
      className="w-full flex items-center justify-between gap-2 py-1 px-1.5 rounded-lg hover:bg-white/5 text-left transition-colors"
    >
      <div className="flex items-center gap-2 min-w-0">
        {entry.icon && (
          <img src={iconUrl(entry.icon)} alt="" className="w-4 h-4 object-contain shrink-0" />
        )}
        <span className="text-sm text-gray-200 truncate">{entry.name}</span>
      </div>
      <div className="flex items-center gap-3 shrink-0">
        <span className="text-xs text-gray-500 font-mono">{formatGp(entry.price)}</span>
        {entry.value != null && (
          <span
            className={`text-xs font-mono w-20 text-right ${valueClass}`}
            title={
              entry.changePct != null
                ? `${(entry.changePct * 100).toFixed(1)}% over ${timeWindow}`
                : undefined
            }
          >
            {signed && positive ? "+" : ""}
            {formatGp(entry.value)}
          </span>
        )}
      </div>
    </button>
  );
}

function Card({
  list,
  timeWindow,
  onOpen,
}: {
  list: HighlightList;
  timeWindow: HighlightWindow;
  onOpen: (entry: HighlightEntry) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const shown = expanded ? list.entries : list.entries.slice(0, PREVIEW_ROWS);
  const canExpand = list.entries.length > PREVIEW_ROWS;

  return (
    <div className="glass rounded-xl p-3.5">
      <div className="flex items-baseline justify-between gap-2 mb-2">
        <h4 className="text-sm font-medium text-gray-200" title={list.hint}>
          {list.title}
        </h4>
        {canExpand && (
          <button
            onClick={() => setExpanded((v) => !v)}
            className="text-[11px] text-gray-500 hover:text-gray-200 transition-colors"
          >
            {expanded ? "show less" : `view all (${list.entries.length})`}
          </button>
        )}
      </div>
      <div className="flex items-center justify-between gap-2 px-1.5 pb-1 text-[10px] uppercase tracking-wide text-gray-600">
        <span>Item</span>
        <span className="flex items-center gap-3">
          <span>Price</span>
          {list.valueLabel && <span className="w-20 text-right">{list.valueLabel}</span>}
        </span>
      </div>
      {shown.length === 0 ? (
        <p className="text-xs text-gray-600 py-2 px-1.5">{list.hint}</p>
      ) : (
        shown.map((e) => (
          <Row
            key={e.itemId}
            entry={e}
            metric={list.metric}
            timeWindow={timeWindow}
            onClick={() => onOpen(e)}
          />
        ))
      )}
    </div>
  );
}

export function MarketHighlights({
  items,
  onSelectItem,
}: {
  items: MarketItem[];
  onSelectItem: (item: MarketItem) => void;
}) {
  const [timeWindow, setTimeWindow] = useState<HighlightWindow>("1d");
  const [lists, setLists] = useState<HighlightList[]>([]);
  const [tradedValue, setTradedValue] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchHighlights(timeWindow)
      .then((res) => {
        if (cancelled) return;
        setLists(res.lists);
        setTradedValue(res.tradedValue24h);
      })
      .catch((err) => !cancelled && setError(err instanceof Error ? err.message : "Failed to load"))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [timeWindow]);

  // A highlighted item is often outside whatever the Market table is currently filtered to, so
  // fall back to fetching it by id rather than silently doing nothing on click (same pattern the
  // crash/spike alerts use).
  function open(entry: HighlightEntry) {
    const local = items.find((i) => i.id === entry.itemId);
    if (local) {
      onSelectItem(local);
      return;
    }
    fetchItems({ ids: [entry.itemId] })
      .then((res) => res.items[0] && onSelectItem(res.items[0]))
      .catch(() => {});
  }

  return (
    <div>
      <div className="mb-3 flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h3 className="text-base font-medium text-gray-100">Market highlights</h3>
          <p className="text-xs text-gray-500">
            The whole tracked market at a glance, ignoring the filters above.
            {tradedValue != null && (
              <>
                {" "}
                Rough 24h turnover:{" "}
                <span className="text-gray-300 font-mono">{formatTurnover(tradedValue)}</span>.
              </>
            )}
          </p>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="text-[10px] uppercase tracking-wide text-gray-500">Movers window</span>
          {WINDOWS.map((w) => (
            <Chip key={w.key} active={timeWindow === w.key} onClick={() => setTimeWindow(w.key)}>
              {w.label}
            </Chip>
          ))}
        </div>
      </div>

      {loading && <p className="text-xs text-gray-500 py-2">Loading highlights…</p>}
      {error && <p className="text-xs text-rose-400 py-2">{error}</p>}

      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
        {lists.map((list) => (
          <Card key={list.key} list={list} timeWindow={timeWindow} onOpen={open} />
        ))}
      </div>
    </div>
  );
}
