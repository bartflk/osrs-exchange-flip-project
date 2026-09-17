import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import {
  fetchTimeseries,
  fetchForecast,
  fetchItemTrackRecord,
  fetchNews,
  type Lookback,
  type MarketItem,
  type TimeseriesPoint,
  type ForecastResponse,
  type ItemTrackRecord,
  type FlipScore,
} from "../api";
import { formatGp, formatPct } from "../format";
import { PriceChart, type ChartEvent, type HourMarker } from "./PriceChart";
import { TradingHoursPanel } from "./TradingHoursPanel";
import { fetchTradingHours, type TradingHours } from "../api";
import type { HoldingEntry } from "../bankHoldings";
import type { WatchEntry } from "../watchlist";
import { type ItemList, loadLists, createList, addItemToList, removeItemFromList } from "../lists";
import { computeSizingTiers, type SizingTierName } from "../positionSizing";
import { MarketIntelligencePanel } from "./MarketIntelligencePanel";
import { TechnicalIndicatorsPanel } from "./TechnicalIndicatorsPanel";
import { ItemMentions } from "./ItemMentions";
import { OvernightVerdictPanel } from "./OvernightVerdict";
import { computeDayLevels, type DayLevels } from "../dayLevels";
import { InfoTip } from "./InfoTip";
import type { ExplanationId } from "../explanations";

function iconUrl(icon: string): string {
  if (!icon) return "";
  return `https://oldschool.runescape.wiki/images/${encodeURIComponent(icon.replace(/ /g, "_"))}`;
}

// 1y is the longest range the Wiki Real-time Prices API's /timeseries endpoint supports
// (confirmed by probing the live API with longer lookback values -- both return
// {"error":"lookback must be a valid value"}). "All" is served separately, from weirdgloop's
// long-range history (back to the item's GE release) -- see backend/src/wiki.ts. It's a single
// blended daily price with no real buy/sell spread, unlike every other range here.
const LOOKBACKS: { key: Lookback; label: string }[] = [
  { key: "6h", label: "6h" },
  { key: "24h", label: "1d" },
  { key: "7d", label: "7d" },
  { key: "30d", label: "30d" },
  { key: "6m", label: "6m" },
  { key: "1y", label: "1y" },
  { key: "all", label: "All" },
];

