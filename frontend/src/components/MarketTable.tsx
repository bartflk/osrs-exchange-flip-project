import { useMemo, useState } from "preact/hooks";
import type { MarketItem } from "../api";
import { formatGp, formatPct, formatAgo } from "../format";
import { type WatchEntry, toggleWatch } from "../watchlist";
import { type BlockEntry, toggleBlock } from "../blocklist";
import { Badge, Button, EmptyState } from "./ui";

type SortKey =
  | "score"
  | "low"
  | "high"
  | "net_margin"
  | "tax"
  | "roi_pct"
  | "liquidity"
  | "buy_limit"
  | "potential_profit";

// Potential profit = net margin over a full buy-limit cycle (the most you could pocket
// flipping this item to its GE limit right now) -- not tracked server-side, since it's a
// pure function of fields the item already carries, so it's computed here rather than adding
// a redundant column to the backend's scoring query.
function potentialProfit(item: MarketItem): number | null {
  if (item.net_margin == null || item.buy_limit == null) return null;
  return item.net_margin * item.buy_limit;
}

const columns: { key: SortKey; label: string; align?: "right"; title?: string }[] = [
  { key: "low", label: "Buy", align: "right" },
  { key: "high", label: "Sell", align: "right" },
  { key: "net_margin", label: "Margin", align: "right" },
  { key: "tax", label: "Tax", align: "right" },
  { key: "roi_pct", label: "ROI", align: "right" },
  { key: "liquidity", label: "Liquidity/hr", align: "right" },
  { key: "buy_limit", label: "Limit", align: "right" },
  {
    key: "potential_profit",
    label: "Pot. profit",
    align: "right",
    title:
      "Net margin × GE buy limit — the max you could pocket flipping this item to its limit right now",
  },
  {
    key: "score",
    label: "Score",
    align: "right",
    title: "This app's overall ranking (blends margin, ROI and liquidity)",
  },
];

function iconUrl(icon: string): string {
  if (!icon) return "";
  return `https://oldschool.runescape.wiki/images/${encodeURIComponent(icon.replace(/ /g, "_"))}`;
}

function SortIcon({ active, dir }: { active: boolean; dir: 1 | -1 }) {
  if (!active) return <span className="inline-block w-3 text-gray-700">↕</span>;
  return <span className="inline-block w-3 text-sky-400">{dir === 1 ? "↑" : "↓"}</span>;
}

