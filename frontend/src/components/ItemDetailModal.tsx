import { useEffect, useMemo, useState } from "react";
import { fetchTimeseries, type Lookback, type MarketItem, type TimeseriesPoint } from "../api";
import { formatGp, formatPct } from "../format";
import { PriceChart } from "./PriceChart";
import type { HoldingEntry } from "../bankHoldings";

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
  onClose,
}: {
  item: MarketItem;
  holding?: HoldingEntry;
  onClose: () => void;
}) {
  const [lookback, setLookback] = useState<Lookback>("24h");
  const [points, setPoints] = useState<TimeseriesPoint[]>([]);
  const [blended, setBlended] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

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

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

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
    const overallHigh = Math.max(...[buyingHigh, sellingHigh].filter((v): v is number => v != null));
    const overallLow = Math.min(...[buyingLow, sellingLow].filter((v): v is number => v != null));
    return { overallHigh, overallLow, buyingHigh, buyingLow, sellingHigh, sellingLow };
  }, [points]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={onClose}
    >
      <div
        className="glass rounded-2xl w-full max-w-6xl p-6 max-h-[92vh] overflow-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between mb-4">
          <div className="flex items-center gap-3">
            {item.icon && <img src={iconUrl(item.icon)} alt="" className="w-9 h-9 object-contain" />}
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-lg font-semibold text-white">{item.name}</h2>
                {holding && holding.qty > 0 && (
                  <span
                    className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-sky-500/15 text-sky-400 border border-sky-500/30"
                    title={holding.priced ? `Worth ${formatGp(holding.value)}gp at current price` : "Untradeable / unpriced"}
                  >
                    You own {holding.qty.toLocaleString()}
                  </span>
                )}
              </div>
              <p className="text-xs text-gray-500">Item ID {item.id}{item.members ? " · Members" : ""}</p>
            </div>
          </div>
          <button onClick={onClose} className="text-gray-500 hover:text-white text-lg leading-none">
            ✕
          </button>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
          <Stat label="Buy at" value={formatGp(item.low)} />
          <Stat label="Sell at" value={formatGp(item.high)} />
          <Stat label="Net margin" value={formatGp(item.net_margin)} positive={(item.net_margin ?? 0) >= 0} />
          <Stat label="ROI" value={formatPct(item.roi_pct)} positive={(item.roi_pct ?? 0) >= 0} />
          <Stat
            label="GE tax (2%)"
            value={item.tax ? `-${formatGp(item.tax)}` : "—"}
            positive={item.tax ? false : undefined}
          />
          <Stat label="Buy limit (4h)" value={item.buy_limit != null ? item.buy_limit.toLocaleString() : "—"} />
          <Stat label="Liquidity/hr" value={Math.round(item.liquidity).toLocaleString()} />
          <Stat
            label="Buy/sell ratio (1h)"
            value={item.vol_high_1h > 0 ? (item.vol_low_1h / item.vol_high_1h).toFixed(2) : "—"}
            positive={item.vol_high_1h > 0 ? item.vol_low_1h / item.vol_high_1h >= 1 : undefined}
          />
          <VolStat label="Vol 1h" buy={item.vol_low_1h} sell={item.vol_high_1h} />
          <VolStat label="Vol 5m" buy={item.vol_low_5m} sell={item.vol_high_5m} />
        </div>

        <div className="flex gap-1 mb-3">
          {LOOKBACKS.map((lb) => (
            <button
              key={lb.key}
              onClick={() => setLookback(lb.key)}
              className={`px-2.5 py-1 rounded-lg text-xs transition-colors ${
                lookback === lb.key ? "bg-white/10 text-white" : "text-gray-400 hover:text-gray-200 hover:bg-white/5"
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
            Full history from the item's GE release, via the OSRS Wiki's long-range archive — daily blended
            price only (no separate buy/sell spread this far back), shown as a single line below.
          </p>
        )}
        <PriceChart points={points} blended={blended} />

        {rangeStats && (
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mt-4 text-sm">
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
      </div>
    </div>
  );
}

function Stat({ label, value, positive }: { label: string; value: string; positive?: boolean }) {
  return (
    <div className="glass rounded-lg px-3 py-2">
      <div className="text-[10px] uppercase tracking-wide text-gray-500">{label}</div>
      <div
        className={`font-mono text-sm ${
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
    <div className="glass rounded-lg px-3 py-2">
      <div className="text-[10px] uppercase tracking-wide text-gray-500 mb-1">{label}</div>
      <div className="flex items-center justify-between">
        <span className="text-gray-500 text-xs">High</span>
        <span className={`font-mono ${highClass}`}>{formatGp(high)}</span>
      </div>
      <div className="flex items-center justify-between">
        <span className="text-gray-500 text-xs">Low</span>
        <span className={`font-mono ${lowClass}`}>{formatGp(low)}</span>
      </div>
    </div>
  );
}

// Buy volume colored rose (matches the "Buy (low)" chart line/legend), sell volume colored
// emerald (matches "Sell (high)") -- same convention as PriceChart's hover tooltip, so volume
// isn't the one flat-gray number in an otherwise color-coded modal.
function VolStat({ label, buy, sell }: { label: string; buy: number; sell: number }) {
  return (
    <div className="glass rounded-lg px-3 py-2">
      <div className="text-[10px] uppercase tracking-wide text-gray-500">{label} (buy/sell)</div>
      <div className="font-mono text-sm">
        <span className="text-rose-400">{buy.toLocaleString()}</span>
        <span className="text-gray-600"> / </span>
        <span className="text-emerald-400">{sell.toLocaleString()}</span>
      </div>
    </div>
  );
}
