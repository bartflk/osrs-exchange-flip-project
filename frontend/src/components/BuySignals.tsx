import { useMemo, useState } from "preact/hooks";
import type { MarketItem } from "../api";
import { formatGp, formatPct } from "../format";
import { allocateCapital } from "../capitalAllocator";
import { NumberInput } from "./ui";

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
  const [numSlots, setNumSlots] = useState(() => loadNumber("numSlots", 8));

  function updateBankroll(v: number) {
    setBankroll(v);
    localStorage.setItem("bankroll", String(v));
  }
  function updateAllocation(v: number) {
    setAllocationPct(v);
    localStorage.setItem("allocationPct", String(v));
  }
  function updateNumSlots(v: number) {
    setNumSlots(v);
    localStorage.setItem("numSlots", String(v));
  }

  const allocation = useMemo(
    () => allocateCapital(items, { bankroll, numSlots, maxAllocationPct: allocationPct }),
    [items, bankroll, numSlots, allocationPct],
  );

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
          <NumberInput value={bankroll} onChange={updateBankroll} className="w-40" />
        </label>
        <label className="text-xs text-gray-400 flex flex-col gap-1">
          Max allocation per item (%)
          <NumberInput value={allocationPct} onChange={updateAllocation} className="w-24" />
        </label>
        <label className="text-xs text-gray-400 flex flex-col gap-1">
          GE slots
          <NumberInput
            value={numSlots}
            onChange={(v) => updateNumSlots(Math.max(1, Math.min(8, v)))}
            className="w-20"
          />
        </label>
        <p className="text-xs text-gray-500 max-w-md">
          Suggested quantity = min(buy limit, {formatGp(bankroll * (allocationPct / 100))} ÷ buy
          price). Ranked by the same score as the Market tab. No account/bank data yet — see
          DESIGN.md §6.5.
        </p>
      </div>

      {/* DESIGN.md §11.3 item 7: capital allocator -- fills your actual GE slots, one item each,
          respecting the per-item cap and the total bankroll (not just "everything affordable"). */}
      <div className="glass rounded-xl p-4 mb-4">
        <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
          <h3 className="text-sm font-medium text-gray-200">
            Capital allocator — fill your {numSlots} GE slots
          </h3>
          <div className="flex items-center gap-4 text-xs">
            <span className="text-gray-500">
              Spent{" "}
              <span className="text-gray-200 font-mono">{formatGp(allocation.totalCost)}</span>
            </span>
            <span className="text-gray-500">
              Idle{" "}
              <span className="text-gray-200 font-mono">
                {formatGp(allocation.remainingBankroll)}
              </span>
            </span>
            <span className="text-gray-500">
              Projected profit{" "}
              <span className="text-emerald-400 font-mono">{formatGp(allocation.totalProfit)}</span>
            </span>
          </div>
        </div>
        {allocation.assignments.length === 0 ? (
          <p className="text-xs text-gray-500">
            No affordable slots at the current bankroll/allocation.
          </p>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-2">
            {allocation.assignments.map((a) => (
              <button
                key={a.slot}
                onClick={() => onSelectItem(a.item)}
                className="text-left rounded-lg border border-white/10 bg-white/[0.03] hover:bg-white/[0.06] p-3 transition-colors"
              >
                <div className="flex items-center justify-between mb-1">
                  <span className="text-[10px] uppercase tracking-wide text-gray-500">
                    Slot {a.slot}
                  </span>
                  <span className="text-[10px] font-mono text-gray-500">
                    {formatPct(a.item.roi_pct)}
                  </span>
                </div>
                <div className="flex items-center gap-2 min-w-0">
                  {a.item.icon && (
                    <img
                      src={`https://oldschool.runescape.wiki/images/${encodeURIComponent(a.item.icon.replace(/ /g, "_"))}`}
                      alt=""
                      className="w-5 h-5 object-contain shrink-0"
                    />
                  )}
                  <span className="text-sm text-gray-100 truncate">{a.item.name}</span>
                </div>
                <div className="mt-2 flex items-center justify-between text-xs">
                  <span className="text-gray-500">
                    qty <span className="text-gray-200 font-mono">{a.qty.toLocaleString()}</span>
                  </span>
                  <span className="text-emerald-400 font-mono">+{formatGp(a.projectedProfit)}</span>
                </div>
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 2xl:grid-cols-3 gap-3">
        {signals.map(({ item, qty, projectedProfit }) => (
          <div key={item.id} className="glass rounded-xl p-4 flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 min-w-0">
                {item.icon && (
                  <img
                    src={iconUrl(item.icon)}
                    alt=""
                    className="w-6 h-6 object-contain shrink-0"
                  />
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
              <span className="font-mono text-emerald-400 text-right">
                {formatGp(item.net_margin)}
              </span>
              <span className="text-gray-500">ROI</span>
              <span className="font-mono text-emerald-400 text-right">
                {formatPct(item.roi_pct)}
              </span>
            </div>

            <div className="mt-1 pt-2 border-t border-white/10 flex items-center justify-between">
              <div className="text-xs text-gray-500">
                Suggested qty
                <div className="text-lg font-mono text-white">{qty.toLocaleString()}</div>
              </div>
              <div className="text-xs text-gray-500 text-right">
                Projected profit
                <div className="text-lg font-mono text-emerald-400">
                  {formatGp(projectedProfit)}
                </div>
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
