import { useEffect, useRef, useState } from "preact/hooks";
import {
  fetchIndexMembers,
  fetchItems,
  fetchStatus,
  fetchAlerts,
  type MarketItem,
  type StatusResponse,
  type PriceAlert,
} from "./api";
import { MarketTable } from "./components/MarketTable";
import { Sidebar } from "./components/Sidebar";
import { BuySignals } from "./components/BuySignals";
import { OvernightTrading } from "./components/OvernightTrading";
import { Portfolio } from "./components/Portfolio";
import { Flips } from "./components/Flips";
import { ItemDetailModal } from "./components/ItemDetailModal";
import { GlobalSearch } from "./components/GlobalSearch";
import { BankImport } from "./components/BankImport";
import { MarketAlerts } from "./components/MarketAlerts";
import { TrackRecord } from "./components/TrackRecord";
import { NewsFeed } from "./components/NewsFeed";
import { UpdateSensitivity } from "./components/UpdateSensitivity";
import { ResearchReport } from "./components/ResearchReport";
import { Sets } from "./components/Sets";
import { MarketHighlights } from "./components/MarketHighlights";
import { MarketIndices } from "./components/MarketIndices";
import { UpdateCycleBadge } from "./components/UpdateCycleBadge";
import { MarketTemperatureGauge } from "./components/MarketTemperatureGauge";
import { SettingsModal } from "./components/SettingsModal";
import { ToastHost } from "./components/ToastHost";
import { showToast } from "./toast";
import { formatAgo, formatGp, parseGpShorthand } from "./format";
import {
  type WatchEntry,
  loadWatchlist,
  saveWatchlist,
  toggleWatch,
  updateWatchAlert,
} from "./watchlist";
import { type BlockEntry, loadBlocklist, saveBlocklist, removeFromBlocklist } from "./blocklist";
import { type HoldingEntry, loadHoldings, saveHoldings } from "./bankHoldings";
import { type Settings, loadSettings, saveSettings } from "./settings";
import type { BankValueItem } from "./api";
import { MoneyMakers } from "./components/MoneyMakers";
import { ConnectionBanner } from "./components/ConnectionBanner";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { Skilling } from "./components/Skilling";
import { Lists } from "./components/Lists";
import { loadLists, createList, type ItemList } from "./lists";
import {
  Button,
  Chip,
  Field,
  IconButton,
  Input,
  NumberInput,
  Toolbar,
  NavDropdown,
  NavDropdownItem,
} from "./components/ui";

type Tab =
  | "market"
  | "signals"
  | "overnight"
  | "moneymakers"
  | "skilling"
  | "lists"
  | "portfolio"
  | "flips"
  | "bank"
  | "sets"
  | "news";

// The tab KEY stays "signals" even though the label is now "Active flipping": it is persisted in
// localStorage and deep-linked from other tabs, so renaming it would silently drop everyone back
// to Market on their next load. The label is what the user reads; the key is plumbing.
const TAB_LABELS: Record<Tab, string> = {
  market: "Market",
  signals: "Active flipping",
  overnight: "Overnight",
  moneymakers: "Money makers",
  skilling: "Skilling",
  lists: "Lists",
  portfolio: "Portfolio",
  flips: "Flips",
  bank: "Bank",
  sets: "Sets",
  news: "News",
};

// Direct request: the flat tab row was growing every time a page was added (10 tabs before
// "Lists"), so grouped into dropdown categories the same way FlipSmart's header does
// (Dashboard / Analytics ▾ / Flipping Tools ▾ / Resources ▾). "Market" stays a plain link since
// it's the default landing page; everything else groups by what it's actually for: finding/
// acting on a flip right now, reviewing your own holdings, or background reading.
//
// DESIGN.md: the "Actions" tab (bad-holding alerts + a Buy Signals teaser + idle-time activity
// suggestions) was removed -- direct feedback: none of its sections did anything the rest of the
// app didn't already do better, and two of the three needed optional setup (Bank import, WOM
// username) to show anything at all. A real, distinct replacement idea was floated -- an alert
// when official news says an item is getting nerfed and you hold it -- but that's unbuilt, not a
// port of what was here.
const NAV_GROUPS: { label: string; tabs: Tab[] }[] = [
  {
    label: "Flipping Tools",
    tabs: ["signals", "overnight", "moneymakers", "skilling", "sets", "lists"],
  },
  { label: "Analytics", tabs: ["portfolio", "flips", "bank"] },
  { label: "Resources", tabs: ["news"] },
];