export function ItemDetailModal({
  item,
  holding,
  watchEntry,
  onToggleWatch,
  onUpdateAlert,
  onClose,
}: {
  item: MarketItem;
  holding?: HoldingEntry;
  // Price-alert controls used to live only on the standalone Watchlist tab -- folded in here
  // (right where you're already looking at the item) since that tab was retired in favor of
  // Portfolio. Optional so the modal still works from call sites that haven't wired watchlist
  // state through yet.
  watchEntry?: WatchEntry;
  onToggleWatch?: () => void;
  onUpdateAlert?: (patch: { alertAbove?: number | null; alertBelow?: number | null }) => void;
  onClose: () => void;
}) {
  const [showAlertInputs, setShowAlertInputs] = useState(false);
  const [lists, setLists] = useState<ItemList[]>(() => loadLists());
  const [showListMenu, setShowListMenu] = useState(false);
  const [newListDraft, setNewListDraft] = useState("");

  function toggleListMembership(listId: string, memberIds: number[]) {
    setLists(
      memberIds.includes(item.id)
        ? removeItemFromList(lists, listId, item.id)
        : addItemToList(lists, listId, item.id),
    );
  }

  function handleCreateListWithItem() {
    const name = newListDraft.trim();
    if (!name) return;
    setLists(createList(lists, name, [item.id]));
    setNewListDraft("");
  }

  const listMenuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!showListMenu) return;
    function onDocClick(e: MouseEvent) {
      if (listMenuRef.current && !listMenuRef.current.contains(e.target as Node)) {
        setShowListMenu(false);
      }
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [showListMenu]);
  const [lookback, setLookback] = useState<Lookback>("24h");
  const [points, setPoints] = useState<TimeseriesPoint[]>([]);
  const [blended, setBlended] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // The whole response, not just the points. The band's own metadata -- how many steps it was
  // built from and how many of them were flat -- is what says whether the band is worth reading,
  // and dropping it left the chart asserting a corridor with no way to judge it.
  const [forecast, setForecast] = useState<ForecastResponse | null>(null);
  const [trackRecord, setTrackRecord] = useState<ItemTrackRecord | null>(null);
  const [chartEvents, setChartEvents] = useState<ChartEvent[]>([]);
  const sizingTiers = useMemo(() => computeSizingTiers(item), [item]);
  // Read from the same localStorage key the money-maker and overnight pages use, so the verdict
  // is sized against the bankroll the rest of the app already believes in rather than a default
  // this one component invented.
  const bankroll = useMemo(() => {
    const raw = localStorage.getItem("bankroll");
    const n = raw ? Number(raw) : NaN;
    return Number.isFinite(n) && n > 0 ? n : 10_000_000;
  }, []);

  // DESIGN.md §14.43: the item's daily rhythm, fetched once and used twice -- as the panel below
  // the chart, and as the recurring B/S markers drawn on the chart itself.
  const [tradingHours, setTradingHours] = useState<TradingHours | null>(null);
  useEffect(() => {
    let cancelled = false;
    setTradingHours(null);
    fetchTradingHours(item.id)
      .then((t) => !cancelled && setTradingHours(t))
      .catch(() => {}); // additive: the chart is fully usable without it
    return () => {
      cancelled = true;
    };
  }, [item.id]);

  // Only marked when the pattern passed the reliability gate -- drawing confident markers for an
  // item whose price barely moves by hour would be exactly the false precision the gate exists
  // to prevent.
  const hourMarkers = useMemo<HourMarker[]>(() => {
    if (!tradingHours?.reliable) return [];
    const out: HourMarker[] = [];
    if (tradingHours.bestBuyHourUtc != null) {
      out.push({
        hourUtc: tradingHours.bestBuyHourUtc,
        kind: "buy",
        label: `Cheapest hour to buy (${String(tradingHours.bestBuyHourUtc).padStart(2, "0")}:00 UTC)`,
      });
    }
    if (tradingHours.bestSellHourUtc != null) {
      out.push({
        hourUtc: tradingHours.bestSellHourUtc,
        kind: "sell",
        label: `Dearest hour to sell (${String(tradingHours.bestSellHourUtc).padStart(2, "0")}:00 UTC)`,
      });
    }
    return out;
  }, [tradingHours]);

  // The day's two offer levels. Keyed on item.id ONLY, and always fetched at 24h, for the same
  // reason the forecast below is: the lines answer "where should I park an offer today", which
  // does not change because you zoomed the chart out to 30d. Tying them to `lookback` would also
  // make them unavailable at 6h, where the series simply does not contain a day.
  const [dayPoints, setDayPoints] = useState<TimeseriesPoint[]>([]);
  useEffect(() => {
    let cancelled = false;
    setDayPoints([]);
    fetchTimeseries(item.id, "24h")
      .then((res) => !cancelled && setDayPoints(res.points))
      .catch(() => {}); // additive: the chart is fully usable without the lines
    return () => {
      cancelled = true;
    };
  }, [item.id]);
  const dayLevels = useMemo(() => computeDayLevels(dayPoints), [dayPoints]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetchTimeseries(item.id, lookback)
      .then((res) => {
        if (!cancelled) {
          setPoints(res.points);
          setBlended(!!res.blended);
          setError(null);
        }
      })
      .catch((err) => !cancelled && setError(err.message))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [item.id, lookback]);

  // DESIGN.md §14.12: IQR forecast + per-item track record -- independent of `lookback` (the
  // forecast always projects ~24h forward from *now*, not from whatever historical range is
  // being viewed), so these live in their own effect keyed only on item.id.
  useEffect(() => {
    let cancelled = false;
    fetchForecast(item.id)
      .then((res) => !cancelled && setForecast(res))
      .catch(() => !cancelled && setForecast(null));
    fetchItemTrackRecord(item.id)
      .then((res) => !cancelled && setTrackRecord(res))
      .catch(() => !cancelled && setTrackRecord(null));
    return () => {
      cancelled = true;
    };
  }, [item.id]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // DESIGN.md §14.35: patch notes / Reddit posts overlaid on the chart -- catalogue-wide (not
  // item-specific), so fetched once regardless of which item's modal is open.
  useEffect(() => {
    let cancelled = false;
    fetchNews()
      .then((res) => {
        if (cancelled) return;
        setChartEvents(
          res.events.map((e) => ({
            ts: Math.floor(new Date(`${e.eventDate}T00:00:00Z`).getTime() / 1000),
            title: e.title,
            source: e.source,
            link: e.link,
          })),
        );
      })
      .catch(() => !cancelled && setChartEvents([]));
    return () => {
      cancelled = true;
    };
  }, []);

  // Overall high/low for whatever range is currently loaded -- same shape as GE Tracker's
  // chart-footer stats table, computed client-side from the points already fetched for the
  // chart rather than a new backend endpoint.
  const rangeStats = useMemo(() => {
    const buyPrices = points.map((p) => p.avgLowPrice).filter((v): v is number => v != null);
    const sellPrices = points.map((p) => p.avgHighPrice).filter((v): v is number => v != null);
    if (buyPrices.length === 0 && sellPrices.length === 0) return null;
    const buyingHigh = buyPrices.length ? Math.max(...buyPrices) : null;
    const buyingLow = buyPrices.length ? Math.min(...buyPrices) : null;
    const sellingHigh = sellPrices.length ? Math.max(...sellPrices) : null;
    const sellingLow = sellPrices.length ? Math.min(...sellPrices) : null;
    const overallHigh = Math.max(
      ...[buyingHigh, sellingHigh].filter((v): v is number => v != null),
    );
    const overallLow = Math.min(...[buyingLow, sellingLow].filter((v): v is number => v != null));
    return { overallHigh, overallLow, buyingHigh, buyingLow, sellingHigh, sellingLow };
  }, [points]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={onClose}
    >
      <div
        className="glass rounded-2xl w-full max-w-[1500px] p-6 2xl:p-8 max-h-[92vh] overflow-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between mb-4">
          <div className="flex items-center gap-3">
            {item.icon && (
              <img src={iconUrl(item.icon)} alt="" className="w-9 h-9 object-contain" />
            )}
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-lg font-semibold text-white">{item.name}</h2>
                {holding && holding.qty > 0 && (
                  <span
                    className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-violet-500/15 text-violet-400 border border-violet-500/30"
                    title={
                      holding.priced
                        ? `Worth ${formatGp(holding.value)}gp at current price`
                        : "Untradeable / unpriced"
                    }
                  >
                    You own {holding.qty.toLocaleString()}
                  </span>
                )}
              </div>
              <p className="text-xs text-gray-500">
                Item ID {item.id}
                {item.members ? " · Members" : ""}
              </p>
            </div>
          </div>
          <div className="flex items-start gap-3">
            {onToggleWatch && (
              <button
                onClick={() => {
                  onToggleWatch();
                  if (!watchEntry) setShowAlertInputs(true);
                }}
                className={`text-xl leading-none transition-colors ${
                  watchEntry ? "text-amber-400" : "text-gray-600 hover:text-gray-300"
                }`}
                title={watchEntry ? "Remove from watchlist" : "Add to watchlist"}
              >
                ★
              </button>
            )}
            <div className="relative" ref={listMenuRef}>
              <button
                onClick={() => setShowListMenu((v) => !v)}
                title="Add to a list"
                className={`text-xs px-2 py-1 rounded-lg border transition-colors ${
                  lists.some((l) => l.itemIds.includes(item.id))
                    ? "text-violet-300 border-violet-500/30 bg-violet-500/10"
                    : "text-gray-500 border-white/10 hover:text-gray-200 hover:bg-white/5"
                }`}
              >
                + List
              </button>
              {showListMenu && (
                <div className="absolute right-0 top-full mt-1.5 w-56 rounded-xl popover p-1.5 z-10">
                  {lists.length === 0 && (
                    <p className="text-[11px] text-gray-600 px-2 py-1.5">No lists yet.</p>
                  )}
                  {lists.map((l) => {
                    const inList = l.itemIds.includes(item.id);
                    return (
                      <button
                        key={l.id}
                        onClick={() => toggleListMembership(l.id, l.itemIds)}
                        className="w-full flex items-center justify-between gap-2 text-left px-2 py-1.5 rounded-lg text-sm text-gray-200 hover:bg-white/5"
                      >
                        <span className="truncate">{l.name}</span>
                        {inList && <span className="text-violet-400 text-xs shrink-0">✓</span>}
                      </button>
                    );
                  })}
                  <div className="flex items-center gap-1.5 border-t border-white/10 mt-1.5 pt-1.5">
                    <input
                      value={newListDraft}
                      onInput={(e) => setNewListDraft((e.target as HTMLInputElement).value)}
                      onKeyDown={(e) => e.key === "Enter" && handleCreateListWithItem()}
                      placeholder="New list…"
                      className="flex-1 min-w-0 bg-white/5 rounded-lg px-2 py-1 text-xs text-gray-100 placeholder:text-gray-600 outline-none"
                    />
                    <button
                      onClick={handleCreateListWithItem}
                      className="text-xs text-violet-300 hover:text-violet-200 px-1.5"
                    >
                      Add
                    </button>
                  </div>
                </div>
              )}
            </div>
            <button
              onClick={onClose}
              className="text-gray-500 hover:text-white text-lg leading-none"
            >
              ✕
            </button>
          </div>
        </div>

        {/* The chart comes FIRST. It used to sit roughly 250 lines below the header, behind six
            stat grids, an execution-edge panel, three sizing cards, two analysis panels and a
            mentions list -- direct feedback: "before i even see the chart i see like 50 boxes."
            The chart is the reason this modal opens; the numbers are what you check once it has
            told you where to look. */}
        {/* The four numbers you need to read the chart, on one line above it. Everything else
            moved below: a decision needs buy, sell, what it clears and what that is as a return,
            and the other twenty fields are follow-up questions. */}
        <div className="flex flex-wrap items-baseline gap-x-6 gap-y-2 mb-3">
          <KeyStat label="Buy at" value={formatGp(item.low)} tone="text-rose-300" />
          <KeyStat label="Sell at" value={formatGp(item.high)} tone="text-emerald-300" />
          <KeyStat
            label="Margin"
            value={formatGp(item.net_margin)}
            tone={(item.net_margin ?? 0) >= 0 ? "text-emerald-400" : "text-rose-400"}
          />
          <KeyStat
            label="ROI"
            value={formatPct(item.roi_pct)}
            tone={(item.roi_pct ?? 0) >= 0 ? "text-emerald-400" : "text-rose-400"}
          />
          {item.flip && (
            <KeyStat
              label="Flip rank"
              value={item.flip.score.toFixed(0)}
              tone={
                item.flip.score >= 80
                  ? "text-emerald-400"
                  : item.flip.score >= 60
                    ? "text-sky-300"
                    : item.flip.score >= 35
                      ? "text-amber-300"
                      : "text-gray-400"
              }
              sub={
                item.flip.gpPerHour > 0
                  ? `${formatGp(Math.round(item.flip.gpPerHour))}/hr per slot`
                  : "no income at these prices"
              }
              title="Out of 100. The five factors behind it are broken out below the chart."
            />
          )}
        </div>

        <div className="flex gap-1 mb-3">
          {LOOKBACKS.map((lb) => (
            <button
              key={lb.key}
              onClick={() => setLookback(lb.key)}
              className={`px-2.5 py-1 rounded-lg text-xs transition-colors ${
                lookback === lb.key
                  ? "bg-white/10 text-white"
                  : "text-gray-400 hover:text-gray-200 hover:bg-white/5"
              }`}
            >
              {lb.label}
            </button>
          ))}
          {loading && <span className="text-xs text-gray-500 self-center ml-2">Loading…</span>}
          {error && <span className="text-xs text-rose-400 self-center ml-2">{error}</span>}
        </div>

        {blended && (
          <p className="text-[11px] text-gray-500 mb-2">
            Full history from the item's GE release, via the OSRS Wiki's long-range archive, daily
            blended price only (no separate buy/sell spread this far back), shown as a single line
            below.
          </p>
        )}
        {/* The verdict used to sit ABOVE the chart, on the reasoning that a reader wants the
            conclusion first and the shape of the data second. That reasoning was sound and the
            layout still lost: the panel was tall enough to push the chart most of a screen down,
            so the thing people open this modal for needed a scroll to reach.

            It is now a slim strip UNDER the chart, collapsed. The conclusion is not buried by
            that -- the strip still states the verdict, the edge and the per-cycle profit on its
            face. Only the working folds away, which is the part you go looking for rather than
            the part you need at a glance. */}
        <PriceChart
          points={points}
          blended={blended}
          forecast={forecast?.points}
          forecastMeta={forecast}
          events={chartEvents}
          hourMarkers={hourMarkers}
          dayLevels={dayLevels}
        />

        {dayLevels && <DayLevelStrip levels={dayLevels} />}

        <OvernightVerdictPanel
          itemId={item.id}
          bankroll={bankroll}
          forecast={forecast}
          currentPrice={item.low ?? item.high ?? null}
        />

        {/* Direct feedback (twice now): stop rendering this as separate boxes with gaps between
            them -- one panel, hairline dividers between sub-sections instead of each carrying its
            own background/border/margin. Range stats, the main stat grid, execution edge and the
            sizing tiers are all the same kind of thing (a row of numbers about this item), so they
            share one container; Market intelligence/Technical indicators/Best times to trade below
            stay as their own cards since those have real headers and distinct content, not just
            more stat rows. */}
        <div className="panel rounded-xl mb-4 divide-y divide-white/[0.06] overflow-hidden">
          {rangeStats && (
            <div className="text-sm grid grid-cols-1 sm:grid-cols-3 divide-y sm:divide-y-0 sm:divide-x divide-white/[0.06]">
              <RangeStatGroup
                label="Overall"
                high={rangeStats.overallHigh}
                low={rangeStats.overallLow}
                highClass="text-gray-200"
                lowClass="text-gray-200"
              />
              <RangeStatGroup
                label="Buying (low side)"
                high={rangeStats.buyingHigh}
                low={rangeStats.buyingLow}
                highClass="text-rose-400"
                lowClass="text-rose-400"
              />
              <RangeStatGroup
                label="Selling (high side)"
                high={rangeStats.sellingHigh}
                low={rangeStats.sellingLow}
                highClass="text-emerald-400"
                lowClass="text-emerald-400"
              />
            </div>
          )}

          {/* Ten stats in a five-wide grid, which is two full rows with no gaps.
            
            It used to be eleven in an eight-wide grid, so the second row was three numbers and
            five empty bordered boxes, which is most of the dead space in this panel. Four of the
            eleven were Buy at, Sell at, Net margin and ROI: the same four already printed twice
            the size above the chart. Repeating them bought nothing and cost the row that made the
            grid ragged. */}
          <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-5 divide-x divide-y divide-white/[0.06]">
            <Stat
              label="GE tax (2%)"
              value={item.tax ? `-${formatGp(item.tax)}` : "-"}
              positive={item.tax ? false : undefined}
              explain="geTax"
            />
            <Stat
              label="Buy limit (4h)"
              value={item.buy_limit != null ? item.buy_limit.toLocaleString() : "-"}
              explain="buyLimitWindow"
            />
            <Stat
              label="Liquidity/hr"
              value={Math.round(item.liquidity).toLocaleString()}
              explain="liquidity"
            />
            <Stat
              label="Buy/sell ratio (1h)"
              value={
                (item.vol_high_1h ?? 0) > 0
                  ? ((item.vol_low_1h ?? 0) / item.vol_high_1h!).toFixed(2)
                  : "-"
              }
              positive={
                (item.vol_high_1h ?? 0) > 0
                  ? (item.vol_low_1h ?? 0) / item.vol_high_1h! >= 1
                  : undefined
              }
            />
            <VolStat label="Vol 1h" buy={item.vol_low_1h} sell={item.vol_high_1h} />
            <VolStat label="Vol 5m" buy={item.vol_low_5m} sell={item.vol_high_5m} />
            <Stat
              label="Volatility (24h)"
              value={
                item.volatility_pct != null ? `${(item.volatility_pct * 100).toFixed(1)}%` : "-"
              }
              positive={item.volatility_pct != null ? item.volatility_pct < 0.05 : undefined}
              explain="volatility"
            />
            <Stat
              label="Volume / day"
              value={item.daily_volume != null ? item.daily_volume.toLocaleString() : "-"}
            />
            <Stat
              label="Last trade"
              value={
                item.buy_age != null || item.sell_age != null
                  ? `${shortAge(Math.max(item.buy_age ?? 0, item.sell_age ?? 0))} ago`
                  : "-"
              }
              positive={
                item.buy_age != null && item.sell_age != null
                  ? Math.max(item.buy_age, item.sell_age) < 3600
                  : undefined
              }
            />
          </div>

          {item.flip && <FlipRankPanel flip={item.flip} />}

          {/* DESIGN.md §10 item 46 (Execution Edge, from Design/new suggestions.txt): the raw
            Buy at/Sell at stats above assume instant fills at the last-traded price, which is
            optimistic -- this is a more realistic offer pair (nudged to jump the fill queue) and
            what you'd actually clear after tax at those prices. */}
          {item.execution_buy_price != null && item.execution_sell_price != null && (
            <div className="p-4">
              <div className="flex items-center justify-between mb-1">
                <span className="text-xs uppercase tracking-wide text-gray-500 inline-flex items-center gap-1">
                  Execution edge
                  <InfoTip id="executionMargin" />
                </span>
                <span
                  className="text-[10px] text-gray-600"
                  title="Nudge size is a %-of-price heuristic, not the real GE tick table -- treat as a starting offer, not a guarantee"
                >
                  undercut/overcut, not the real GE tick table
                </span>
              </div>
              <div className="grid grid-cols-3 gap-3">
                <Stat label="Recommended buy" value={formatGp(item.execution_buy_price)} />
                <Stat label="Recommended sell" value={formatGp(item.execution_sell_price)} />
                <Stat
                  label="Expected margin"
                  value={formatGp(item.execution_margin)}
                  positive={(item.execution_margin ?? 0) >= 0}
                  explain="executionMargin"
                />
              </div>
            </div>
          )}

          {/* DESIGN.md §10 item 7: quantity bands instead of one suggested qty, so the number
            itself communicates how sure the system is (a volatile item's bands shrink together). */}
          {sizingTiers && (
            <div className="grid grid-cols-3 divide-x divide-white/[0.06]">
              {sizingTiers.map((tier) => (
                <SizingTierCard key={tier.name} tier={tier} />
              ))}
            </div>
          )}
        </div>

        {watchEntry && onUpdateAlert && (
          <div className="glass rounded-lg px-3 py-2 mb-4 flex items-center gap-4 flex-wrap text-xs">
            <button
              onClick={() => setShowAlertInputs((v) => !v)}
              className="text-gray-400 hover:text-gray-200 font-medium"
            >
              🔔 Price alerts {showAlertInputs ? "▲" : "▼"}
            </button>
            {!showAlertInputs && (watchEntry.alertAbove || watchEntry.alertBelow) && (
              <span className="text-gray-500">
                {watchEntry.alertAbove && `above ${formatGp(watchEntry.alertAbove)}gp`}
                {watchEntry.alertAbove && watchEntry.alertBelow && " · "}
                {watchEntry.alertBelow && `below ${formatGp(watchEntry.alertBelow)}gp`}
              </span>
            )}
            {showAlertInputs && (
              <>
                <label className="flex items-center gap-1.5 text-gray-500">
                  Notify above
                  <input
                    type="number"
                    defaultValue={watchEntry.alertAbove ?? ""}
                    placeholder="gp"
                    onBlur={(e) =>
                      onUpdateAlert({
                        alertAbove: (e.target as HTMLInputElement).value
                          ? Number((e.target as HTMLInputElement).value)
                          : null,
                      })
                    }
                    className="glass rounded-md px-2 py-1 w-28 outline-none text-gray-200"
                  />
                </label>
                <label className="flex items-center gap-1.5 text-gray-500">
                  Notify below
                  <input
                    type="number"
                    defaultValue={watchEntry.alertBelow ?? ""}
                    placeholder="gp"
                    onBlur={(e) =>
                      onUpdateAlert({
                        alertBelow: (e.target as HTMLInputElement).value
                          ? Number((e.target as HTMLInputElement).value)
                          : null,
                      })
                    }
                    className="glass rounded-md px-2 py-1 w-28 outline-none text-gray-200"
                  />
                </label>
              </>
            )}
          </div>
        )}

        <div className="grid grid-cols-1 xl:grid-cols-2 gap-4 items-start">
          <MarketIntelligencePanel key={`intel-${item.id}`} itemId={item.id} />
          <TechnicalIndicatorsPanel key={`technicals-${item.id}`} itemId={item.id} />
        </div>

        <ItemMentions key={`mentions-${item.id}`} itemId={item.id} />

        {/* DESIGN.md §14.43: the same hourly data that drives the B/S markers on the chart above,
            broken out per hour with an optional LLM reading of it. */}
        <div className="mt-4">
          <TradingHoursPanel key={item.id} itemId={item.id} />
        </div>

        {/* DESIGN.md §14.12: grounded in this app's own resolved recommendation history
            (recommendation_snapshots), not an unexplained competitor badge -- most items won't
            have any history yet, shown honestly rather than faked. */}
        {trackRecord && trackRecord.resolvedCount > 0 && (
          <div className="grid grid-cols-3 gap-3 mb-4 text-sm">
            <Stat
              label="This item's success rate"
              value={
                trackRecord.winRate != null ? `${(trackRecord.winRate * 100).toFixed(0)}%` : "-"
              }
              positive={trackRecord.winRate != null ? trackRecord.winRate >= 0.5 : undefined}
            />
            <Stat
              label="Avg realized margin"
              value={formatGp(trackRecord.avgRealizedNetMargin)}
              positive={(trackRecord.avgRealizedNetMargin ?? 0) >= 0}
            />
            <Stat
              label="Resolved recommendations"
              value={`${trackRecord.wins}W / ${trackRecord.losses}L of ${trackRecord.resolvedCount}`}
            />
          </div>
        )}
      </div>
    </div>
  );
}

