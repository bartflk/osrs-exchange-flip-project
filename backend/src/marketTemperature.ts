import { computeAllTrendEntries } from "./trends.js";

// DESIGN.md §10 item 39 ("More indicators.txt" item 9): whole-catalogue sentiment gauge, "think
// crypto fear & greed" but for the GE. Reuses the same guarded per-item trend data as the
// leaderboard/sectors features (§14.17, §14.33) -- no new data source, just a different rollup.
export type MarketTemperatureLabel = "hot" | "warm" | "neutral" | "cool" | "cold";

export interface MarketTemperature {
  label: MarketTemperatureLabel;
  avgChangePct: number;
  gainersCount: number;
  losersCount: number;
  flatCount: number;
  totalCount: number;
  gainerPct: number; // % of items (with data) that are up
}

function labelFor(avgChangePct: number, gainerPct: number): MarketTemperatureLabel {
  // Two signals, not one -- avg magnitude alone can be dominated by a couple of huge movers even
  // when most of the catalogue is flat, so breadth (gainerPct) has to agree before calling it hot/cold.
  if (avgChangePct > 0.02 && gainerPct > 0.6) return "hot";
  if (avgChangePct > 0.005 && gainerPct > 0.5) return "warm";
  if (avgChangePct < -0.02 && gainerPct < 0.4) return "cold";
  if (avgChangePct < -0.005 && gainerPct < 0.5) return "cool";
  return "neutral";
}

export async function computeMarketTemperature(
  window: Parameters<typeof computeAllTrendEntries>[0],
): Promise<MarketTemperature> {
  const entries = await computeAllTrendEntries(window);
  if (entries.length === 0) {
    return {
      label: "neutral",
      avgChangePct: 0,
      gainersCount: 0,
      losersCount: 0,
      flatCount: 0,
      totalCount: 0,
      gainerPct: 0,
    };
  }

  const gainersCount = entries.filter((e) => e.changePct > 0.001).length;
  const losersCount = entries.filter((e) => e.changePct < -0.001).length;
  const flatCount = entries.length - gainersCount - losersCount;
  const avgChangePct = entries.reduce((sum, e) => sum + e.changePct, 0) / entries.length;
  const gainerPct = gainersCount / entries.length;

  return {
    label: labelFor(avgChangePct, gainerPct),
    avgChangePct,
    gainersCount,
    losersCount,
    flatCount,
    totalCount: entries.length,
    gainerPct,
  };
}
