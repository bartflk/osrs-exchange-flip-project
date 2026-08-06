import { getTrackRecord } from "./scorekeeping.js";
import { computeTrend } from "./trends.js";
import { getRecentAlerts } from "./alerts.js";
import { generateDigest } from "./llm.js";

// DESIGN.md §10 item 34: daily/weekly digest, now buildable without new data collection --
// Track Record (§10 item 1), trend leaderboards (§10 item 9), and tiered alerts (§10 item 10)
// already provide everything a "what's been going on" summary needs. Distinct from the Update
// News tab (§6.4, a raw chronological event feed) -- this is a periodic synthesized narrative.
export type ReportPeriod = "daily" | "weekly";

export interface ResearchReport {
  period: ReportPeriod;
  generatedAt: number;
  narrative: string;
  data: {
    trackRecord: ReturnType<typeof getTrackRecord>["summary"];
    topGainers: { name: string; changePct: number }[];
    topLosers: { name: string; changePct: number }[];
    majorAlerts: { name: string; direction: string; changePct: number }[];
  };
}

// Cached per period -- the underlying data (track record, trend window) doesn't meaningfully
// change minute to minute, and there's no reason to pay for a fresh LLM call every time the tab
// is reopened. Daily refreshes more often than weekly, matching how fast each period's data moves.
const CACHE_TTL_MS: Record<ReportPeriod, number> = {
  daily: 15 * 60 * 1000,
  weekly: 60 * 60 * 1000,
};
const cache = new Map<ReportPeriod, { at: number; report: ResearchReport }>();

export async function getResearchReport(period: ReportPeriod, force = false): Promise<ResearchReport> {
  const cached = cache.get(period);
  if (!force && cached && Date.now() - cached.at < CACHE_TTL_MS[period]) {
    return cached.report;
  }

  const window = period === "daily" ? "24h" : "7d";
  const [trend, { summary }] = await Promise.all([
    computeTrend(window),
    Promise.resolve(getTrackRecord()),
  ]);

  const topGainers = trend
    .filter((t) => t.changePct > 0)
    .sort((a, b) => b.changePct - a.changePct)
    .slice(0, 5)
    .map((t) => ({ name: t.name, changePct: t.changePct }));
  const topLosers = trend
    .filter((t) => t.changePct < 0)
    .sort((a, b) => a.changePct - b.changePct)
    .slice(0, 5)
    .map((t) => ({ name: t.name, changePct: t.changePct }));
  const majorAlerts = getRecentAlerts()
    .filter((a) => a.severity === "major")
    .slice(0, 8)
    .map((a) => ({ name: a.name, direction: a.direction, changePct: a.changePct }));

  const data: ResearchReport["data"] = { trackRecord: summary, topGainers, topLosers, majorAlerts };

  // Pre-format every percentage/gp value to a display string before it reaches the model -- a
  // live test showed a raw fraction like 0.481 (48.1%) got misread as "0.48%" when the model was
  // left to do the *100 itself. Formatting here removes any arithmetic from the model's job,
  // matching the "narrate, don't compute" split used everywhere else this app touches an LLM.
  const fmtPct = (n: number) => `${(n * 100).toFixed(1)}%`;
  const promptGainers = topGainers.map((g) => ({ name: g.name, change: fmtPct(g.changePct) }));
  const promptLosers = topLosers.map((l) => ({ name: l.name, change: fmtPct(l.changePct) }));
  const promptAlerts = majorAlerts.map((a) => ({
    name: a.name,
    direction: a.direction,
    change: fmtPct(a.changePct),
  }));
  const promptSummary = {
    resolvedCount: summary.resolvedCount,
    winRate: summary.winRate != null ? fmtPct(summary.winRate) : "not enough data yet",
    wins: summary.wins,
    losses: summary.losses,
    avgNetMargin: summary.avgNetMargin != null ? `${Math.round(summary.avgNetMargin)}gp` : "—",
    avgRoiPct: summary.avgRoiPct != null ? fmtPct(summary.avgRoiPct) : "—",
  };

  // Each section gets only the facts it needs, not the whole blob repeated -- keeps the prompt
  // smaller and stops the model from e.g. mentioning alerts under "Top Movers."
  const sections =
    period === "daily"
      ? [
          { heading: "Market Overview", facts: { gainers: promptGainers, losers: promptLosers } },
          { heading: "Top Movers", facts: { gainers: promptGainers, losers: promptLosers } },
          { heading: "Track Record Check-in", facts: promptSummary },
          { heading: "Notable Alerts", facts: promptAlerts },
        ]
      : [
          { heading: "Winning Signals", facts: { winRate: promptSummary.winRate, wins: promptSummary.wins } },
          {
            heading: "Failing Signals",
            facts: { losses: promptSummary.losses, avgNetMargin: promptSummary.avgNetMargin },
          },
          {
            heading: "Major Market Moves",
            facts: { gainers: promptGainers, losers: promptLosers, alerts: promptAlerts },
          },
          { heading: "Track Record Summary", facts: promptSummary },
        ];

  const narrative = await generateDigest(period, sections);

  const report: ResearchReport = { period, generatedAt: Date.now(), narrative, data };
  cache.set(period, { at: Date.now(), report });
  return report;
}
