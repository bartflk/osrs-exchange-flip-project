import { useEffect, useState } from "preact/hooks";
import { fetchItemOfTheHour, type ItemOfTheHourResponse, type MarketItem } from "../api";
import { formatGp, formatGpFull } from "../format";
import { EmptyState } from "./ui";

// DESIGN.md §14.44: "Item of the hour" -- what's worth buying at this half-hour of the UTC day,
// ranked by the timing edge available at its best later sell slot, the volume actually traded in
// this slot, and the gp that edge is worth at a full buy limit.
//
// Direct request: "a per 30 minutes 'Best item to buy' on the time of day... sorted by volume and
// profit at the sell point."

function iconUrl(icon: string | null): string {
  if (!icon) return "";
  return `https://oldschool.runescape.wiki/images/${encodeURIComponent(icon.replace(/ /g, "_"))}`;
}

function localOf(slotLabel: string): string {
  const [h, m] = slotLabel.split(":").map(Number);
  const d = new Date();
  d.setUTCHours(h, m, 0, 0);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export function ItemOfTheHour({
  items,
  onSelectItem,
}: {
  items: MarketItem[];
  onSelectItem: (item: MarketItem) => void;
}) {
  const [data, setData] = useState<ItemOfTheHourResponse | null>(null);
  const [slot, setSlot] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    fetchItemOfTheHour(slot ?? undefined)
      .then((d) => !cancelled && setData(d))
      .catch((e) => !cancelled && setError(e instanceof Error ? e.message : "failed"));
    return () => {
      cancelled = true;
    };
  }, [slot]);

  function open(itemId: number) {
    const match = items.find((i) => i.id === itemId);
    if (match) onSelectItem(match);
  }

  const isNow = data != null && data.slot === data.currentSlot;

  return (
    <div className="glass rounded-xl p-4 mb-4">
      <div className="flex items-center justify-between gap-2 mb-3 flex-wrap">
        <h3 className="text-sm font-medium text-gray-200">
          Item of the hour
          {data && (
            <span className="ml-2 text-xs text-gray-500 font-normal">
              {data.slotLabel} UTC ({localOf(data.slotLabel)} local)
              {isNow ? " · now" : ""} · {data.itemsProfiled} items profiled
            </span>
          )}
        </h3>
        <div className="flex items-center gap-2">
          {/* Browsing other slots is the planning half of this: "what should I be buying at 03:00
              tomorrow" is as useful as "right now". */}
          <select
            value={slot ?? (data?.currentSlot ?? 0)}
            onChange={(e) => setSlot(Number((e.target as HTMLSelectElement).value))}
            className="bg-white/5 border border-white/10 rounded-lg px-2 py-1 text-xs text-gray-200"
          >
            {Array.from({ length: 48 }, (_, i) => {
              const h = String(Math.floor(i / 2)).padStart(2, "0");
              const m = i % 2 === 0 ? "00" : "30";
              return (
                <option key={i} value={i}>
                  {h}:{m} UTC
                </option>
              );
            })}
          </select>
          {slot != null && (
            <button
              onClick={() => setSlot(null)}
              className="text-xs text-sky-400 hover:text-sky-300"
            >
              now
            </button>
          )}
          <button
            onClick={() => setCollapsed((c) => !c)}
            className="text-xs text-gray-500 hover:text-gray-300"
          >
            {collapsed ? "show" : "hide"}
          </button>
        </div>
      </div>

      {!collapsed && (
        <>
          {error && <p className="text-xs text-rose-400">{error}</p>}

          {!error && !data && <p className="text-xs text-gray-500">Loading…</p>}

          {data && data.picks.length === 0 && (
            <EmptyState
              title="No timing edge at this slot"
              hint={
                data.itemsProfiled === 0
                  ? "Item profiles are still being built — this runs in the background shortly after startup."
                  : "Nothing profiled shows a profitable later sell point for this half-hour."
              }
            />
          )}

          {data && data.picks.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-[11px] uppercase tracking-wide text-gray-500 text-left">
                    <th className="pb-2 pr-3 font-medium">Item</th>
                    <th className="pb-2 pr-3 font-medium text-right">Buy @</th>
                    <th className="pb-2 pr-3 font-medium text-right">Sell @</th>
                    <th className="pb-2 pr-3 font-medium text-right">Sell at</th>
                    <th className="pb-2 pr-3 font-medium text-right">Hold</th>
                    <th className="pb-2 pr-3 font-medium text-right">Profit/u</th>
                    <th className="pb-2 pr-3 font-medium text-right">Edge</th>
                    <th className="pb-2 pr-3 font-medium text-right">Volume</th>
                    <th className="pb-2 pr-3 font-medium text-right">At buy limit</th>
                    <th className="pb-2 font-medium text-right">Score</th>
                  </tr>
                </thead>
                <tbody>
                  {data.picks.map((p) => (
                    <tr
                      key={p.itemId}
                      onClick={() => open(p.itemId)}
                      className="border-t border-white/5 hover:bg-white/5 cursor-pointer"
                    >
                      <td className="py-2 pr-3">
                        <div className="flex items-center gap-2">
                          {p.icon && (
                            <img src={iconUrl(p.icon)} alt="" className="w-4 h-4 object-contain" />
                          )}
                          <span className="text-gray-200 whitespace-nowrap">{p.name}</span>
                        </div>
                      </td>
                      <td className="py-2 pr-3 text-right font-mono text-gray-300">
                        {p.buyPrice != null ? formatGpFull(p.buyPrice) : "—"}
                      </td>
                      {/* §14.45: real gp at the sell slot, so buy@ -> sell@ -> profit/unit is
                          arithmetic the reader can check, not a percentage to take on faith. */}
                      <td className="py-2 pr-3 text-right font-mono text-orange-300">
                        {p.sellPrice != null ? formatGpFull(p.sellPrice) : "—"}
                      </td>
                      <td className="py-2 pr-3 text-right font-mono text-orange-300">
                        {p.bestSellSlotLabel ?? "—"}
                      </td>
                      <td className="py-2 pr-3 text-right font-mono text-gray-400">
                        {p.holdHours != null ? `${p.holdHours}h` : "—"}
                      </td>
                      <td className="py-2 pr-3 text-right font-mono text-gray-200">
                        {p.profitPerUnit != null ? formatGpFull(p.profitPerUnit) : "—"}
                      </td>
                      <td className="py-2 pr-3 text-right font-mono text-emerald-400">
                        {p.timingEdgePct != null ? `${(p.timingEdgePct * 100).toFixed(2)}%` : "—"}
                      </td>
                      <td className="py-2 pr-3 text-right font-mono text-gray-400">
                        {p.volume.toLocaleString()}
                      </td>
                      <td className="py-2 pr-3 text-right font-mono text-gray-200">
                        {p.projectedProfitPerLimit != null
                          ? formatGp(p.projectedProfitPerLimit)
                          : "—"}
                      </td>
                      <td className="py-2 text-right font-mono text-gray-500">{p.score}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <p className="text-[10px] text-gray-600 mt-2 leading-relaxed">
            30-minute buckets over 7.6 days (the finest resolution this API offers over a week),
            detrended per day and aggregated with a median so one bad print can't decide a ranking.
"Edge" is the real after-tax return: (sell − 2% tax − buy) ÷ buy, from median gp
            at each slot. It requires holding for the stated time and is not an instant margin.
          </p>
        </>
      )}
    </div>
  );
}