const TIER_LABEL: Record<SizingTierName, string> = {
  conservative: "Conservative",
  suggested: "Suggested",
  aggressive: "Aggressive",
};

const TIER_TONE: Record<SizingTierName, string> = {
  conservative: "text-sky-400",
  suggested: "text-emerald-400",
  aggressive: "text-amber-400",
};

function SizingTierCard({
  tier,
}: {
  tier: { name: SizingTierName; qty: number; cost: number; projectedProfit: number };
}) {
  return (
    <div className="px-3 py-2">
      <div
        className={`text-[10px] uppercase tracking-wide flex items-center gap-1 ${TIER_TONE[tier.name]}`}
      >
        {TIER_LABEL[tier.name]}
        <InfoTip id="sizingTiers" />
      </div>
      <div className="font-mono text-sm text-gray-200">{tier.qty.toLocaleString()} units</div>
      <div className="text-[11px] text-gray-500 font-mono">
        {formatGp(tier.cost)} cost · +{formatGp(tier.projectedProfit)}
      </div>
    </div>
  );
}

// Bigger than a Stat and without the box: these four sit on the same line as each other, above
// the chart, and a border around each would put four more rectangles exactly where the complaint
// was that there are too many rectangles.
function shortAge(seconds: number): string {
  if (seconds < 90) return `${Math.round(seconds)}s`;
  if (seconds < 5400) return `${Math.round(seconds / 60)}m`;
  if (seconds < 172800) return `${Math.round(seconds / 3600)}h`;
  return `${Math.round(seconds / 86400)}d`;
}

