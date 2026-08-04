import { useMemo, useState } from "react";
import type { MarketItem } from "../api";
import { formatGp, formatPct, formatAgo } from "../format";
import { type WatchEntry, toggleWatch } from "../watchlist";

type SortKey = "score" | "net_margin" | "roi_pct" | "liquidity" | "high";

const columns: { key: SortKey; label: string }[] = [
  { key: "score", label: "Score" },
  { key: "net_margin", label: "Net margin" },
  { key: "roi_pct", label: "ROI" },
  { key: "liquidity", label: "Liquidity/hr" },
  { key: "high", label: "Price" },
];

function iconUrl(icon: string): string {
  if (!icon) return "";
  return `https://oldschool.runescape.wiki/images/${encodeURIComponent(icon.replace(/ /g, "_"))}`;
}

export function MarketTable({
  items,
  watched,
  setWatched,
  onSelectItem,
}: {
  items: MarketItem[];
  watched: Record<number, WatchEntry>;
  setWatched: (next: Record<number, WatchEntry>) => void;
  onSelectItem: (item: MarketItem) => void;
}) {
  const [sortKey, setSortKey] = useState<SortKey>("score");
  const [sortDir, setSortDir] = useState<1 | -1>(-1);

  const sorted = useMemo(() => {
    const copy = [...items];
    copy.sort((a, b) => {
      const av = a[sortKey] ?? -Infinity;
      const bv = b[sortKey] ?? -Infinity;
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

  return (
    <div className="glass rounded-xl overflow-hidden">
      <div className="overflow-auto max-h-[70vh] 2xl:max-h-[78vh]">
        <table className="w-full text-sm 2xl:text-base text-left border-collapse">
          <thead className="sticky top-0 bg-[#0f1015]/95 backdrop-blur z-10">
            <tr className="border-b border-white/10 text-gray-400">
              <th className="px-3 py-2 font-medium w-8"></th>
              <th className="px-3 py-2 font-medium">Item</th>
              {columns.map((c) => (
                <th
                  key={c.key}
                  className="px-3 py-2 font-medium cursor-pointer select-none hover:text-white"
                  onClick={() => toggleSort(c.key)}
                >
                  {c.label} {sortKey === c.key ? (sortDir === 1 ? "▲" : "▼") : ""}
                </th>
              ))}
              <th className="px-3 py-2 font-medium">Limit</th>
              <th className="px-3 py-2 font-medium">Updated</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((item) => {
              const positive = (item.net_margin ?? 0) >= 0;
              const isWatched = !!watched[item.id];
              return (
                <tr
                  key={item.id}
                  className="border-b border-white/5 hover:bg-white/5 price-flash"
                >
                  <td className="px-3 py-2">
                    <button
                      onClick={() => setWatched(toggleWatch(watched, item.id))}
                      className={`text-base leading-none ${
                        isWatched ? "text-amber-400" : "text-gray-600 hover:text-gray-300"
                      }`}
                      title={isWatched ? "Remove from watchlist" : "Add to watchlist"}
                    >
                      ★
                    </button>
                  </td>
                  <td className="px-3 py-2 flex items-center gap-2 whitespace-nowrap">
                    {item.icon && (
                      <img src={iconUrl(item.icon)} alt="" className="w-5 h-5 object-contain" />
                    )}
                    <button
                      onClick={() => onSelectItem(item)}
                      className="text-gray-100 hover:text-white hover:underline text-left"
                    >
                      {item.name}
                    </button>
                  </td>
                  <td className={`px-3 py-2 font-mono ${positive ? "text-emerald-400" : "text-rose-400"}`}>
                    {formatGp(item.score)}
                  </td>
                  <td className={`px-3 py-2 font-mono ${positive ? "text-emerald-400" : "text-rose-400"}`}>
                    {formatGp(item.net_margin)}
                  </td>
                  <td className={`px-3 py-2 font-mono ${(item.roi_pct ?? 0) >= 0 ? "text-emerald-400" : "text-rose-400"}`}>
                    {formatPct(item.roi_pct)}
                  </td>
                  <td className="px-3 py-2 font-mono text-gray-300">{Math.round(item.liquidity)}</td>
                  <td className="px-3 py-2 font-mono text-gray-300">{formatGp(item.high)}</td>
                  <td className="px-3 py-2 font-mono text-gray-400">{item.buy_limit ?? "—"}</td>
                  <td className="px-3 py-2 text-gray-500 text-xs">{formatAgo(item.updated_at)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
