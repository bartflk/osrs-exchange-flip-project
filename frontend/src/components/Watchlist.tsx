import type { MarketItem } from "../api";
import { formatGp, formatAgo } from "../format";
import { type WatchEntry, toggleWatch, updateWatchAlert } from "../watchlist";

function iconUrl(icon: string): string {
  if (!icon) return "";
  return `https://oldschool.runescape.wiki/images/${encodeURIComponent(icon.replace(/ /g, "_"))}`;
}

export function Watchlist({
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
  const watchedIds = Object.keys(watched).map(Number);
  const rows = watchedIds
    .map((id) => items.find((i) => i.id === id))
    .filter((i): i is MarketItem => !!i);

  if (watchedIds.length === 0) {
    return (
      <div className="glass rounded-xl p-10 text-center text-gray-400">
        <p className="text-lg text-gray-200 mb-1">Nothing pinned yet</p>
        <p className="text-sm">
          Click the star next to an item in the Market tab to add it here and set price alerts.
        </p>
      </div>
    );
  }

  return (
    <div className="glass rounded-xl overflow-hidden">
      <table className="w-full text-sm 2xl:text-base text-left border-collapse">
        <thead>
          <tr className="border-b border-white/10 text-gray-400">
            <th className="px-3 py-2 font-medium">Item</th>
            <th className="px-3 py-2 font-medium">Price</th>
            <th className="px-3 py-2 font-medium">Alert above</th>
            <th className="px-3 py-2 font-medium">Alert below</th>
            <th className="px-3 py-2 font-medium">Updated</th>
            <th className="px-3 py-2 font-medium"></th>
          </tr>
        </thead>
        <tbody>
          {rows.map((item) => {
            const entry = watched[item.id];
            const aboveTriggered = entry.alertAbove != null && (item.high ?? 0) >= entry.alertAbove;
            const belowTriggered = entry.alertBelow != null && (item.low ?? Infinity) <= entry.alertBelow;
            return (
              <tr key={item.id} className="border-b border-white/5 hover:bg-white/5">
                <td className="px-3 py-2 flex items-center gap-2 whitespace-nowrap">
                  {item.icon && <img src={iconUrl(item.icon)} alt="" className="w-5 h-5 object-contain" />}
                  <button onClick={() => onSelectItem(item)} className="text-gray-100 hover:text-white hover:underline">
                    {item.name}
                  </button>
                </td>
                <td className="px-3 py-2 font-mono text-gray-300">{formatGp(item.high)}</td>
                <td className="px-3 py-2">
                  <input
                    type="number"
                    defaultValue={entry.alertAbove ?? ""}
                    placeholder="—"
                    onBlur={(e) =>
                      setWatched(
                        updateWatchAlert(watched, item.id, {
                          alertAbove: e.target.value ? Number(e.target.value) : null,
                        })
                      )
                    }
                    className={`glass rounded-lg px-2 py-1 text-sm w-28 outline-none ${
                      aboveTriggered ? "text-emerald-400 border-emerald-500/40" : "text-gray-200"
                    }`}
                  />
                </td>
                <td className="px-3 py-2">
                  <input
                    type="number"
                    defaultValue={entry.alertBelow ?? ""}
                    placeholder="—"
                    onBlur={(e) =>
                      setWatched(
                        updateWatchAlert(watched, item.id, {
                          alertBelow: e.target.value ? Number(e.target.value) : null,
                        })
                      )
                    }
                    className={`glass rounded-lg px-2 py-1 text-sm w-28 outline-none ${
                      belowTriggered ? "text-rose-400 border-rose-500/40" : "text-gray-200"
                    }`}
                  />
                </td>
                <td className="px-3 py-2 text-gray-500 text-xs">{formatAgo(item.updated_at)}</td>
                <td className="px-3 py-2">
                  <button
                    onClick={() => setWatched(toggleWatch(watched, item.id))}
                    className="text-xs text-gray-500 hover:text-rose-400"
                  >
                    Remove
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