const FLIP_FACTORS: { key: keyof FlipScore; label: string; why: string }[] = [
  {
    key: "income",
    label: "Income",
    why: "What one GE slot earns per hour here, against a 2m/hr ceiling. The objective: you are allocating eight slots, not unlimited capital.",
  },
  {
    key: "edge",
    label: "Edge",
    why: "Return after tax, full marks at 3%. A risk buffer rather than the goal: under about half a percent, one tick of adverse movement while your offer sits wipes the trade out.",
  },
  {
    key: "fill",
    label: "Fill",
    why: "How much of one buy-limit cycle the market can actually absorb in four hours, judged on the thinner of the two sides.",
  },
  {
    key: "freshness",
    label: "Freshness",
    why: "How recent the two prices behind the margin are, taking the older. Halves every 30 minutes.",
  },
  {
    key: "stability",
    label: "Stability",
    why: "Whether this spread is normal for this item, and how calm the price has been. A spread many times its own norm is usually one stale side, not free money.",
  },
];

/**
 * The rank, opened up.
 *
 * The whole reason this exists rather than a bare number: the score it replaces was a single
 * opaque figure that turned out to be a re-sort of the margin column beside it, and nobody could
 * see that from looking at it. Five bars and the arithmetic underneath mean a rank that looks
 * wrong can be argued with.
 */
