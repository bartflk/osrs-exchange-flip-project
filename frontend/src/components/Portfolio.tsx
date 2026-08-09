import { useEffect, useState } from "preact/hooks";
import {
  listBankImports,
  fetchPortfolio,
  type BankImportSummary,
  type MarketItem,
  type PortfolioResponse,
} from "../api";
import { formatGp, formatGpFull, formatPct } from "../format";
import { NetWorthChart } from "./NetWorthChart";
import { SessionPanel } from "./SessionPanel";
import { StatCard, EmptyState } from "./ui";

function iconUrl(icon: string | null): string {
  if (!icon) return "";
  return `https://oldschool.runescape.wiki/images/${encodeURIComponent(icon.replace(/ /g, "_"))}`;
}

// DESIGN.md §14.40: rebuilt on the real GE trade ledger.
//
// This previously showed hand-entered offers (offers.ts) and hand-confirmed fills (fills.ts) from
// localStorage, because §6.6 had concluded no local live-offer export existed. Flipping Copilot
// writes exactly that, one file per GE slot, so all three of those manual systems are gone --
// positions, open offers and fills are now observed rather than typed in. That also removes the
// "doubled functionality" problem where the same offer had to be entered here and tracked in
// Buy Signals separately.
export function Portfolio({
  items,
  onSelectItem,
}: {
  items: MarketItem[];
  onSelectItem: (item: MarketItem) => void;
}) {
  const [history, setHistory] = useState<BankImportSummary[]>([]);
  const [historyLoading, setHistoryLoading] = useState(true);
  const [portfolio, setPortfolio] = useState<PortfolioResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    listBankImports()
      .then((res) => setHistory(res.imports))
      .catch(() => {})
      .finally(() => setHistoryLoading(false));
  }, []);

  useEffect(() => {
    let cancelled = false;
    function load() {
      fetchPortfolio()
        .then((p) => !cancelled && setPortfolio(p))
        .catch((e) => !cancelled && setError(e instanceof Error ? e.message : "failed"));
    }
    load();
    const id = setInterval(load, 20_000); // matches the backend's slot-read cadence
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  function openItem(itemId: number) {
    const match = items.find((i) => i.id === itemId);
    if (match) onSelectItem(match);
  }

  const latestNetWorth = history[0]?.total_value ?? null;
  const totals = portfolio?.totals;
  const noSources = portfolio && !portfolio.sources.copilot && !portfolio.sources.flippingUtilities;

  return (
    <div>
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 mb-5">
        <StatCard
          label="Assets value"
          value={totals ? formatGp(totals.assetsValue) : "—"}
          hint={totals ? `${totals.uniqueItems} unique item${totals.uniqueItems === 1 ? "" : "s"}` : ""}
        />
        <StatCard
          label="Cash in buy offers"
          value={totals ? formatGp(totals.cashInBuyOffers) : "—"}
          hint={totals ? `${totals.slotsUsed}/8 slots used` : ""}
        />
        <StatCard
          label="Unrealized profit"
          value={totals ? formatGp(totals.unrealizedProfit) : "—"}
          hint="net of GE tax"
        />
        <StatCard
          label="Bank net worth"
          value={latestNetWorth != null ? formatGp(latestNetWorth) : "—"}
          hint={history.length ? `${history.length} saved import${history.length === 1 ? "" : "s"}` : "No imports"}
        />
        <StatCard
          label="Tracking since"
          value={
            portfolio?.captureStartedAt
              ? new Date(portfolio.captureStartedAt * 1000).toLocaleDateString()
              : "—"
          }
          hint="live capture start"
        />
      </div>

      {noSources && (
        <div className="glass rounded-xl p-4 mb-5 border border-amber-500/30">
          <p className="text-sm text-amber-400">No RuneLite trade data found.</p>
          <p className="text-xs text-gray-400 mt-1 leading-relaxed">
            This reads <code className="text-gray-300">~/.runelite/flipping-copilot/</code> (live GE
            slots) and <code className="text-gray-300">~/.runelite/flipping/</code> (trade history).
            Install either plugin from the RuneLite Plugin Hub and they'll be picked up
            automatically — see Design/RUNELITE_PLUGIN_GUIDE.md.
          </p>
        </div>
      )}

      {error && <div className="glass rounded-xl p-4 mb-5 text-sm text-rose-400">{error}</div>}

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-4 mb-5">
        <div className="xl:col-span-2">
          {historyLoading ? (
            <div className="glass rounded-xl px-4 py-6 text-center text-xs text-gray-500">
              Loading net worth history…
            </div>
          ) : history.length >= 2 ? (
            <NetWorthChart history={history} />
          ) : (
            <div className="glass rounded-xl px-4 py-6 text-center text-xs text-gray-500">
              Save at least 2 bank snapshots (Bank tab) to chart net worth over time.
            </div>
          )}
        </div>
        <SessionPanel />
      </div>

      {/* DESIGN.md §14.42: the GE slots table that used to sit here is gone. It duplicated the
          live slot board on the Signals tab, and the whole point of that board is to be the ONE
          place you watch while trading ("i want this interface in 1 spot so i can actually
          monitor and not switch between tabs constantly"). Portfolio keeps what the board isn't:
          what you're holding, net worth over time, and session performance. */}
      <div className="glass rounded-xl p-4">
        <h3 className="text-sm font-medium text-gray-200 mb-3">
          Holdings{" "}
          <span className="text-xs text-gray-500 font-normal">
            unsold buys, valued at instant-sell price after tax
          </span>
        </h3>
        {!portfolio?.positions.length ? (
          <EmptyState
            title="No open positions"
            hint="Positions appear once the ledger records a buy that hasn't fully sold."
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-[11px] uppercase tracking-wide text-gray-500 text-left">
                  <th className="pb-2 pr-3 font-medium">Item</th>
                  <th className="pb-2 pr-3 font-medium text-right">Quantity</th>
                  <th className="pb-2 pr-3 font-medium text-right">Avg buy</th>
                  <th className="pb-2 pr-3 font-medium text-right">Market value</th>
                  <th className="pb-2 pr-3 font-medium text-right">Unrealized</th>
                  <th className="pb-2 font-medium text-right">ROI</th>
                </tr>
              </thead>
              <tbody>
                {portfolio.positions.map((p) => (
                  <tr
                    key={p.itemId}
                    onClick={() => openItem(p.itemId)}
                    className="border-t border-white/5 hover:bg-white/5 cursor-pointer"
                  >
                    <td className="py-2 pr-3">
                      <div className="flex items-center gap-2">
                        {p.icon && (
                          <img src={iconUrl(p.icon)} alt="" className="w-4 h-4 object-contain" />
                        )}
                        <span className="text-gray-200">{p.name}</span>
                      </div>
                    </td>
                    <td className="py-2 pr-3 text-right font-mono text-gray-300">
                      {p.quantity.toLocaleString()}
                    </td>
                    <td className="py-2 pr-3 text-right font-mono text-gray-400">
                      {formatGpFull(p.avgBuyPrice)}
                    </td>
                    <td className="py-2 pr-3 text-right font-mono text-gray-300">
                      {p.marketValue != null ? formatGp(p.marketValue) : "—"}
                    </td>
                    <td
                      className={`py-2 pr-3 text-right font-mono ${
                        (p.unrealizedProfit ?? 0) > 0
                          ? "text-emerald-400"
                          : (p.unrealizedProfit ?? 0) < 0
                            ? "text-rose-400"
                            : "text-gray-400"
                      }`}
                    >
                      {p.unrealizedProfit != null ? formatGp(p.unrealizedProfit) : "—"}
                    </td>
                    <td
                      className={`py-2 text-right font-mono ${
                        (p.unrealizedRoiPct ?? 0) > 0
                          ? "text-emerald-400"
                          : (p.unrealizedRoiPct ?? 0) < 0
                            ? "text-rose-400"
                            : "text-gray-400"
                      }`}
                    >
                      {p.unrealizedRoiPct != null ? formatPct(p.unrealizedRoiPct) : "—"}
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
