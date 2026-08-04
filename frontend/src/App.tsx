import { useEffect, useRef, useState } from "react";
import { fetchItems, fetchStatus, type MarketItem, type StatusResponse } from "./api";
import { MarketTable } from "./components/MarketTable";
import { BuySignals } from "./components/BuySignals";
import { Watchlist } from "./components/Watchlist";
import { ItemDetailModal } from "./components/ItemDetailModal";
import { GlobalSearch } from "./components/GlobalSearch";
import { BankImport } from "./components/BankImport";
import { Actions } from "./components/Actions";
import { formatAgo, formatGp } from "./format";
import { type WatchEntry, loadWatchlist, saveWatchlist } from "./watchlist";
import { type HoldingEntry, loadHoldings, saveHoldings } from "./bankHoldings";
import type { BankValueItem } from "./api";

type Tab = "market" | "signals" | "watchlist" | "bank" | "actions" | "news";

const TABS: { key: Tab; label: string }[] = [
  { key: "market", label: "Market" },
  { key: "signals", label: "Buy Signals" },
  { key: "watchlist", label: "Watchlist" },
  { key: "bank", label: "Bank" },
  { key: "actions", label: "Actions" },
  { key: "news", label: "Update News & Sentiment" },
];

function ComingSoon({ label }: { label: string }) {
  return (
    <div className="glass rounded-xl p-10 text-center text-gray-400">
      <p className="text-lg text-gray-200 mb-1">{label}</p>
      <p className="text-sm">Not built yet in this prototype — see DESIGN.md roadmap.</p>
    </div>
  );
}

