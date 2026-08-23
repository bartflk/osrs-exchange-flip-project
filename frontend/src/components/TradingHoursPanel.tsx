import { useEffect, useState } from "preact/hooks";
import { fetchTradingHours, fetchTradingHoursSummary, type TradingHours } from "../api";
import { Button } from "./ui";
import { InfoTip } from "./InfoTip";

// DESIGN.md §14.43: when is this item cheapest to buy and dearest to sell, by hour of day.
//
// Two independent fetches on purpose: the chart renders as soon as the (fast, cached) numbers
// arrive, and the LLM sentence streams in behind it. Same split as "explain the pick" -- a 10-30s
// local generation must never hold up data that's already computed.

function fmtHour(h: number | null | undefined): string {
  if (h == null) return "-";
  return `${String(h).padStart(2, "0")}:00`;
}

function localHourLabel(utcHour: number): string {
  // The whole feature is quoted in UTC (game time), but "03:00 UTC" means nothing at a glance if
  // you live in UTC+2, so show the viewer's own clock alongside it.
  const d = new Date();
  d.setUTCHours(utcHour, 0, 0, 0);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export function TradingHoursPanel({ itemId }: { itemId: number }) {
  const [data, setData] = useState<TradingHours | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [summary, setSummary] = useState<string | null>(null);
  const [summaryLoading, setSummaryLoading] = useState(false);
  const [summaryError, setSummaryError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setData(null);
    setError(null);
    setSummary(null);
    setSummaryError(null);
    fetchTradingHours(itemId)
      .then((d) => !cancelled && setData(d))
      .catch((e) => !cancelled && setError(e instanceof Error ? e.message : "failed"));
    return () => {
      cancelled = true;
    };
  }, [itemId]);

  function loadSummary(refresh = false) {
    setSummaryLoading(true);
    setSummaryError(null);
    fetchTradingHoursSummary(itemId, refresh)
      .then((r) => setSummary(r.summary))
      .catch((e) => setSummaryError(e instanceof Error ? e.message : "failed"))
      .finally(() => setSummaryLoading(false));
  }

  if (error) {
    return (
      <div className="glass rounded-xl p-4">
        <h4 className="text-sm font-medium text-gray-200 mb-1">Best times to trade</h4>
        <p className="text-xs text-rose-400">{error}</p>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="glass rounded-xl p-4">
        <h4 className="text-sm font-medium text-gray-200 mb-1">Best times to trade</h4>
        <p className="text-xs text-gray-500">Loading hourly pattern…</p>
      </div>
    );
  }

  // Shared scale across buy and sell so the two rows are visually comparable rather than each
  // being normalised to its own max, which would exaggerate whichever one is flatter.
  const devs = data.hours.flatMap((h) =>
    [h.buyDeviation, h.sellDeviation].filter((v): v is number => v != null),
  );
  const maxAbs = devs.length ? Math.max(...devs.map(Math.abs)) : 0;
  const maxVol = Math.max(...data.hours.map((h) => h.volume), 1);

  return (
    <div className="glass rounded-xl p-4">
      <div className="flex items-baseline justify-between gap-2 mb-3 flex-wrap">
        <h4 className="text-sm font-medium text-gray-200 inline-flex items-center gap-1.5">
          Best times to trade
          <InfoTip id="tradingHours" />
        </h4>
        <span className="text-[11px] text-gray-500">
          {data.daysCovered}d of hourly data · {data.hoursCovered}/24 hours · all times UTC
        </span>
      </div>

      {!data.reliable && data.caveat && (
        <p className="text-[11px] text-amber-400/90 mb-3 leading-relaxed">{data.caveat}</p>
      )}

      {data.reliable && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-4">
          <Stat
            label="Buy around"
            value={fmtHour(data.bestBuyHourUtc)}
            hint={data.bestBuyHourUtc != null ? `${localHourLabel(data.bestBuyHourUtc)} local` : ""}
            tone="text-sky-300"
          />
          <Stat
            label="Sell around"
            value={fmtHour(data.bestSellHourUtc)}
            hint={
              data.bestSellHourUtc != null ? `${localHourLabel(data.bestSellHourUtc)} local` : ""
            }
            tone="text-orange-300"
          />
          <Stat
            label="Timing edge"
            value={data.timingEdgePct != null ? `${(data.timingEdgePct * 100).toFixed(2)}%` : "-"}
            hint="after tax"
            tone="text-emerald-300"
          />
          {/* The hold is shown right next to the edge deliberately: the edge is only achievable
              if you're willing to hold this long, and quoting one without the other makes daily
              seasonality look like a quick flip. */}
          <Stat
            label="Hold time"
            value={data.holdHours != null ? `~${data.holdHours}h` : "-"}
            hint="buy → sell window"
            tone="text-gray-200"
          />
        </div>
      )}

      {/* 24 columns, one per hour. Buy bar hangs below the midline when cheap, sell bar rises
          above when dear -- so "cheap to buy" and "dear to sell" read as opposite directions. */}
      <div className="flex items-end gap-[2px] h-24 mb-1">
        {data.hours.map((h) => {
          const buyH = h.buyDeviation != null && maxAbs > 0 ? (h.buyDeviation / maxAbs) * 34 : 0;
          const sellH = h.sellDeviation != null && maxAbs > 0 ? (h.sellDeviation / maxAbs) * 34 : 0;
          const isBestBuy = h.hourUtc === data.bestBuyHourUtc && data.reliable;
          const isBestSell = h.hourUtc === data.bestSellHourUtc && data.reliable;
          return (
            <div
              key={h.hourUtc}
              className="flex-1 flex flex-col items-center justify-center h-full group relative"
              title={
                `${fmtHour(h.hourUtc)} UTC\n` +
                `buy ${h.buyDeviation != null ? (h.buyDeviation * 100).toFixed(2) + "%" : "n/a"}\n` +
                `sell ${h.sellDeviation != null ? (h.sellDeviation * 100).toFixed(2) + "%" : "n/a"}\n` +
                `volume ${h.volume.toLocaleString()}`
              }
            >
              <div className="flex-1 w-full flex flex-col justify-end items-center">
                <div
                  className={`w-full rounded-sm ${isBestSell ? "bg-orange-400" : "bg-orange-400/35"}`}
                  style={{ height: `${Math.max(0, sellH)}px` }}
                />
              </div>
              <div className="w-full h-px bg-white/15" />
              <div className="flex-1 w-full flex flex-col justify-start items-center">
                <div
                  className={`w-full rounded-sm ${isBestBuy ? "bg-sky-400" : "bg-sky-400/35"}`}
                  style={{ height: `${Math.max(0, -buyH)}px` }}
                />
              </div>
            </div>
          );
        })}
      </div>

      {/* Volume strip: where the item actually trades. A great price at a dead hour won't fill. */}
      <div className="flex items-end gap-[2px] h-5 mb-1">
        {data.hours.map((h) => (
          <div
            key={h.hourUtc}
            className="flex-1 bg-gray-500/30 rounded-sm"
            style={{ height: `${Math.max(1, (h.volume / maxVol) * 100)}%` }}
            title={`${fmtHour(h.hourUtc)} UTC · volume ${h.volume.toLocaleString()}`}
          />
        ))}
      </div>

      <div className="flex justify-between text-[9px] text-gray-600 mb-3">
        <span>00</span>
        <span>06</span>
        <span>12</span>
        <span>18</span>
        <span>23</span>
      </div>

      <div className="flex items-center gap-3 text-[10px] text-gray-500 mb-3">
        <span className="flex items-center gap-1">
          <span className="w-2 h-2 rounded-sm bg-sky-400" /> cheap to buy
        </span>
        <span className="flex items-center gap-1">
          <span className="w-2 h-2 rounded-sm bg-orange-400" /> dear to sell
        </span>
        <span className="flex items-center gap-1">
          <span className="w-2 h-2 rounded-sm bg-gray-500/60" /> volume
        </span>
        {data.busiestHourUtc != null && (
          <span className="ml-auto">busiest {fmtHour(data.busiestHourUtc)}</span>
        )}
      </div>

      <div className="border-t border-white/10 pt-3">
        {summary ? (
          <>
            <p className="text-xs text-gray-300 leading-relaxed whitespace-pre-wrap">{summary}</p>
            <button
              onClick={() => loadSummary(true)}
              disabled={summaryLoading}
              className="mt-2 text-[11px] text-sky-400 hover:text-sky-300 disabled:opacity-50"
            >
              {summaryLoading ? "Regenerating…" : "Regenerate"}
            </button>
          </>
        ) : (
          <>
            <Button onClick={() => loadSummary()} disabled={summaryLoading} className="text-xs">
              {summaryLoading ? "Thinking…" : "Explain these times"}
            </Button>
            {summaryError && <p className="text-[11px] text-rose-400 mt-2">{summaryError}</p>}
          </>
        )}
      </div>
    </div>
  );
}

function Stat({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: string;
  hint: string;
  tone: string;
}) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wide text-gray-500">{label}</div>
      <div className={`text-lg font-semibold font-mono ${tone}`}>{value}</div>
      {hint && <div className="text-[10px] text-gray-600">{hint}</div>}
    </div>
  );
}
