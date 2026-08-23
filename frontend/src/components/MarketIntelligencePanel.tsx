import { useState } from "preact/hooks";
import { fetchMarketIntelligence, type MarketIntelligence } from "../api";

// DESIGN.md §10 items 36-45 ("More indicators.txt", §14.34): the deterministic indicator bundle
// plus an LLM-synthesized conclusion grounded in it -- "AI Confidence" from the source material,
// built on real computed numbers rather than a bare "BUY" verdict. On-demand (click to load), not
// auto-fetched with the modal -- an LLM call per item-open would be wasteful when most opens are
// just a quick price check.
const CONFIDENCE_TONE: Record<MarketIntelligence["confidence"], string> = {
  low: "text-gray-400",
  medium: "text-amber-400",
  high: "text-emerald-400",
};

const PRESSURE_LABEL: Record<string, string> = {
  bullish: "Bullish",
  bearish: "Bearish",
  neutral: "Neutral",
};

const REVERSION_LABEL: Record<string, string> = {
  oversold: "Oversold",
  overbought: "Overbought",
  neutral: "Neutral",
};

const SHOCK_LABEL: Record<string, string> = {
  supply_shock: "Supply shock",
  demand_shock: "Demand shock",
  none: "None",
};

const SATURATION_LABEL: Record<string, string> = {
  low: "Low",
  moderate: "Moderate",
  high: "High",
  unknown: "Unknown",
};

function IndicatorStat({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wide text-gray-500">{label}</div>
      <div className={`text-sm font-mono ${tone ?? "text-gray-200"}`}>{value}</div>
    </div>
  );
}

export function MarketIntelligencePanel({ itemId }: { itemId: number }) {
  const [data, setData] = useState<MarketIntelligence | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function load() {
    setLoading(true);
    setError(null);
    fetchMarketIntelligence(itemId)
      .then(setData)
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to load"))
      .finally(() => setLoading(false));
  }

  if (!data) {
    return (
      <div className="glass rounded-xl p-4 mb-4">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-sm font-medium text-gray-200">Market intelligence</h3>
            <p className="text-xs text-gray-500 mt-0.5">
              Liquidity, buy/sell pressure, mean reversion, supply/demand shock, and an AI read
              synthesized from those real numbers.
            </p>
          </div>
          <button
            onClick={load}
            disabled={loading}
            className="px-3 py-1.5 rounded-lg text-xs bg-gradient-to-r from-violet-500 to-sky-500 hover:from-violet-400 hover:to-sky-400 text-white transition-colors shrink-0 disabled:opacity-50"
          >
            {loading ? "Analyzing…" : "Analyze"}
          </button>
        </div>
        {error && <p className="text-xs text-rose-400 mt-2">{error}</p>}
      </div>
    );
  }

  const ind = data.indicators;
  return (
    <div className="glass rounded-xl p-4 mb-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-medium text-gray-200">Market intelligence</h3>
        <span className={`text-xs font-semibold ${CONFIDENCE_TONE[data.confidence]}`}>
          {data.confidence.toUpperCase()} confidence
        </span>
      </div>

      <p className="text-sm text-gray-300 leading-relaxed mb-4">{data.conclusion}</p>

      <div className="grid grid-cols-3 sm:grid-cols-4 gap-3 mb-3">
        <IndicatorStat
          label="Opportunity"
          value={`${ind.opportunityScore}/100`}
          tone={
            ind.opportunityScore >= 60
              ? "text-emerald-400"
              : ind.opportunityScore <= 35
                ? "text-rose-400"
                : undefined
          }
        />
        <IndicatorStat label="Liquidity score" value={`${ind.liquidityScore}/100`} />
        <IndicatorStat
          label="Buy/sell pressure"
          value={PRESSURE_LABEL[ind.buyPressure]}
          tone={
            ind.buyPressure === "bullish"
              ? "text-emerald-400"
              : ind.buyPressure === "bearish"
                ? "text-rose-400"
                : undefined
          }
        />
        <IndicatorStat
          label="Spread stability"
          value={ind.spreadStabilityScore != null ? `${ind.spreadStabilityScore}/100` : "-"}
        />
        <IndicatorStat
          label="Mean reversion"
          value={REVERSION_LABEL[ind.meanReversionSignal]}
          tone={
            ind.meanReversionSignal === "oversold"
              ? "text-emerald-400"
              : ind.meanReversionSignal === "overbought"
                ? "text-rose-400"
                : undefined
          }
        />
        <IndicatorStat
          label="Supply/demand shock"
          value={SHOCK_LABEL[ind.supplyDemandShock]}
          tone={ind.supplyDemandShock !== "none" ? "text-amber-400" : undefined}
        />
        <IndicatorStat
          label="Flip saturation"
          value={SATURATION_LABEL[ind.flipSaturation]}
          tone={ind.flipSaturation === "high" ? "text-rose-400" : undefined}
        />
        {/* DESIGN.md §14.45: the "best buy/sell hour" stat that used to sit here was computed
            from local price_history, which only covers the hours the backend happened to be
            running (measured: 13 of 24, identically for every item). It contradicted the
            Best-times-to-trade panel below, which uses complete hourly data from the Wiki API.
            Two answers to one question, one of them structurally incapable of being right. */}
      </div>

      <p className="text-[11px] text-gray-600">
        Based on {ind.sampleSize} local price ticks, heuristic, not backtested. Opportunity score combines all of the above; see DESIGN.md §10 items 36-45.
      </p>
    </div>
  );
}
