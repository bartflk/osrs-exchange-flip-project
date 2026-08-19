import { useEffect, useRef, useState } from "preact/hooks";
import {
  fetchItems,
  fetchStatus,
  fetchAlerts,
  type MarketItem,
  type StatusResponse,
  type PriceAlert,
} from "./api";
import { MarketTable } from "./components/MarketTable";
import { BuySignals } from "./components/BuySignals";
import { Portfolio } from "./components/Portfolio";
import { Flips } from "./components/Flips";
import { ItemDetailModal } from "./components/ItemDetailModal";
import { GlobalSearch } from "./components/GlobalSearch";
import { BankImport } from "./components/BankImport";
import { Actions } from "./components/Actions";
import { MarketAlerts } from "./components/MarketAlerts";
import { TrackRecord } from "./components/TrackRecord";
import { NewsFeed } from "./components/NewsFeed";
import { ResearchReport } from "./components/ResearchReport";
import { Sets } from "./components/Sets";
import { TrendLeaderboard } from "./components/TrendLeaderboard";
import { SubstitutionFlags } from "./components/SubstitutionFlags";
import { SectorIndices } from "./components/SectorIndices";
import { UpdateCycleBadge } from "./components/UpdateCycleBadge";
import { MarketTemperatureGauge } from "./components/MarketTemperatureGauge";
import { SettingsModal } from "./components/SettingsModal";
import { ToastHost } from "./components/ToastHost";
import { showToast } from "./toast";
import { formatAgo, formatGp } from "./format";
import { type WatchEntry, loadWatchlist, saveWatchlist, toggleWatch, updateWatchAlert } from "./watchlist";
import { type BlockEntry, loadBlocklist, saveBlocklist, removeFromBlocklist } from "./blocklist";
import { type HoldingEntry, loadHoldings, saveHoldings } from "./bankHoldings";
import { type Settings, loadSettings, saveSettings } from "./settings";
import type { BankValueItem } from "./api";
import { Button, Chip, IconButton, Input, NumberInput, StatCard } from "./components/ui";

type Tab = "market" | "signals" | "portfolio" | "flips" | "bank" | "actions" | "sets" | "news";

// Ordered to follow the actual workflow: browse (Market) -> decide what to buy (Signals) ->
// track what you're holding/have open (Portfolio) -> value your bank (Bank) -> act on it
// (Actions) -> specialized arbitrage tool (Sets) -> background context (News). Labels
// standardized to single words to match Market/Bank/Actions/Sets rather than mixing verbose
// phrases in with them.
const TABS: { key: Tab; label: string }[] = [
  { key: "market", label: "Market" },
  { key: "signals", label: "Signals" },
  { key: "portfolio", label: "Portfolio" },
  { key: "flips", label: "Flips" },
  { key: "bank", label: "Bank" },
  { key: "actions", label: "Actions" },
  { key: "sets", label: "Sets" },
  { key: "news", label: "News" },
];

