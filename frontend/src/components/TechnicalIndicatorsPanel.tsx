import { useEffect, useState } from "preact/hooks";
import { fetchTechnicalIndicators, type TechnicalIndicators } from "../api";
import { formatGpFull, formatPct } from "../format";

// DESIGN.md §10 item 25: the classic TA indicator set (SMA/EMA/MACD/RSI/Bollinger/ATR/trend
// slope/velocity/calendar flags), computed on demand from DuckDB's price_daily. Auto-fetched on
// mount (unlike MarketIntelligencePanel's click-to-load) since this is a cheap deterministic
// DuckDB query, not an LLM call.

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function Stat({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wide text-gray-500">{label}</div>
      <div className={`text-sm font-mono ${tone ?? "text-gray-200"}`}>{value}</div>
    </div>
  );
}

export function TechnicalIndicatorsPanel({ itemId }: { itemId: number }) {
  const [data, setData] = useState<TechnicalIndicators | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setData(null);
    setError(null);
    fetchTechnicalIndicators(itemId)
      .then(setData)
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to load"));
  }, [itemId]);

  if (error) {
    return (
      <div className="glass rounded-xl p-4 mb-4">
        <h3 className="text-sm font-medium text-gray-200 mb-1">Technical indicators</h3>
        <p className="text-xs text-rose-400">{error}</p>
      </div>
    );
  }
  if (!data) {
    return (
      <div className="glass rounded-xl p-4 mb-4">
        <h3 className="text-sm font-medium text-gray-200 mb-1">Technical indicators</h3>
        <p className="text-xs text-gray-500">Loading…</p>
      </div>
    );
  }

  const cal = data.calendar;
  const rsiTone =
    data.rsi14 != null ? (data.rsi14 >= 70 ? "text-rose-400" : data.rsi14 <= 30 ? "text-emerald-400" : undefined) : undefined;

  return (
    <div className="glass rounded-xl p-4 mb-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-medium text-gray-200">Technical indicators</h3>
        <span className="text-[10px] text-gray-600">{data.daysAvailable}d of daily history</span>
      </div>

      <div className="grid grid-cols-3 sm:grid-cols-4 gap-3 mb-3">
        <Stat label="SMA 5" value={formatGpFull(data.sma5)} />
        <Stat label="SMA 20" value={formatGpFull(data.sma20)} />
        <Stat label="EMA 12" value={formatGpFull(data.ema12)} />
        <Stat label="EMA 26" value={formatGpFull(data.ema26)} />
        <Stat
          label="MACD"
          value={data.macd != null ? formatGpFull(data.macd.macd) : "-"}
        />
        <Stat
          label="MACD signal"
          value={data.macd?.signal != null ? formatGpFull(data.macd.signal) : "-"}
        />
        <Stat label="RSI 14" value={data.rsi14 != null ? data.rsi14.toFixed(1) : "-"} tone={rsiTone} />
        <Stat label="ATR 14" value={formatGpFull(data.atr14)} />
        <Stat
          label="Bollinger band"
          value={
            data.bollinger20
              ? `${formatGpFull(data.bollinger20.lower)} – ${formatGpFull(data.bollinger20.upper)}`
              : "-"
          }
        />
        <Stat
          label="Velocity (1d)"
          value={formatPct(data.velocityPct)}
          tone={data.velocityPct != null ? (data.velocityPct > 0 ? "text-emerald-400" : data.velocityPct < 0 ? "text-rose-400" : undefined) : undefined}
        />
        <Stat label="Acceleration" value={formatPct(data.accelerationPct)} />
        <Stat label="Trend slope (%/day)" value={formatPct(data.trendSlopePctPerDay)} />
        <Stat
          label="Buy-limit utilization"
          value={data.buyLimitUtilization != null ? `${data.buyLimitUtilization.toFixed(1)}x` : "-"}
        />
        <Stat
          label="Days since crash"
          value={data.daysSinceCrash != null ? `${data.daysSinceCrash}d` : "-"}
        />
        <Stat
          label="Days since spike"
          value={data.daysSinceSpike != null ? `${data.daysSinceSpike}d` : "-"}
        />
        <Stat
          label="Calendar (UTC)"
          value={`${DAY_NAMES[cal.dayOfWeekUtc]} ${String(cal.hourUtc).padStart(2, "0")}:00${cal.isUpdateDayUtc ? " · update day" : ""}`}
        />
      </div>

      <p className="text-[11px] text-gray-600">
        Textbook SMA/EMA/MACD/RSI/Bollinger/ATR formulas over daily closes (price_daily
        warehouse), not fitted or backtested. Fields read "-" when there isn't enough daily
        history yet rather than guess, see DESIGN.md §10 item 25.
      </p>
    </div>
  );
}