function App() {
  const [tab, setTab] = useState<Tab>("market");
  const [items, setItems] = useState<MarketItem[]>([]);
  const [watchedItems, setWatchedItems] = useState<MarketItem[]>([]);
  const [heldItems, setHeldItems] = useState<MarketItem[]>([]);
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [search, setSearch] = useState("");
  const [minVolume, setMinVolume] = useState(20);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [watched, setWatchedRaw] = useState<Record<number, WatchEntry>>(() => loadWatchlist());
  const [alertBanner, setAlertBanner] = useState<string | null>(null);
  const [selectedItem, setSelectedItem] = useState<MarketItem | null>(null);
  const [holdings, setHoldings] = useState<Record<number, HoldingEntry>>(() => loadHoldings());
  const triggeredRef = useRef<Set<string>>(new Set());

  function setWatched(next: Record<number, WatchEntry>) {
    setWatchedRaw(next);
    saveWatchlist(next);
  }

  function handleHoldingsChange(items: BankValueItem[]) {
    setHoldings(saveHoldings(items));
  }

  async function load() {
    try {
      const watchedIds = Object.keys(watched).map(Number);
      const heldIds = Object.keys(holdings).map(Number);
      const [itemsRes, statusRes, watchedRes, heldRes] = await Promise.all([
        fetchItems({ minVolume, search: search || undefined }),
        fetchStatus(),
        watchedIds.length ? fetchItems({ ids: watchedIds }) : Promise.resolve({ count: 0, items: [] }),
        heldIds.length ? fetchItems({ ids: heldIds }) : Promise.resolve({ count: 0, items: [] }),
      ]);
      setItems(itemsRes.items);
      setStatus(statusRes);
      setWatchedItems(watchedRes.items);
      setHeldItems(heldRes.items);
      setError(null);

      // Check watchlist alert thresholds -- only fire once per crossing, not every poll.
      for (const w of watchedRes.items) {
        const entry = watched[w.id];
        if (!entry) continue;
        if (entry.alertAbove != null && (w.high ?? 0) >= entry.alertAbove) {
          const key = `${w.id}-above-${entry.alertAbove}`;
          if (!triggeredRef.current.has(key)) {
            triggeredRef.current.add(key);
            notify(`${w.name} crossed above ${formatGp(entry.alertAbove)}gp (now ${formatGp(w.high)}gp)`);
          }
        }
        if (entry.alertBelow != null && (w.low ?? Infinity) <= entry.alertBelow) {
          const key = `${w.id}-below-${entry.alertBelow}`;
          if (!triggeredRef.current.has(key)) {
            triggeredRef.current.add(key);
            notify(`${w.name} dropped below ${formatGp(entry.alertBelow)}gp (now ${formatGp(w.low)}gp)`);
          }
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }

  function notify(message: string) {
    setAlertBanner(message);
    if (typeof Notification !== "undefined" && Notification.permission === "granted") {
      new Notification("OSRS Flip Assistant", { body: message });
    }
  }

  function handleUseAsBankroll(value: number) {
    localStorage.setItem("bankroll", String(Math.round(value)));
    setTab("signals");
  }

  useEffect(() => {
    if (typeof Notification !== "undefined" && Notification.permission === "default") {
      Notification.requestPermission();
    }
  }, []);

  useEffect(() => {
    load();
    const interval = setInterval(load, 30_000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [minVolume, search, watched, holdings]);

  return (
    <div className="min-h-screen bg-[radial-gradient(circle_at_20%_-10%,#1e2130_0%,#0b0c10_55%)]">
      <header className="glass sticky top-0 z-20 px-6 2xl:px-10 py-3 flex items-center justify-between border-b border-white/10">
        <div className="flex items-center gap-6 2xl:gap-8">
          <h1 className="text-lg 2xl:text-xl font-semibold tracking-tight text-white">OSRS Flip Assistant</h1>
          <nav className="flex gap-1">
            {TABS.map((t) => (
              <button
                key={t.key}
                onClick={() => setTab(t.key)}
                className={`px-3 py-1.5 rounded-lg text-sm 2xl:text-base transition-colors ${
                  tab === t.key
                    ? "bg-white/10 text-white"
                    : "text-gray-400 hover:text-gray-200 hover:bg-white/5"
                }`}
              >
                {t.label}
                {t.key === "watchlist" && Object.keys(watched).length > 0 && (
                  <span className="ml-1.5 text-[10px] text-amber-400">{Object.keys(watched).length}</span>
                )}
                {t.key === "actions" && Object.keys(holdings).length > 0 && (
                  <span className="ml-1.5 text-[10px] text-sky-400">{Object.keys(holdings).length}</span>
                )}
              </button>
            ))}
          </nav>
        </div>
        <div className="flex items-center gap-4">
          <GlobalSearch onSelect={setSelectedItem} />
          <div className="text-xs 2xl:text-sm text-gray-500 font-mono whitespace-nowrap">
            {status ? `${status.itemCount} items · updated ${formatAgo(status.lastUpdate)}` : "…"}
          </div>
        </div>
      </header>

      {alertBanner && (
        <div className="bg-amber-500/15 border-b border-amber-500/30 text-amber-300 text-sm px-6 2xl:px-10 py-2 flex items-center justify-between">
          <span>🔔 {alertBanner}</span>
          <button onClick={() => setAlertBanner(null)} className="text-amber-400 hover:text-amber-200">
            ✕
          </button>
        </div>
      )}

      <main className="px-6 2xl:px-10 py-6 2xl:py-8 max-w-[1600px] 2xl:max-w-[2200px] mx-auto">
        {tab === "market" && (
          <>
            <div className="flex items-center gap-3 mb-4">
              <input
                type="text"
                placeholder="Filter market table…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="glass rounded-lg px-3 py-2 text-sm 2xl:text-base text-gray-100 placeholder:text-gray-500 outline-none focus:border-white/20 w-64 2xl:w-80"
              />
              <label className="text-xs 2xl:text-sm text-gray-400 flex items-center gap-2">
                Min liquidity/hr
                <input
                  type="number"
                  value={minVolume}
                  onChange={(e) => setMinVolume(Number(e.target.value) || 0)}
                  className="glass rounded-lg px-2 py-1 text-sm 2xl:text-base text-gray-100 w-20 outline-none"
                />
              </label>
              {loading && <span className="text-xs text-gray-500">Loading…</span>}
              {error && <span className="text-xs text-rose-400">{error}</span>}
            </div>
            <MarketTable items={items} watched={watched} setWatched={setWatched} onSelectItem={setSelectedItem} />
          </>
        )}
        {tab === "signals" && <BuySignals items={items} onSelectItem={setSelectedItem} />}
        {tab === "watchlist" && (
          <Watchlist items={watchedItems} watched={watched} setWatched={setWatched} onSelectItem={setSelectedItem} />
        )}
        {tab === "bank" && (
          <BankImport onUseAsBankroll={handleUseAsBankroll} onHoldingsChange={handleHoldingsChange} />
        )}
        {tab === "actions" && (
          <Actions items={items} heldItems={heldItems} holdings={holdings} onSelectItem={setSelectedItem} />
        )}
        {tab === "news" && <ComingSoon label="Update News & Sentiment" />}
      </main>

      {selectedItem && (
        <ItemDetailModal item={selectedItem} holding={holdings[selectedItem.id]} onClose={() => setSelectedItem(null)} />
      )}
    </div>
  );
}

export default App;