function App() {
  const [tab, setTab] = useState<Tab>("market");
  const [items, setItems] = useState<MarketItem[]>([]);
  const [heldItems, setHeldItems] = useState<MarketItem[]>([]);
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [search, setSearch] = useState("");
  const [settings, setSettingsRaw] = useState<Settings>(() => loadSettings());
  const [minVolume, setMinVolume] = useState(() => loadSettings().defaultMinLiquidity);
  const [preset, setPreset] = useState<"none" | "volume" | "taxfree" | "pvm">("none");
  const [f2pOnly, setF2pOnly] = useState(false);
  const [watchedOnly, setWatchedOnly] = useState(false);
  const [minPrice, setMinPrice] = useState("");
  const [maxPrice, setMaxPrice] = useState("");
  const [showSettings, setShowSettings] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [watched, setWatchedRaw] = useState<Record<number, WatchEntry>>(() => loadWatchlist());
  const [blocked, setBlockedRaw] = useState<Record<number, BlockEntry>>(() => loadBlocklist());
  const [selectedItem, setSelectedItem] = useState<MarketItem | null>(null);
  const [holdings, setHoldings] = useState<Record<number, HoldingEntry>>(() => loadHoldings());
  const [alerts, setAlerts] = useState<PriceAlert[]>([]);
  const [alertItems, setAlertItems] = useState<MarketItem[]>([]);
  const triggeredRef = useRef<Set<string>>(new Set());
  const notifiedAlertIds = useRef<Set<string>>(new Set());

  // DESIGN.md §12.1 item 5 / §4.5: named filter presets, sourced from OSRS Exchange's own
  // published filter advice ("high volume: min vol 100k + min buy limit 10k," "high value PvM:
  // min vol 50," "tax-free: max tax 0"). minVolume is a backend query param (liquidity); buy
  // limit/tax presets are applied client-side since the backend doesn't filter on those.
  function applyPreset(next: "none" | "volume" | "taxfree" | "pvm") {
    setPreset((current) => (current === next ? "none" : next));
    if (next === "volume") setMinVolume(100_000);
    else if (next === "pvm") setMinVolume(50);
  }

  const hasActiveFilters =
    preset !== "none" ||
    f2pOnly ||
    watchedOnly ||
    minPrice !== "" ||
    maxPrice !== "" ||
    search !== "" ||
    minVolume !== loadSettings().defaultMinLiquidity;

  function clearFilters() {
    setPreset("none");
    setF2pOnly(false);
    setWatchedOnly(false);
    setMinPrice("");
    setMaxPrice("");
    setSearch("");
    setMinVolume(loadSettings().defaultMinLiquidity);
  }

  const marketItems = items.filter((i) => {
    if (preset === "volume" && (i.buy_limit ?? 0) < 10_000) return false;
    if (preset === "taxfree" && (i.tax ?? 0) !== 0) return false;
    if (minPrice !== "" && (i.high ?? 0) < Number(minPrice)) return false;
    if (maxPrice !== "" && (i.high ?? 0) > Number(maxPrice)) return false;
    if (watchedOnly && !watched[i.id]) return false;
    return true;
  });

  const marketStats = {
    count: marketItems.length,
    avgMargin: marketItems.length
      ? marketItems.reduce((sum, i) => sum + (i.net_margin ?? 0), 0) / marketItems.length
      : 0,
    profitable: marketItems.filter((i) => (i.net_margin ?? 0) > 0).length,
  };

  function setWatched(next: Record<number, WatchEntry>) {
    setWatchedRaw(next);
    saveWatchlist(next);
  }

  function setBlocked(next: Record<number, BlockEntry>) {
    setBlockedRaw(next);
    saveBlocklist(next);
  }

  function handleRemoveBlock(itemId: number) {
    setBlocked(removeFromBlocklist(blocked, itemId));
  }

  function setSettings(next: Settings) {
    setSettingsRaw(next);
    saveSettings(next);
  }

  function handleHoldingsChange(items: BankValueItem[]) {
    setHoldings(saveHoldings(items));
  }

  async function load() {
    try {
      const watchedIds = Object.keys(watched).map(Number);
      const heldIds = Object.keys(holdings).map(Number);
      const [itemsRes, statusRes, watchedRes, heldRes, alertsRes] = await Promise.all([
        fetchItems({
          minVolume,
          search: search || undefined,
          membersOnly: f2pOnly ? false : undefined,
        }),
        fetchStatus(),
        watchedIds.length
          ? fetchItems({ ids: watchedIds })
          : Promise.resolve({ count: 0, items: [] }),
        heldIds.length ? fetchItems({ ids: heldIds }) : Promise.resolve({ count: 0, items: [] }),
        fetchAlerts(),
      ]);
      setItems(itemsRes.items);
      setStatus(statusRes);
      setHeldItems(heldRes.items);
      setAlerts(alertsRes.alerts);
      setError(null);

      // Market-wide crash/spike alerts can fire for items outside the Market tab's current
      // filter, so fetch them by id directly (same pattern as watched/held) rather than relying
      // on `items` to happen to contain them.
      const alertItemIds = [...new Set(alertsRes.alerts.map((a) => a.itemId))];
      if (alertItemIds.length) {
        fetchItems({ ids: alertItemIds })
          .then((res) => setAlertItems(res.items))
          .catch(() => {});
      }

      // Notify once per alert id, not every 30s while it's still in the recent-alerts list.
      // Batched into a single OS notification per poll cycle, not one-per-alert -- several
      // alerts can legitimately land in the same 30s tick (or, if the backend's anomaly
      // filters ever regress, many bogus ones at once), and firing a separate `Notification`
      // per item is what actually floods the OS notification center either way.
      const newAlerts = alertsRes.alerts.filter((a) => !notifiedAlertIds.current.has(a.id));
      for (const a of newAlerts) notifiedAlertIds.current.add(a.id);
      if (newAlerts.length === 1) {
        const a = newAlerts[0];
        const message =
          a.kind === "volume"
            ? `⚠ ${a.name}: unusual volume (z=${a.zScore?.toFixed(1) ?? "?"}) vs its own 24h baseline — possible bot activity`
            : `${a.direction === "crash" ? "▼" : "▲"} ${a.name} ${a.direction === "crash" ? "dropped" : "spiked"} ${Math.abs(a.changePct * 100).toFixed(1)}% in ${a.windowMinutes}m (${formatGp(a.fromPrice)} → ${formatGp(a.toPrice)})`;
        notify(message, "market");
      } else if (newAlerts.length > 1) {
        const names = newAlerts
          .slice(0, 3)
          .map((a) => a.name)
          .join(", ");
        const rest = newAlerts.length > 3 ? ` +${newAlerts.length - 3} more` : "";
        notify(`${newAlerts.length} new market alerts: ${names}${rest}`, "market");
      }

      // Check watchlist alert thresholds -- only fire once per crossing, not every poll.
      for (const w of watchedRes.items) {
        const entry = watched[w.id];
        if (!entry) continue;
        if (entry.alertAbove != null && (w.high ?? 0) >= entry.alertAbove) {
          const key = `${w.id}-above-${entry.alertAbove}`;
          if (!triggeredRef.current.has(key)) {
            triggeredRef.current.add(key);
            notify(
              `${w.name} crossed above ${formatGp(entry.alertAbove)}gp (now ${formatGp(w.high)}gp)`,
              "watchlist",
            );
          }
        }
        if (entry.alertBelow != null && (w.low ?? Infinity) <= entry.alertBelow) {
          const key = `${w.id}-below-${entry.alertBelow}`;
          if (!triggeredRef.current.has(key)) {
            triggeredRef.current.add(key);
            notify(
              `${w.name} dropped below ${formatGp(entry.alertBelow)}gp (now ${formatGp(w.low)}gp)`,
              "watchlist",
            );
          }
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }

  function notify(message: string, source: "market" | "watchlist") {
    if (source === "market" && settings.muteMarketAlerts) return;
    if (source === "watchlist" && settings.muteWatchlistAlerts) return;
    // Was a persistent top-of-page banner -- consolidated onto the same toast surface the rest
    // of the app already uses for "your click did something" feedback, so alerts don't fight
    // with the MarketAlerts ticker (also top-of-page) for the same visual real estate. Longer
    // duration than the default toast since this is genuinely worth noticing, not a click ack.
    showToast(message, "neutral", 6000);
    if (typeof Notification !== "undefined" && Notification.permission === "granted") {
      new Notification("Project Flashwave", { body: message });
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

  // DESIGN.md §14.21/§14.22: manual refresh button. A self-rescheduling setTimeout (not
  // setInterval) so a manual refresh can clear and restart the cycle cleanly -- with a plain
  // setInterval, clicking refresh wouldn't push back the *next* auto-fire, so you'd sometimes
  // see two loads a few seconds apart. The displayed countdown is driven by the backend's real
  // poll timestamp (status.nextPricePollAt below), not this tab's own fetch cadence.
  const [nowTick, setNowTick] = useState<number>(Date.now());
  const [refreshing, setRefreshing] = useState(false);
  const refreshTimeoutRef = useRef<number | null>(null);

  function runRefreshCycle() {
    if (refreshTimeoutRef.current != null) {
      clearTimeout(refreshTimeoutRef.current);
      refreshTimeoutRef.current = null;
    }
    setRefreshing(true);
    load().finally(() => {
      setRefreshing(false);
      refreshTimeoutRef.current = window.setTimeout(
        runRefreshCycle,
        settings.refreshIntervalSec * 1000,
      );
    });
  }

  useEffect(() => {
    runRefreshCycle();
    return () => {
      if (refreshTimeoutRef.current != null) clearTimeout(refreshTimeoutRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [minVolume, search, watched, holdings, settings, f2pOnly]);

  // UI-only ticker for the countdown display -- doesn't touch the actual poll schedule above.
  useEffect(() => {
    const id = setInterval(() => setNowTick(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  // DESIGN.md §14.22: driven by the backend's real poll timestamp (status.nextPricePollAt), not
  // a frontend-side guess derived from this tab's own fetch cadence -- those two clocks have no
  // fixed relationship to each other, which is exactly why the old version looked "out of sync."
  const secondsUntilPricePoll =
    status?.nextPricePollAt != null
      ? Math.max(0, Math.round((status.nextPricePollAt - nowTick) / 1000))
      : null;

  return (
    <div className="min-h-screen bg-[radial-gradient(circle_at_15%_-15%,rgba(168,85,247,0.20)_0%,transparent_40%),radial-gradient(circle_at_100%_0%,rgba(56,132,255,0.14)_0%,transparent_35%),radial-gradient(circle_at_20%_-10%,#1e2130_0%,#0b0c10_55%)]">
      <header className="glass sticky top-0 z-20 px-6 2xl:px-10 py-3 flex items-center justify-between border-b border-white/10">
        <div className="flex items-center gap-6 2xl:gap-8">
          <h1 className="text-lg 2xl:text-xl font-semibold tracking-tight bg-gradient-to-r from-violet-400 via-fuchsia-400 to-sky-400 bg-clip-text text-transparent">
            Project Flashwave
          </h1>
          <nav className="flex gap-1">
            {TABS.map((t) => (
              <button
                key={t.key}
                onClick={() => setTab(t.key)}
                className={`relative px-3 py-1.5 rounded-lg text-sm 2xl:text-base font-medium transition-colors border ${
                  tab === t.key
                    ? "bg-gradient-to-r from-violet-500/20 to-sky-500/10 text-white border-violet-400/30"
                    : "text-gray-400 hover:text-gray-200 hover:bg-white/5 border-transparent"
                }`}
              >
                {t.label}
                {t.key === "actions" && Object.keys(holdings).length > 0 && (
                  <span className="ml-1.5 inline-flex items-center justify-center min-w-[1.1rem] h-[1.1rem] px-1 rounded-full text-[10px] font-semibold bg-violet-500/20 text-violet-300">
                    {Object.keys(holdings).length}
                  </span>
                )}
              </button>
            ))}
          </nav>
        </div>
        <div className="flex items-center gap-4">
          <GlobalSearch onSelect={setSelectedItem} />
          <div
            className="flex items-center gap-1.5 text-xs 2xl:text-sm text-gray-500 font-mono whitespace-nowrap"
            title="Live data from the local backend poller"
          >
            <span
              className={`w-1.5 h-1.5 rounded-full ${status ? "bg-emerald-400" : "bg-gray-600"}`}
            />
            {status
              ? `${status.itemCount.toLocaleString()} items · ${formatAgo(status.lastUpdate)}`
              : "connecting…"}
            {secondsUntilPricePoll != null && (
              <>
                <span className="text-gray-600">·</span>
                <span title="Time until the backend's next real 60s Wiki API poll">
                  data in {secondsUntilPricePoll}s
                </span>
              </>
            )}
          </div>
          <IconButton
            onClick={runRefreshCycle}
            disabled={refreshing}
            title="Refresh now"
            className={refreshing ? "animate-spin" : ""}
          >
            ⟳
          </IconButton>
          <IconButton onClick={() => setShowSettings(true)} title="Settings">
            ⚙
          </IconButton>
        </div>
      </header>

      <MarketAlerts alerts={alerts} items={alertItems} onSelectItem={setSelectedItem} />

      <main className="px-6 2xl:px-10 py-6 2xl:py-8 max-w-[1600px] 2xl:max-w-[2200px] mx-auto">
        {tab === "market" && (
          <>
            <div className="mb-3">
              <MarketTemperatureGauge />
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 mb-5">
              <StatCard label="Items shown" value={marketStats.count.toLocaleString()} />
              <StatCard
                label="Profitable"
                value={marketStats.profitable.toLocaleString()}
                tone={marketStats.profitable > 0 ? "success" : "neutral"}
                hint={
                  marketStats.count
                    ? `${Math.round((marketStats.profitable / marketStats.count) * 100)}% of shown`
                    : undefined
                }
              />
              <StatCard
                label="Avg net margin"
                value={formatGp(marketStats.avgMargin)}
                tone={marketStats.avgMargin >= 0 ? "success" : "danger"}
              />
              <StatCard
                label="Data freshness"
                value={status ? formatAgo(status.lastUpdate) : "—"}
                hint={status ? `${status.itemCount.toLocaleString()} tracked items` : undefined}
              />
              <UpdateCycleBadge />
            </div>

            <div className="glass rounded-xl p-3 mb-4 flex flex-wrap items-end gap-x-4 gap-y-3">
              <div className="flex flex-col gap-1">
                <label className="text-[10px] uppercase tracking-wider text-gray-500 font-medium">
                  Search
                </label>
                <div className="relative">
                  <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-500 text-xs pointer-events-none">
                    ⌕
                  </span>
                  <Input
                    type="text"
                    placeholder="Find an item…"
                    value={search}
                    onInput={(e) => setSearch((e.target as HTMLInputElement).value)}
                    className="w-56 2xl:w-72 pl-7"
                  />
                </div>
              </div>

              <div className="flex flex-col gap-1">
                <label className="text-[10px] uppercase tracking-wider text-gray-500 font-medium">
                  Min liquidity/hr
                </label>
                <NumberInput
                  value={minVolume}
                  onChange={setMinVolume}
                  zeroDisplaysBlank
                  placeholder="0"
                  className="w-28"
                />
              </div>

              <div className="flex flex-col gap-1">
                <label className="text-[10px] uppercase tracking-wider text-gray-500 font-medium">
                  Price range (gp)
                </label>
                <div className="flex items-center gap-1.5">
                  <Input
                    type="text"
                    inputMode="numeric"
                    placeholder="Min"
                    value={minPrice}
                    onInput={(e) => {
                      const v = (e.target as HTMLInputElement).value;
                      if (/^\d*$/.test(v)) setMinPrice(v);
                    }}
                    className="w-24"
                  />
                  <span className="text-gray-600 text-xs">–</span>
                  <Input
                    type="text"
                    inputMode="numeric"
                    placeholder="Max"
                    value={maxPrice}
                    onInput={(e) => {
                      const v = (e.target as HTMLInputElement).value;
                      if (/^\d*$/.test(v)) setMaxPrice(v);
                    }}
                    className="w-24"
                  />
                </div>
              </div>

              <div className="flex flex-col gap-1">
                <label className="text-[10px] uppercase tracking-wider text-gray-500 font-medium">
                  Membership
                </label>
                <Chip active={f2pOnly} onClick={() => setF2pOnly((v) => !v)}>
                  {f2pOnly ? "F2P only" : "All items"}
                </Chip>
              </div>

              <div className="flex flex-col gap-1">
                <label className="text-[10px] uppercase tracking-wider text-gray-500 font-medium">
                  Pinned
                </label>
                <Chip active={watchedOnly} onClick={() => setWatchedOnly((v) => !v)}>
                  ★ Watched{Object.keys(watched).length > 0 ? ` (${Object.keys(watched).length})` : ""}
                </Chip>
              </div>

              <div className="flex flex-col gap-1 flex-1 min-w-[220px]">
                <label className="text-[10px] uppercase tracking-wider text-gray-500 font-medium">
                  Presets
                </label>
                <div className="flex items-center gap-1.5 flex-wrap">
                  {(
                    [
                      { key: "volume", label: "High volume" },
                      { key: "pvm", label: "High-value PvM" },
                      { key: "taxfree", label: "Tax-free starter" },
                    ] as const
                  ).map((p) => (
                    <Chip key={p.key} active={preset === p.key} onClick={() => applyPreset(p.key)}>
                      {p.label}
                    </Chip>
                  ))}
                </div>
              </div>

              {hasActiveFilters && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={clearFilters}
                  className="ml-auto self-end"
                >
                  ✕ Clear filters
                </Button>
              )}
            </div>

            {loading && marketItems.length === 0 && (
              <div className="text-xs text-gray-500 mb-2">Loading market data…</div>
            )}
            {error && <div className="text-xs text-rose-400 mb-2">{error}</div>}

            <MarketTable
              items={marketItems}
              watched={watched}
              setWatched={setWatched}
              blocked={blocked}
              setBlocked={setBlocked}
              onSelectItem={setSelectedItem}
              hasActiveFilters={hasActiveFilters}
              onClearFilters={clearFilters}
            />

            {/* Secondary/browsing panels sit below the primary table, not above it -- the price
                table is what you're here for; leaderboards/indices/substitution flags are for
                when you're curious, not the first thing that should compete for attention. */}
            <div className="mt-6 space-y-4">
              <TrendLeaderboard items={items} onSelectItem={setSelectedItem} />
              <SectorIndices />
              <SubstitutionFlags items={items} onSelectItem={setSelectedItem} />
            </div>
          </>
        )}
        {tab === "signals" && (
          <>
            <TrackRecord />
            <BuySignals
              items={items.filter((i) => !blocked[i.id])}
              onSelectItem={setSelectedItem}
            />
          </>
        )}
        {tab === "portfolio" && <Portfolio items={items} onSelectItem={setSelectedItem} />}
        {tab === "flips" && <Flips items={items} onSelectItem={setSelectedItem} />}
        {tab === "bank" && (
          <BankImport
            onUseAsBankroll={handleUseAsBankroll}
            onHoldingsChange={handleHoldingsChange}
          />
        )}
        {tab === "actions" && (
          <Actions
            items={items}
            heldItems={heldItems}
            womUsername={settings.womUsername}
            holdings={holdings}
            onSelectItem={setSelectedItem}
          />
        )}
        {tab === "sets" && <Sets />}
        {tab === "news" && (
          <>
            <ResearchReport />
            <NewsFeed />
          </>
        )}
      </main>

      {selectedItem && (
        <ItemDetailModal
          item={selectedItem}
          holding={holdings[selectedItem.id]}
          watchEntry={watched[selectedItem.id]}
          onToggleWatch={() => setWatched(toggleWatch(watched, selectedItem.id))}
          onUpdateAlert={(patch) => setWatched(updateWatchAlert(watched, selectedItem.id, patch))}
          onClose={() => setSelectedItem(null)}
        />
      )}

      {showSettings && (
        <SettingsModal
          settings={settings}
          onChange={setSettings}
          onClose={() => setShowSettings(false)}
          blocklist={blocked}
          onRemoveBlock={handleRemoveBlock}
        />
      )}

      <ToastHost />
    </div>
  );
}

export default App;
