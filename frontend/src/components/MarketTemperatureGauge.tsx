import { useEffect, useState } from "preact/hooks";
import { fetchMarketTemperature, type MarketTemperature, type MarketTemperatureLabel } from "../api";

// DESIGN.md §10 item 39 ("More indicators.txt" item 9, "think crypto fear & greed"): whole-GE
// sentiment gauge -- breadth (% of items up) and magnitude (avg % change) have to agree before
// calling it hot/cold, so a couple of huge movers can't dominate the label on their own.
const LABEL_TEXT: Record<MarketTemperatureLabel, string> = {
  hot: "Hot",
  warm: "Warm",
  neutral: "Neutral",
  cool: "Cool",
  cold: "Cold",
};

const LABEL_TONE: Record<MarketTemperatureLabel, string> = {
  hot: "text-rose-400 border-rose-500/30 bg-rose-500/10",
  warm: "text-amber-400 border-amber-500/30 bg-amber-500/10",
  neutral: "text-gray-300 border-white/10 bg-white/5",
  cool: "text-sky-400 border-sky-500/30 bg-sky-500/10",
  cold: "text-blue-400 border-blue-500/30 bg-blue-500/10",
};

export function MarketTemperatureGauge() {
  const [temp, setTemp] = useState<MarketTemperature | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchMarketTemperature("24h")
      .then((res) => !cancelled && setTemp(res))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  if (!temp) return null;

  return (
    <div
      className={`inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs ${LABEL_TONE[temp.label]}`}
      title={`${temp.gainersCount} up, ${temp.losersCount} down, ${temp.flatCount} flat of ${temp.totalCount} tracked items (24h) — avg ${(temp.avgChangePct * 100).toFixed(2)}%`}
    >
      <span className="font-semibold">Market: {LABEL_TEXT[temp.label]}</span>
      <span className="font-mono opacity-80">{(temp.gainerPct * 100).toFixed(0)}% up</span>
    </div>
  );
}
