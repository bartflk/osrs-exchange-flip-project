import { useMemo, useState } from "react";
import type { MarketItem } from "../api";
import { formatGp, formatPct } from "../format";

function iconUrl(icon: string): string {
  if (!icon) return "";
  return `https://oldschool.runescape.wiki/images/${encodeURIComponent(icon.replace(/ /g, "_"))}`;
}

function loadNumber(key: string, fallback: number): number {
  const raw = localStorage.getItem(key);
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) ? n : fallback;
}

export function BuySignals({
  items,
  onSelectItem,
}: {
  items: MarketItem[];
  onSelectItem: (item: MarketItem) => void;
}) {
  const [bankroll, setBankroll] = useState(() => loadNumber("bankroll", 10_000_000));
  const [allocationPct, setAllocationPct] = useState(() => loadNumber("allocationPct", 15));

  function updateBankroll(v: number) {
    setBankroll(v);
    localStorage.setItem("bankroll", String(v));
  }
  function updateAllocation(v: number) {
    setAllocationPct(v);
    localStorage.setItem("allocationPct", String(v));
  }

  const signals = useMemo(() => {
    const allocation = bankroll * (allocationPct / 100);
    return items
      .filter((i) => (i.net_margin ?? 0) > 0 && i.low)
      .map((i) => {
        const affordableQty = i.low ? Math.floor(allocation / i.low) : 0;
        const qty = Math.max(0, Math.min(i.buy_limit ?? Infinity, affordableQty));
        const projectedProfit = qty * (i.net_margin ?? 0);
        return { item: i, qty, projectedProfit };
      })
      .filter((s) => s.qty > 0)
      .sort((a, b) => b.item.score - a.item.score)
      .slice(0, 30);
  }, [items, bankroll, allocationPct]);

  return (
    <div>
      <div className="glass rounded-xl p-4 mb-4 flex flex-wrap items-end gap-6">
        <label className="text-xs text-gray-400 flex flex-col gap-1">
          Bankroll (gp)
          <input
            type="number"
            value={bankroll}
            onChange={(e) => updateBankroll(Number(e.target.value) || 0)}
            className="glass rounded-lg px-2 py-1.5 text-sm text-gray-100 w-40 outline-none"
          />
        </label>
        <label className="text-xs text-gray-400 flex flex-col gap-1">
          Max allocation per item (%)
          <input
            type="number"
            value={allocationPct}
            onChange={(e) => updateAllocation(Number(e.target.value) || 0)}
            className="glass rounded-lg px-2 py-1.5 text-sm text-gray-100 w-24 outline-none"
          />
        </label>
        <p className="text-xs text-gray-500 max-w-md">
          Suggested quantity = min(buy limit, {formatGp(bankroll * (allocationPct / 100))} ÷ buy price).
          Ranked by the same score as the Market tab. No account/bank data yet — see DESIGN.md §6.5.
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 2xl:grid-cols-3 gap-3">
        {signals.map(({ item, qty, projectedProfit }) => (
          <div key={item.id} className="glass rounded-xl p-4 flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 min-w-0">
                {item.icon && (
                  <img src={iconUrl(item.icon)} alt="" className="w-6 h-6 object-contain shrink-0" />
                )}
                <button
                  onClick={() => onSelectItem(item)}
                  className="text-gray-100 font-medium truncate hover:text-white hover:underline text-left"
                >
                  {item.name}
                </button>
              </div>
              <span className="text-[10px] font-semibold tracking-wide uppercase px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-400 border border-emerald-500/30 shrink-0">
                Buy
              </span>
            </div>

            <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
              <span className="text-gray-500">Buy at</span>
              <span className="font-mono text-gray-200 text-right">{formatGp(item.low)}</span>
              <span className="text-gray-500">Sell at</span>
              <span className="font-mono text-gray-200 text-right">{formatGp(item.high)}</span>
              <span className="text-gray-500">Net margin</span>
              <span className="font-mono text-emerald-400 text-right">{formatGp(item.net_margin)}</span>
              <span className="text-gray-500">ROI</span>
              <span className="font-mono text-emerald-400 text-right">{formatPct(item.roi_pct)}</span>
            </div>

            <div className="mt-1 pt-2 border-t border-white/10 flex items-center justify-between">
              <div className="text-xs text-gray-500">
                Suggested qty
                <div className="text-lg font-mono text-white">{qty.toLocaleString()}</div>
              </div>
              <div className="text-xs text-gray-500 text-right">
                Projected profit
                <div className="text-lg font-mono text-emerald-400">{formatGp(projectedProfit)}</div>
              </div>
            </div>
          </div>
        ))}
        {signals.length === 0 && (
          <div className="glass rounded-xl p-10 text-center text-gray-400 col-span-full">
            No signals match your current bankroll/allocation and the Market tab's liquidity filter.
          </div>
        )}
      </div>
    </div>
  );
}