// What the price-range fields will accept while you type. Digits and separators plus an optional
// trailing k/m/b, so "10m" can be entered a character at a time; the old rule was digits only,
// which rejected the "m" keystroke outright and made shorthand impossible rather than merely
// unsupported.
const SHORTHAND_RE = /^[\d,.]*[kKmMbB]?$/;

const LISTS_SEEDED_KEY = "itemLists_seeded_v1";

// Direct request: "make some good ones as a start." Computed from real, currently-loaded data
// (not hardcoded ids, which would go stale the moment prices moved) the first time real items
// exist and no lists have been created yet. Mirrors settings.ts's one-time-migration pattern
// (MIN_LIQ_MIGRATION_KEY) so this only ever runs once, not on every load.
function seedStarterLists(items: MarketItem[]): ItemList[] {
  const positive = items.filter((i) => (i.net_margin ?? 0) > 0);
  const topBy = (pool: MarketItem[], key: (i: MarketItem) => number, n: number) =>
    [...pool].sort((a, b) => key(b) - key(a)).slice(0, n).map((i) => i.id);

  let lists: ItemList[] = [];
  lists = createList(
    lists,
    "High Volume Flips",
    topBy(positive, (i) => i.liquidity, 20),
  );
  lists = createList(
    lists,
    "Passive Flips (10m+)",
    topBy(
      positive.filter((i) => (i.low ?? 0) >= 10_000_000),
      (i) => i.net_margin ?? 0,
      20,
    ),
  );
  lists = createList(
    lists,
    "Tax-Free Flips",
    topBy(
      positive.filter((i) => (i.tax ?? 0) === 0),
      (i) => i.net_margin ?? 0,
      20,
    ),
  );
  lists = createList(
    lists,
    "High-Value PvM Gear",
    topBy(
      positive.filter((i) => i.liquidity >= 1 && i.liquidity <= 50 && (i.low ?? 0) >= 1_000_000),
      (i) => i.net_margin ?? 0,
      20,
    ),
  );
  return lists;
}