function FlipRankPanel({ flip }: { flip: FlipScore }) {
  return (
    <div className="px-4 py-3.5 border-t border-white/[0.06]">
      <div className="flex items-baseline gap-2 mb-3">
        <span className="text-[10px] uppercase tracking-wide text-gray-500">Why this rank</span>
        <span className="text-[11px] text-gray-600">
          five factors, multiplied, so a zero in any one of them is disqualifying
        </span>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-5 gap-x-5 gap-y-2.5">
        {FLIP_FACTORS.map((f) => {
          const v = flip[f.key] as number;
          return (
            <div key={f.key} title={f.why}>
              <div className="flex items-baseline justify-between">
                <span className="text-[11px] text-gray-400">{f.label}</span>
                <span className="font-mono text-[13px] tabular-nums text-gray-200">
                  {(v * 100).toFixed(0)}
                </span>
              </div>
              <div className="h-1.5 rounded-full bg-white/[0.07] mt-1 overflow-hidden">
                <div
                  className={`h-full rounded-full ${
                    v >= 0.75 ? "bg-emerald-400/80" : v >= 0.4 ? "bg-sky-400/70" : "bg-amber-400/70"
                  }`}
                  style={{ width: `${Math.max(v * 100, 2)}%` }}
                />
              </div>
            </div>
          );
        })}
      </div>

      <p className="text-[11px] text-gray-500 mt-3">
        One cycle is {Math.round(flip.expectedUnits).toLocaleString()} units over four hours,{" "}
        {formatGp(Math.round(flip.cycleCapital))} of capital in and{" "}
        <span className={flip.cycleProfit >= 0 ? "text-emerald-400" : "text-rose-400"}>
          {formatGp(Math.round(flip.cycleProfit))}
        </span>{" "}
        out after tax.
        {flip.weakest && (
          <span className="text-amber-500/80"> The rank is held back most by {flip.weakest}.</span>
        )}
      </p>
    </div>
  );
}

