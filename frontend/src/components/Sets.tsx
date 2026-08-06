import { useEffect, useState } from "preact/hooks";
import {
  fetchSetArbitrage,
  fetchBarrowsRepair,
  type SetArbitrageResult,
  type BarrowsRepairResult,
} from "../api";
import { formatGp } from "../format";

// DESIGN.md §10 items 15-16: Set Conversion Arbitrage + Barrows Repair Flip -- grouped in one
// tab since both are the same family of deterministic "combine/convert pieces for profit" tools,
// distinct from the price-ranking-based Buy Signals/Market tabs.
export function Sets() {
  const [sets, setSets] = useState<SetArbitrageResult[]>([]);
  const [flips, setFlips] = useState<BarrowsRepairResult[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  function toggleExpanded(setName: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(setName)) next.delete(setName);
      else next.add(setName);
      return next;
    });
  }

  useEffect(() => {
    let cancelled = false;
    Promise.all([fetchSetArbitrage(), fetchBarrowsRepair()])
      .then(([a, b]) => {
        if (cancelled) return;
        setSets(a.sets);
        setFlips(b.flips);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "Failed to load");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (loading) return <div className="text-sm text-gray-500 p-4">Loading sets…</div>;
  if (error) return <div className="text-sm text-rose-400 p-4">{error}</div>;

  const profitableSets = sets.filter((s) => s.bestProfit > 0);
  const profitableFlips = flips.filter((f) => f.profit > 0);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-medium text-gray-200">Set conversion arbitrage</h2>
          <span className="text-xs text-gray-500">
            Buy pieces, sell as a set — or the reverse — whichever direction is currently
            profitable. See DESIGN.md §10 item 15.
          </span>
        </div>
        {profitableSets.length === 0 ? (
          <div className="glass rounded-xl p-6 text-center text-gray-400 text-sm">
            No profitable set conversions right now.
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 2xl:grid-cols-3 gap-3">
            {profitableSets.map((s) => {
              const isOpen = expanded.has(s.setName);
              return (
                <div key={s.setName} className="glass rounded-xl p-4">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-gray-100 font-medium">{s.setName}</span>
                    <span
                      className={`text-[10px] uppercase tracking-wide px-2 py-0.5 rounded-full border ${
                        s.bestDirection === "combine"
                          ? "bg-emerald-500/15 text-emerald-400 border-emerald-500/30"
                          : "bg-sky-500/15 text-sky-400 border-sky-500/30"
                      }`}
                    >
                      {s.bestDirection === "combine" ? "Combine" : "Decombine"}
                    </span>
                  </div>
                  <div className="text-xs text-gray-500 mb-2">{s.pieceNames.join(", ")}</div>
                  <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
                    <span className="text-gray-500">
                      {s.bestDirection === "combine" ? "Pieces cost" : "Set cost"}
                    </span>
                    <span className="font-mono text-gray-200 text-right">
                      {formatGp(s.bestDirection === "combine" ? s.pieceCost : s.setBuy)}
                    </span>
                    <span className="text-gray-500">
                      {s.bestDirection === "combine" ? "Set sells for" : "Pieces sell for"}
                    </span>
                    <span className="font-mono text-gray-200 text-right">
                      {formatGp(s.bestDirection === "combine" ? s.setSell : s.pieceRevenue)}
                    </span>
                    <span className="text-gray-500">
                      {s.bestDirection === "combine" ? "Tax (set sale)" : "Tax (per-piece sales)"}
                    </span>
                    <span className="font-mono text-rose-400 text-right">
                      -
                      {formatGp(
                        s.bestDirection === "combine"
                          ? s.setTax
                          : s.pieces.reduce((sum, p) => sum + p.tax, 0),
                      )}
                    </span>
                    <span className="text-gray-500">Profit</span>
                    <span className="font-mono text-emerald-400 text-right">
                      {formatGp(s.bestProfit)}
                    </span>
                  </div>

                  <button
                    onClick={() => toggleExpanded(s.setName)}
                    className="text-xs text-sky-400 hover:text-sky-300 mt-3"
                  >
                    {isOpen ? "Hide" : "Show"} per-item breakdown
                  </button>

                  {isOpen && (
                    <div className="mt-2 pt-2 border-t border-white/10">
                      <table className="w-full text-xs">
                        <thead className="text-gray-500">
                          <tr>
                            <th className="text-left font-medium py-1">Item</th>
                            <th className="text-right font-medium py-1">
                              {s.bestDirection === "combine" ? "Buy" : "Sell"}
                            </th>
                            <th className="text-right font-medium py-1">Tax</th>
                            <th className="text-right font-medium py-1">Net</th>
                          </tr>
                        </thead>
                        <tbody>
                          {s.bestDirection === "combine" ? (
                            <>
                              {s.pieces.map((p) => (
                                <tr key={p.name} className="border-t border-white/5">
                                  <td className="py-1 text-gray-300">{p.name}</td>
                                  <td className="py-1 font-mono text-gray-300 text-right">
                                    {formatGp(p.buy)}
                                  </td>
                                  <td className="py-1 font-mono text-gray-600 text-right">—</td>
                                  <td className="py-1 font-mono text-rose-400 text-right">
                                    -{formatGp(p.buy)}
                                  </td>
                                </tr>
                              ))}
                              <tr className="border-t border-white/5">
                                <td className="py-1 text-gray-200 font-medium">
                                  {s.setName} (sold)
                                </td>
                                <td className="py-1 font-mono text-gray-300 text-right">
                                  {formatGp(s.setSell)}
                                </td>
                                <td className="py-1 font-mono text-rose-400 text-right">
                                  -{formatGp(s.setTax)}
                                </td>
                                <td className="py-1 font-mono text-emerald-400 text-right">
                                  +{formatGp(s.setSell - s.setTax)}
                                </td>
                              </tr>
                            </>
                          ) : (
                            <>
                              <tr>
                                <td className="py-1 text-gray-200 font-medium">
                                  {s.setName} (bought)
                                </td>
                                <td className="py-1 font-mono text-gray-300 text-right">
                                  {formatGp(s.setBuy)}
                                </td>
                                <td className="py-1 font-mono text-gray-600 text-right">—</td>
                                <td className="py-1 font-mono text-rose-400 text-right">
                                  -{formatGp(s.setBuy)}
                                </td>
                              </tr>
                              {s.pieces.map((p) => (
                                <tr key={p.name} className="border-t border-white/5">
                                  <td className="py-1 text-gray-300">{p.name}</td>
                                  <td className="py-1 font-mono text-gray-300 text-right">
                                    {formatGp(p.sell)}
                                  </td>
                                  <td className="py-1 font-mono text-rose-400 text-right">
                                    -{formatGp(p.tax)}
                                  </td>
                                  <td className="py-1 font-mono text-emerald-400 text-right">
                                    +{formatGp(p.sell - p.tax)}
                                  </td>
                                </tr>
                              ))}
                            </>
                          )}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-medium text-gray-200">Barrows repair flip</h2>
          <span className="text-xs text-gray-500">
            Buy a fully-degraded (0%) piece, repair it, sell it undegraded. Repair cost = 1000 ×
            slot multiplier (Wiki-sourced, NPC rate — a house armour stand + Smithing level would be
            cheaper). See DESIGN.md §10 item 16.
          </span>
        </div>
        {profitableFlips.length === 0 ? (
          <div className="glass rounded-xl p-6 text-center text-gray-400 text-sm">
            No profitable Barrows repair flips right now.
          </div>
        ) : (
          <div className="glass rounded-xl overflow-hidden">
            <table className="w-full text-sm text-left border-collapse">
              <thead className="bg-white/[0.03] text-gray-400">
                <tr className="border-b border-white/10">
                  <th className="px-3 py-2 font-medium">Piece</th>
                  <th className="px-3 py-2 font-medium text-right">Buy (0%)</th>
                  <th className="px-3 py-2 font-medium text-right">Repair cost</th>
                  <th className="px-3 py-2 font-medium text-right">Sell (100%)</th>
                  <th className="px-3 py-2 font-medium text-right">Profit</th>
                </tr>
              </thead>
              <tbody>
                {profitableFlips.map((f) => (
                  <tr key={f.degradedName} className="border-b border-white/5">
                    <td className="px-3 py-2 text-gray-200">{f.repairedName}</td>
                    <td className="px-3 py-2 font-mono text-gray-300 text-right">
                      {formatGp(f.degradedBuy)}
                    </td>
                    <td className="px-3 py-2 font-mono text-gray-300 text-right">
                      {formatGp(f.repairCost)}
                    </td>
                    <td className="px-3 py-2 font-mono text-gray-300 text-right">
                      {formatGp(f.repairedSell)}
                    </td>
                    <td className="px-3 py-2 font-mono text-emerald-400 text-right">
                      {formatGp(f.profit)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