function App() {
  const [tab, setTab] = useState<Tab>("market");
  const [items, setItems] = useState<MarketItem[]>([]);
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [search, setSearch] = useState("");
  const [settings, setSettingsRaw] = useState<Settings>(() => loadSettings());
  const [minVolume, setMinVolume] = useState(() => loadSettings().defaultMinLiquidity);
  const [preset, setPreset] = useState<"none" | "volume" | "taxfree" | "pvm">("none");
  // Index membership filter, kept SEPARATE from the presets rather than folded into them. A preset
  // is a saved view the user builds; an index is a fact about the market. They compose -- "high
  // volume items, within ranged weapons" is a reasonable thing to ask for -- and merging them into
  // one exclusive control would have made that impossible.
  const [activeIndex, setActiveIndex] = useState<{ key: string; label: string } | null>(null);
  const [indexItemIds, setIndexItemIds] = useState<Set<number> | null>(null);
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
    // Toggling a preset OFF restores the liquidity default. It used to set minVolume on the way in
    // and leave it there on the way out, so turning "High volume" off left the table still capped
    // at 100,000 with no control showing why: eleven rows, no active preset, and nothing on screen
    // accounting for the difference.
    const turningOff = preset === next;
    setPreset(turningOff ? "none" : next);
    if (turningOff) setMinVolume(loadSettings().defaultMinLiquidity);
    else if (next === "volume") setMinVolume(100_000);
    else if (next === "pvm") setMinVolume(50);
  }

  const hasActiveFilters =
    activeIndex !== null ||
    preset !== "none" ||
    f2pOnly ||
    watchedOnly ||
    minPrice !== "" ||
    maxPrice !== "" ||
    search !== "" ||
    minVolume !== loadSettings().defaultMinLiquidity;

  function clearFilters() {
    setActiveIndex(null);
    setIndexItemIds(null);
    setPreset("none");
    setF2pOnly(false);
    setWatchedOnly(false);
    setMinPrice("");
    setMaxPrice("");
    setSearch("");
    setMinVolume(loadSettings().defaultMinLiquidity);
  }

  const marketItems = items.filter((i) => {
    // Not filtered again here: when an index is active the fetch above already asked for exactly
    // these ids, and re-filtering would be a second chance to get it wrong.
    if (preset === "volume" && (i.buy_limit ?? 0) < 10_000) return false;
    if (preset === "taxfree" && (i.tax ?? 0) !== 0) return false;
    // parseGpShorthand, not Number: the fields accept "10m" and "250k", and Number("10m") is NaN,
    // which compares false against everything and would silently disable the filter.
    const min = minPrice !== "" ? parseGpShorthand(minPrice) : null;
    const max = maxPrice !== "" ? parseGpShorthand(maxPrice) : null;
    if (min != null && (i.high ?? 0) < min) return false;
    if (max != null && (i.high ?? 0) > max) return false;
    if (watchedOnly && !watched[i.id]) return false;
    return true;
  });

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
      const [itemsRes, statusRes, watchedRes, alertsRes] = await Promise.all([
        // An index selection fetches its members BY ID rather than filtering the default page.
        // /api/items returns a capped 300 rows, so client-side filtering could only ever show the
        // basket's members that happened to be in that page -- 2 of the Chambers of Xeric 14,
        // since the other twelve are too thin to make the default cut.
        indexItemIds
          ? fetchItems({ ids: [...indexItemIds] })
          : fetchItems({
              minVolume,
              search: search || undefined,
              membersOnly: f2pOnly ? false : undefined,
            }),
        fetchStatus(),
        watchedIds.length
          ? fetchItems({ ids: watchedIds })
          : Promise.resolve({ count: 0, items: [] }),
        fetchAlerts(),
      ]);
      setItems(itemsRes.items);
      setStatus(statusRes);
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
            ? `⚠ ${a.name}: unusual volume (z=${a.zScore?.toFixed(1) ?? "?"}) vs its own 24h baseline, possible bot activity`
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

  useEffect(() => {
    if (items.length === 0) return;
    if (localStorage.getItem(LISTS_SEEDED_KEY)) return;
    if (loadLists().length > 0) {
      localStorage.setItem(LISTS_SEEDED_KEY, "1");
      return;
    }
    seedStarterLists(items);
    localStorage.setItem(LISTS_SEEDED_KEY, "1");
  }, [items]);

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
  }, [minVolume, search, watched, holdings, settings, f2pOnly, indexItemIds]);

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
            <button
              onClick={() => setTab("market")}
              className={`px-3 py-1.5 rounded-lg text-sm 2xl:text-base font-medium transition-colors border ${
                tab === "market"
                  ? "bg-gradient-to-r from-violet-500/20 to-sky-500/10 text-white border-violet-400/30"
                  : "text-gray-400 hover:text-gray-200 hover:bg-white/5 border-transparent"
              }`}
            >
              Dashboard
            </button>
            {NAV_GROUPS.map((group) => (
              <NavDropdown key={group.label} label={group.label} active={group.tabs.includes(tab)}>
                {group.tabs.map((key) => (
                  <NavDropdownItem key={key} active={tab === key} onClick={() => setTab(key)}>
                    {TAB_LABELS[key]}
                  </NavDropdownItem>
                ))}
              </NavDropdown>
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

      {/* Audit finding: a failed poll only ever showed one line of small red text above the table,
          while the stale prices on screen carried on looking live. This says so, and reloads by
          itself when the server comes back, which is the refresh you used to do by hand. */}
      <ConnectionBanner onReconnect={runRefreshCycle} />

      <MarketAlerts alerts={alerts} items={alertItems} onSelectItem={setSelectedItem} />

      {/* Per-page, not just at the root: a crash inside one tab keeps the header and the nav
          alive, so you can move to another page instead of losing the whole app. Keyed by tab so
          switching tabs clears a caught error rather than stranding you on the panel. */}
      <main className="px-6 2xl:px-10 py-6 2xl:py-8 max-w-[1600px] 2xl:max-w-[2200px] mx-auto">
        <ErrorBoundary key={tab} label={TAB_LABELS[tab]}>
        {tab === "market" && (
          <>
            <div className="mb-3">
              <MarketTemperatureGauge />
            </div>
            <Toolbar>
              <Field label="Search">
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
              </Field>

              <Field label="Min liquidity/hr" explain="liquidity">
                <NumberInput
                  value={minVolume}
                  onChange={setMinVolume}
                  zeroDisplaysBlank
                  placeholder="0"
                  className="w-28"
                />
              </Field>

              <Field label="Price range (gp)">
                <Input
                  type="text"
                  inputMode="text"
                  placeholder="Min, e.g. 10m"
                  value={minPrice}
                  onInput={(e) => {
                    const v = (e.target as HTMLInputElement).value;
                    if (SHORTHAND_RE.test(v)) setMinPrice(v);
                  }}
                  className="w-24"
                />
                <span className="text-gray-600 text-xs">–</span>
                <Input
                  type="text"
                  inputMode="text"
                  placeholder="Max, e.g. 500k"
                  value={maxPrice}
                  onInput={(e) => {
                    const v = (e.target as HTMLInputElement).value;
                    if (SHORTHAND_RE.test(v)) setMaxPrice(v);
                  }}
                  className="w-24"
                />
              </Field>

              <Field label="Membership">
                <Chip active={f2pOnly} onClick={() => setF2pOnly((v) => !v)}>
                  {f2pOnly ? "F2P only" : "All items"}
                </Chip>
              </Field>

              <Field label="Pinned">
                <Chip active={watchedOnly} onClick={() => setWatchedOnly((v) => !v)}>
                  ★ Watched
                  {Object.keys(watched).length > 0 ? ` (${Object.keys(watched).length})` : ""}
                </Chip>
              </Field>

              <Field label="Presets" className="flex-1 min-w-[220px]">
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
                {/* The index filter surfaces here as its own removable chip, beside the presets
                    rather than among them. Without it the table would be silently filtered by a
                    click made further down the page. */}
                {activeIndex && (
                  <Chip
                    active
                    onClick={() => {
                      setActiveIndex(null);
                      setIndexItemIds(null);
                      setMinVolume(loadSettings().defaultMinLiquidity);
                    }}
                  >
                    {activeIndex.label} ✕
                  </Chip>
                )}
              </Field>

              {hasActiveFilters && (
                <Field label="&nbsp;">
                  <Button variant="ghost" size="sm" onClick={clearFilters}>
                    ✕ Clear filters
                  </Button>
                </Field>
              )}
            </Toolbar>

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
                table is what you're here for; the highlight leaderboards are for when you're
                curious, not the first thing that should compete for attention. */}
            <div className="mt-8">
              <MarketIndices
                activeKey={activeIndex?.key ?? null}
                onSelectIndex={async (key, label) => {
                  if (key == null) {
                    setActiveIndex(null);
                    setIndexItemIds(null);
                    setMinVolume(loadSettings().defaultMinLiquidity);
                    return;
                  }
                  setActiveIndex({ key, label });
                  // Drop the liquidity floor while an index is selected. Asking for a basket by
                  // name is an explicit request to see THAT basket, and the default floor hid 12
                  // of the 14 Chambers of Xeric uniques -- a filter answering a question the user
                  // had already overridden by clicking. Restored on clear.
                  setMinVolume(0);
                  try {
                    const res = await fetchIndexMembers(key);
                    setIndexItemIds(new Set(res.itemIds));
                  } catch {
                    // The filter is the whole point of the click, so a failed fetch clears the
                    // selection rather than leaving a chip highlighted over an unfiltered table.
                    setActiveIndex(null);
                    setIndexItemIds(null);
                    setMinVolume(loadSettings().defaultMinLiquidity);
                  }
                }}
              />
            </div>

            <div className="mt-8">
              <MarketHighlights items={items} onSelectItem={setSelectedItem} />
            </div>
          </>
        )}
        {tab === "signals" && (
          <>
            <BuySignals
              items={items.filter((i) => !blocked[i.id])}
              onSelectItem={setSelectedItem}
            />
            <TrackRecord />
          </>
        )}
        {tab === "overnight" && (
          <OvernightTrading
            items={items.filter((i) => !blocked[i.id])}
            onSelectItem={setSelectedItem}
          />
        )}
        {tab === "moneymakers" && <MoneyMakers />}
        {tab === "skilling" && <Skilling />}
        {tab === "lists" && <Lists items={items} onSelectItem={setSelectedItem} />}
        {tab === "portfolio" && <Portfolio items={items} onSelectItem={setSelectedItem} />}
        {tab === "flips" && <Flips items={items} onSelectItem={setSelectedItem} />}
        {tab === "bank" && (
          <BankImport
            onUseAsBankroll={handleUseAsBankroll}
            onHoldingsChange={handleHoldingsChange}
          />
        )}
        {tab === "sets" && <Sets />}
        {tab === "news" && (
          <>
            <UpdateCycleBadge />
            <ResearchReport />
            <UpdateSensitivity />
            <NewsFeed />
          </>
        )}
        </ErrorBoundary>
      </main>

      <Sidebar items={items} onSelectItem={setSelectedItem} alerts={alerts} watched={watched} />

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