/**
 * The arithmetic behind the two lines on the chart, spelled out.
 *
 * Direct framing from the request: "usually how it works is that you have 2% tax gap and then the
 * rest is the margin/profit." So the strip is written as that subtraction rather than as four
 * unrelated stats -- buy, sell, the tax bitten out of the sell, and what is left. A margin number
 * on its own invites the question "is that before or after tax", and this answers it by showing
 * the working instead of asserting a total.
 */
function DayLevelStrip({ levels }: { levels: DayLevels }) {
  const viable = levels.netMargin > 0;
  return (
    <div className="panel rounded-xl mb-4 px-3 py-2 flex items-center gap-x-4 gap-y-1 flex-wrap text-[11px]">
      <span
        className="text-gray-500 shrink-0"
        title="Computed from the last 24h at every lookback, so the lines mean the same thing however far the chart is zoomed out."
      >
        Day offer lines
      </span>
      <span className="text-gray-500">
        buy <span className="font-mono text-rose-400">{formatGp(levels.buy)}</span>
      </span>
      <span className="text-gray-500">
        sell <span className="font-mono text-emerald-400">{formatGp(levels.sell)}</span>
      </span>
      <span className="text-gray-600">
        tax <span className="font-mono">-{formatGp(levels.tax)}</span>
      </span>
      <span className="text-gray-500">
        margin{" "}
        <span className={`font-mono ${viable ? "text-emerald-400" : "text-rose-400"}`}>
          {formatGp(levels.netMargin)}
        </span>{" "}
        <span className={viable ? "text-emerald-500/70" : "text-rose-400/70"}>
          ({formatPct(levels.roiPct)})
        </span>
      </span>
      {/* Said plainly rather than left to be inferred from a red number. If tax is wider than the
          skimmed spread there is no flip at these prices, and that is a fact about the item today,
          not a failure of the lines. */}
      {!viable && (
        <span className="text-rose-400/80">
          2% tax is wider than the spread here, so there is no flip at these prices today
        </span>
      )}
    </div>
  );
}