export function MarketTable({
  items,
  watched,
  setWatched,
  blocked,
  setBlocked,
  onSelectItem,
  hasActiveFilters,
  onClearFilters,
}: {
  items: MarketItem[];
  watched: Record<number, WatchEntry>;
  setWatched: (next: Record<number, WatchEntry>) => void;
  blocked: Record<number, BlockEntry>;
  setBlocked: (next: Record<number, BlockEntry>) => void;
  onSelectItem: (item: MarketItem) => void;
  hasActiveFilters?: boolean;
  onClearFilters?: () => void;
}) {
  const [sortKey, setSortKey] = useState<SortKey>("score");
  const [sortDir, setSortDir] = useState<1 | -1>(-1);

  const sorted = useMemo(() => {
    const copy = [...items];
    copy.sort((a, b) => {
      const av =
        sortKey === "potential_profit"
          ? (potentialProfit(a) ?? -Infinity)
          : (a[sortKey] ?? -Infinity);
      const bv =
        sortKey === "potential_profit"
          ? (potentialProfit(b) ?? -Infinity)
          : (b[sortKey] ?? -Infinity);
      return (av - bv) * sortDir;
    });
    return copy;
  }, [items, sortKey, sortDir]);

  function toggleSort(key: SortKey) {
    if (key === sortKey) {
      setSortDir((d) => (d === 1 ? -1 : 1));
    } else {
      setSortKey(key);
      setSortDir(-1);
    }
  }

  if (items.length === 0) {
    return (
      <div className="glass rounded-xl">
        <EmptyState
          icon="🔍"
          title="No items match these filters"
          hint="Try widening the price range, lowering min liquidity, or clearing filters."
        />
        {hasActiveFilters && onClearFilters && (
          <div className="flex justify-center pb-6">
            <Button variant="secondary" size="sm" onClick={onClearFilters}>
              Clear filters
            </Button>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="glass rounded-xl overflow-hidden">
      <div className="overflow-auto max-h-[70vh] 2xl:max-h-[78vh]">
        <table className="w-full text-sm 2xl:text-base text-left border-collapse">
          <thead className="sticky top-0 bg-[#0f1015]/95 backdrop-blur z-10">
            <tr className="border-b border-white/10 text-gray-400">
              <th className="px-3 py-2.5 font-medium w-8"></th>
              <th className="px-3 py-2.5 font-medium w-8"></th>
              <th className="px-3 py-2.5 font-medium">Item</th>
              {columns.map((c) => (
                <th
                  key={c.key}
                  title={c.title}
                  className={`px-3 py-2.5 font-medium cursor-pointer select-none hover:text-white transition-colors ${
                    c.align === "right" ? "text-right" : ""
                  }`}
                  onClick={() => toggleSort(c.key)}
                >
                  <span className="inline-flex items-center gap-1">
                    {c.label} <SortIcon active={sortKey === c.key} dir={sortDir} />
                  </span>
                </th>
              ))}
              <th className="px-3 py-2.5 font-medium">Updated</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((item, idx) => {
              const positive = (item.net_margin ?? 0) >= 0;
              const isWatched = !!watched[item.id];
              const isBlocked = !!blocked[item.id];
              const potProfit = potentialProfit(item);
              return (
                <tr
                  key={item.id}
                  className={`border-b border-white/5 hover:bg-white/[0.06] price-flash transition-colors ${
                    idx % 2 === 1 ? "bg-white/[0.015]" : ""
                  }`}
                >
                  <td className="px-3 py-2">
                    <button
                      onClick={() => setWatched(toggleWatch(watched, item.id))}
                      className={`text-base leading-none transition-colors ${
                        isWatched ? "text-amber-400" : "text-gray-600 hover:text-gray-300"
                      }`}
                      title={isWatched ? "Remove from watchlist" : "Add to watchlist"}
                    >
                      ★
                    </button>
                  </td>
                  <td className="px-3 py-2">
                    <button
                      onClick={() => setBlocked(toggleBlock(blocked, item))}
                      className={`text-base leading-none transition-colors ${
                        isBlocked ? "text-rose-400" : "text-gray-600 hover:text-gray-300"
                      }`}
                      title={isBlocked ? "Remove from blocklist" : "Never recommend this item"}
                    >
                      🚫
                    </button>
                  </td>
                  <td className="px-3 py-2">
                    <button
                      onClick={() => onSelectItem(item)}
                      className="flex items-center gap-2 whitespace-nowrap text-gray-100 hover:text-white group text-left"
                    >
                      {item.icon && (
                        <img
                          src={iconUrl(item.icon)}
                          alt=""
                          className="w-5 h-5 object-contain shrink-0"
                        />
                      )}
                      <span className="group-hover:underline">{item.name}</span>
                      {item.members === 1 && <Badge tone="info">P2P</Badge>}
                    </button>
                  </td>
                  <td className="px-3 py-2 font-mono text-rose-300 text-right">
                    {formatGp(item.low)}
                  </td>
                  <td className="px-3 py-2 font-mono text-emerald-300 text-right">
                    {formatGp(item.high)}
                  </td>
                  <td
                    className={`px-3 py-2 font-mono text-right ${positive ? "text-emerald-400" : "text-rose-400"}`}
                  >
                    {formatGp(item.net_margin)}
                  </td>
                  <td className="px-3 py-2 font-mono text-gray-500 text-right">
                    {item.tax ? `-${formatGp(item.tax)}` : "Free"}
                  </td>
                  <td
                    className={`px-3 py-2 font-mono text-right ${(item.roi_pct ?? 0) >= 0 ? "text-emerald-400" : "text-rose-400"}`}
                  >
                    {formatPct(item.roi_pct)}
                  </td>
                  <td className="px-3 py-2 font-mono text-gray-300 text-right">
                    {Math.round(item.liquidity).toLocaleString()}
                  </td>
                  <td className="px-3 py-2 font-mono text-gray-400 text-right">
                    {item.buy_limit != null ? item.buy_limit.toLocaleString() : "—"}
                  </td>
                  <td
                    className={`px-3 py-2 font-mono text-right ${potProfit == null ? "text-gray-600" : potProfit > 0 ? "text-emerald-400" : "text-rose-400"}`}
                  >
                    {potProfit != null && potProfit > 0 ? formatGp(potProfit) : "—"}
                  </td>
                  <td
                    className={`px-3 py-2 font-mono text-right ${positive ? "text-emerald-400" : "text-rose-400"}`}
                  >
                    {formatGp(item.score)}
                  </td>
                  <td className="px-3 py-2 text-gray-500 text-xs whitespace-nowrap">
                    {formatAgo(item.updated_at)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
