import { useEffect, useState } from "preact/hooks";
import { fetchItemOfTheHour, type ItemOfTheHourResponse, type MarketItem } from "../api";
import { formatGp, formatGpFull } from "../format";
import {
  slotToLocalLabel,
  utcLabelToSlot,
} from "../timeSlots";
import { useCurrentSlot } from "../useCurrentSlot";
import { EmptyState } from "./ui";
import { InfoTip, LabelWithInfo } from "./InfoTip";

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



export function ItemOfTheHour({
  items,
  onSelectItem,
}: {
  items: MarketItem[];
  onSelectItem: (item: MarketItem) => void;
}) {
  const [data, setData] = useState<ItemOfTheHourResponse | null>(null);
  const [slot, setSlot] = useState<number | null>(null);
  // §14.50: same staleness fix as Overnight Trading -- the API's currentSlot was read once.
  const liveSlot = useCurrentSlot();
  const effectiveSlot = slot ?? liveSlot;
  const [error, setError] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  // Same localStorage key the Capital Allocator uses, so one bankroll drives both.
  const bankroll = Number(localStorage.getItem("bankroll")) || 10_000_000;

  useEffect(() => {
    let cancelled = false;
    setError(null);
    fetchItemOfTheHour(effectiveSlot, bankroll)
      .then((d) => !cancelled && setData(d))
      .catch((e) => !cancelled && setError(e instanceof Error ? e.message : "failed"));
    return () => {
      cancelled = true;
    };
  }, [effectiveSlot, bankroll]);

  function open(itemId: number) {
    const match = items.find((i) => i.id === itemId);
    if (match) onSelectItem(match);
  }

  const isNow = effectiveSlot === liveSlot;
  const top = data?.picks[0];

  // Direct feedback: "item of the hour is hard to really take action on" -- the table is real
  // data, not fake, but reading 12 columns and remembering two numbers to go type into the game
  // isn't a real action. Clipboard copy is a concrete one-click affordance that doesn't touch any
  // tracked state (unlike the old "Track this buy" flow, removed in §14.42 for conflicting with
  // real RuneLite slot data) -- it just puts the price where you can paste it.
  const [copiedFor, setCopiedFor] = useState<number | null>(null);
  function copyBuyPrice(itemId: number, price: number) {
    navigator.clipboard
      ?.writeText(String(Math.round(price)))
      .then(() => {
        setCopiedFor(itemId);
        setTimeout(() => setCopiedFor((c) => (c === itemId ? null : c)), 1500);
      })
      // Denied permission (e.g. page not focused) shouldn't surface as an uncaught error -- the
      // button just silently doesn't flip to "Copied", same as any other no-op failed click.
      .catch(() => {});
  }

  return (
    <div className="glass rounded-xl p-4 mb-4">
      <div className="flex items-center justify-between gap-2 mb-3 flex-wrap">
        <h3 className="text-sm font-medium text-gray-200">
          <InfoTip id="itemOfTheHour" />{" "}
          Item of the hour
          {data && (
            <span className="ml-2 text-xs text-gray-500 font-normal">
              {slotToLocalLabel(utcLabelToSlot(data.slotLabel))}
              {isNow ? " · now" : ""} · {data.itemsProfiled} profiled · sized for{" "}
              {formatGp(bankroll)}
            </span>
          )}
        </h3>
        <div className="flex items-center gap-2">
          {/* Browsing other slots is the planning half of this: "what should I be buying at 03:00
              tomorrow" is as useful as "right now". */}
          <select
            value={effectiveSlot}
            onChange={(e) => setSlot(Number((e.target as HTMLSelectElement).value))}
            className="bg-white/5 border border-white/10 rounded-lg px-2 py-1 text-xs text-gray-200"
          >
            {Array.from({ length: 48 }, (_, i) => (
              <option key={i} value={i}>
                {slotToLocalLabel(i)}
              </option>
            ))}
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
                  ? "Item profiles are still being built, this runs in the background shortly after startup."
                  : "Nothing profiled shows a profitable later sell point for this half-hour."
              }
            />
          )}

          {top && (
            <div className="rounded-xl bg-gradient-to-r from-violet-500/10 to-sky-500/10 border border-violet-400/20 p-3 mb-3 flex items-center justify-between flex-wrap gap-3">
              <div className="flex items-center gap-2 min-w-0">
                {top.icon && (
                  <img src={iconUrl(top.icon)} alt="" className="w-7 h-7 object-contain shrink-0" />
                )}
                <div className="min-w-0">
                  <div className="text-[10px] uppercase tracking-wide text-violet-300">
                    Top pick this slot
                  </div>
                  <button
                    onClick={() => open(top.itemId)}
                    className="text-sm font-medium text-gray-100 hover:text-white hover:underline truncate"
                  >
                    {top.name}
                  </button>
                </div>
              </div>
              <div className="flex items-center gap-4 text-xs">
                <span className="text-gray-400">
                  Buy <span className="font-mono text-gray-200">{top.buyPrice != null ? formatGpFull(top.buyPrice) : "-"}</span>
                </span>
                <span className="text-gray-400">
                  Sell <span className="font-mono text-gray-200">{top.sellPrice != null ? formatGpFull(top.sellPrice) : "-"}</span>
                </span>
                <span className="text-emerald-400 font-mono">
                  {top.timingEdgePct != null ? `${(top.timingEdgePct * 100).toFixed(1)}%` : "-"}
                </span>
                {top.buyPrice != null && (
                  <button
                    onClick={() => copyBuyPrice(top.itemId, top.buyPrice!)}
                    className="px-2.5 py-1 rounded-lg text-xs bg-violet-500/15 text-violet-300 hover:bg-violet-500/25 border border-violet-500/30"
                  >
                    {copiedFor === top.itemId ? "Copied" : "Copy buy price"}
                  </button>
                )}
              </div>
            </div>
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
                    <th className="pb-2 pr-3 font-medium text-right">
                      <LabelWithInfo id="timingEdge">Profit/u</LabelWithInfo>
                    </th>
                    <th className="pb-2 pr-3 font-medium text-right">
                      <LabelWithInfo id="timingEdge">Edge</LabelWithInfo>
                    </th>
                    <th className="pb-2 pr-3 font-medium text-right">
                      <LabelWithInfo id="daysWon">Days won</LabelWithInfo>
                    </th>
                    <th className="pb-2 pr-3 font-medium text-right">
                      <LabelWithInfo id="deployableUnits">Buy qty</LabelWithInfo>
                    </th>
                    <th className="pb-2 pr-3 font-medium text-right">Capital</th>
                    <th className="pb-2 pr-3 font-medium text-right">Profit</th>
                    <th className="pb-2 font-medium text-right">
                      <LabelWithInfo id="slotScore">Score</LabelWithInfo>
                    </th>
                    <th className="pb-2 pl-3 font-medium text-right"></th>
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
                        {p.buyPrice != null ? formatGpFull(p.buyPrice) : "-"}
                      </td>
                      {/* §14.45: real gp at the sell slot, so buy@ -> sell@ -> profit/unit is
                          arithmetic the reader can check, not a percentage to take on faith. */}
                      <td className="py-2 pr-3 text-right font-mono text-orange-300">
                        {p.sellPrice != null ? formatGpFull(p.sellPrice) : "-"}
                      </td>
                      <td className="py-2 pr-3 text-right font-mono text-orange-300">
                        {p.bestSellSlotLabel ? slotToLocalLabel(utcLabelToSlot(p.bestSellSlotLabel)) : "-"}
                      </td>
                      <td className="py-2 pr-3 text-right font-mono text-gray-400">
                        {p.holdHours != null ? `${p.holdHours}h` : "-"}
                      </td>
                      <td className="py-2 pr-3 text-right font-mono text-gray-200">
                        {p.profitPerUnit != null ? formatGpFull(p.profitPerUnit) : "-"}
                      </td>
                      <td className="py-2 pr-3 text-right font-mono text-emerald-400">
                        {p.timingEdgePct != null ? `${(p.timingEdgePct * 100).toFixed(2)}%` : "-"}
                      </td>
                      {/* §14.51: the sample, next to the claim. "4/7 days" is the difference
                          between a pattern and a coincidence, and it costs one column. */}
                      <td
                        className={`py-2 pr-3 text-right font-mono ${
                          p.pairedDays > 0 && p.winDays / p.pairedDays >= 0.7
                            ? "text-emerald-400"
                            : p.pairedDays > 0 && p.winDays / p.pairedDays <= 0.5
                              ? "text-amber-400"
                              : "text-gray-400"
                        }`}
                        title={
                          `Median of ${p.pairedDays} days where both the buy and sell slot had a reading` +
                          (p.pairedSpanDays > p.pairedDays
                            ? `, spread across ${p.pairedSpanDays} calendar days`
                            : "")
                        }
                      >
                        {p.pairedDays > 0 ? `${p.winDays}/${p.pairedDays}` : "-"}
                      </td>
                      {/* §14.46: units your bankroll can actually take (buy limit or affordability,
                          whichever binds), the gp it ties up, and what that earns. Amber when the
                          position would be a large share of the slot's normal volume -- at that
                          point you're moving the price rather than taking it, and the historical
                          median stops predicting your fill. */}
                      <td
                        className={`py-2 pr-3 text-right font-mono ${
                          p.fillShare != null && p.fillShare > 0.5 ? "text-amber-400" : "text-gray-300"
                        }`}
                        title={
                          p.fillShare != null
                            ? `${(p.fillShare * 100).toFixed(0)}% of this slot's typical volume (${p.volume.toLocaleString()}/30m)`
                            : undefined
                        }
                      >
                        {p.deployableUnits.toLocaleString()}
                      </td>
                      <td className="py-2 pr-3 text-right font-mono text-gray-400">
                        {formatGp(p.capitalUsed)}
                      </td>
                      <td className="py-2 pr-3 text-right font-mono text-emerald-300">
                        {formatGp(p.cycleProfit)}
                      </td>
                      <td className="py-2 text-right font-mono text-gray-500">{p.score}</td>
                      <td className="py-2 pl-3 text-right">
                        {p.buyPrice != null && (
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              copyBuyPrice(p.itemId, p.buyPrice!);
                            }}
                            title="Copy buy price to clipboard"
                            className="px-2 py-0.5 rounded-md text-[10px] bg-white/5 text-gray-400 hover:bg-violet-500/20 hover:text-violet-300 border border-white/10"
                          >
                            {copiedFor === p.itemId ? "Copied" : "Copy"}
                          </button>
                        )}
                      </td>
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