function KeyStat({
  label,
  value,
  tone,
  sub,
  title,
}: {
  label: string;
  value: string;
  tone: string;
  sub?: string;
  title?: string;
}) {
  return (
    <div title={title}>
      <div className="text-[11px] uppercase tracking-wider text-gray-500">{label}</div>
      <div className={`font-mono text-2xl font-semibold tabular-nums leading-tight ${tone}`}>
        {value}
      </div>
      {sub && <div className="text-[11px] text-gray-500 tabular-nums mt-0.5">{sub}</div>}
    </div>
  );
}

function Stat({
  label,
  value,
  positive,
  explain,
}: {
  label: string;
  value: string;
  positive?: boolean;
  explain?: ExplanationId;
}) {
  return (
    <div className="px-3.5 py-2.5">
      <div className="text-[10px] uppercase tracking-wide text-gray-500 flex items-center gap-1 truncate">
        {label}
        {explain && <InfoTip id={explain} />}
      </div>
      <div
        className={`font-mono text-[15px] tabular-nums mt-0.5 ${
          positive === undefined ? "text-gray-200" : positive ? "text-emerald-400" : "text-rose-400"
        }`}
      >
        {value}
      </div>
    </div>
  );
}

// Overall/buying/selling high-low, for the currently loaded chart range -- mirrors GE Tracker's
// chart-footer stats table (Overall/Buying/Selling High and Low).
function RangeStatGroup({
  label,
  high,
  low,
  highClass,
  lowClass,
}: {
  label: string;
  high: number | null;
  low: number | null;
  highClass: string;
  lowClass: string;
}) {
  return (
    <div className="px-3.5 py-2.5">
      <div className="text-[10px] uppercase tracking-wide text-gray-500 mb-1.5">{label}</div>
      <div className="flex items-center justify-between">
        <span className="text-gray-500 text-xs">High</span>
        <span className={`font-mono text-[15px] tabular-nums ${highClass}`}>{formatGp(high)}</span>
      </div>
      <div className="flex items-center justify-between mt-0.5">
        <span className="text-gray-500 text-xs">Low</span>
        <span className={`font-mono text-[15px] tabular-nums ${lowClass}`}>{formatGp(low)}</span>
      </div>
    </div>
  );
}

// Buy volume colored rose (matches the "Buy (low)" chart line/legend), sell volume colored
// emerald (matches "Sell (high)") -- same convention as PriceChart's hover tooltip, so volume
// isn't the one flat-gray number in an otherwise color-coded modal.
function VolStat({ label, buy, sell }: { label: string; buy: number | null; sell: number | null }) {
  return (
    <div className="px-2.5 py-1.5">
      <div className="text-[10px] uppercase tracking-wide text-gray-500 truncate">
        {label} (buy/sell)
      </div>
      <div className="font-mono text-sm">
        <span className="text-rose-400">{(buy ?? 0).toLocaleString()}</span>
        <span className="text-gray-600"> / </span>
        <span className="text-emerald-400">{(sell ?? 0).toLocaleString()}</span>
      </div>
    </div>
  );
}
