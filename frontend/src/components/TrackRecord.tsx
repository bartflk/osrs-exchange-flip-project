import { useEffect, useState } from "preact/hooks";
import {
  fetchTrackRecord,
  fetchTrackRecordHorizons,
  type TrackRecordEntry,
  type TrackRecordSummary,
  type HorizonResult,
} from "../api";
import { formatAgo, formatGp, formatPct } from "../format";

function iconUrl(icon: string): string {
  if (!icon) return "";
  return `https://oldschool.runescape.wiki/images/${encodeURIComponent(icon.replace(/ /g, "_"))}`;
}

function formatCountdown(unixSeconds: number): string {
  const diffSec = Math.max(0, Math.floor(unixSeconds - Date.now() / 1000));
  if (diffSec < 60) return `${diffSec}s`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m`;
  return `${Math.floor(diffMin / 60)}h`;
}

function outcomeBadge(entry: TrackRecordEntry) {
  if (entry.outcome === "win") {
    return <span className="text-emerald-400">▲ win {formatGp(entry.realizedNetMargin)}</span>;
  }
  if (entry.outcome === "loss") {
    return <span className="text-rose-400">▼ loss {formatGp(entry.realizedNetMargin)}</span>;
  }
  if (entry.outcome === "flat") {
    return <span className="text-gray-400">flat</span>;
  }
  return (
    <span className="text-amber-400">pending, resolves in {formatCountdown(entry.resolveAt)}</span>
  );
}

// DESIGN.md §10 item 1: "the single best way to know if the signal engine is actually adding
// value versus noise." Backend logs the top Buy Signals every 30min and checks back 4h later
// against real prices (backend/src/scorekeeping.ts) -- this widget just surfaces that record.
export function TrackRecord() {
  const [summary, setSummary] = useState<TrackRecordSummary | null>(null);
  const [recent, setRecent] = useState<TrackRecordEntry[]>([]);
  const [horizons, setHorizons] = useState<HorizonResult[]>([]);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const [trackRes, horizonRes] = await Promise.all([
          fetchTrackRecord(),
          fetchTrackRecordHorizons(),
        ]);
        if (!cancelled) {
          setSummary(trackRes.summary);
          setRecent(trackRes.recent);
          setHorizons(horizonRes.horizons);
        }
      } catch {
        // silent -- this is a secondary widget, not worth an error banner
      }
    }
    load();
    const interval = setInterval(load, 60_000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  if (!summary) return null;

  const shown = expanded ? recent : recent.slice(0, 5);

  return (
    <div className="glass rounded-xl p-4 mb-4">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h3 className="text-sm font-medium text-gray-200">Track record</h3>
          <p className="text-xs text-gray-500">
            Every 30min the app logs its own top Buy Signals, then checks back 4h later against real
            prices (headline stats below). The hold-period table further down backtests the same
            logged picks at 2/3/6/12/24h instead.
          </p>
        </div>
        <div className="flex items-center gap-5 text-sm">
          <div className="text-center">
            <div className="text-gray-200 font-mono">
              {summary.winRate != null ? `${(summary.winRate * 100).toFixed(0)}%` : "—"}
            </div>
            <div className="text-[10px] uppercase tracking-wide text-gray-500">Win rate</div>
          </div>
          <div className="text-center">
            <div className="text-gray-200 font-mono">
              {summary.wins}/{summary.resolvedCount}
            </div>
            <div className="text-[10px] uppercase tracking-wide text-gray-500">Resolved</div>
          </div>
          <div className="text-center">
            <div
              className={`font-mono ${(summary.avgNetMargin ?? 0) >= 0 ? "text-emerald-400" : "text-rose-400"}`}
            >
              {formatGp(summary.avgNetMargin)}
            </div>
            <div className="text-[10px] uppercase tracking-wide text-gray-500">Avg net margin</div>
          </div>
          <div className="text-center">
            <div className="text-gray-200 font-mono">{formatPct(summary.avgRoiPct)}</div>
            <div className="text-[10px] uppercase tracking-wide text-gray-500">Avg ROI</div>
          </div>
          <div className="text-center">
            <div className="text-gray-200 font-mono">{summary.pendingCount}</div>
            <div className="text-[10px] uppercase tracking-wide text-gray-500">Pending</div>
          </div>
          <div className="text-center" title="Realized ÷ projected avg net margin across resolved picks -- Buy Signals' 'calibrated profit' figure is your raw projection times this.">
            <div
              className={`font-mono ${
                summary.realizationRatio == null
                  ? "text-gray-500"
                  : summary.realizationRatio >= 0.7
                    ? "text-emerald-400"
                    : "text-amber-400"
              }`}
            >
              {summary.realizationRatio != null
                ? `${(summary.realizationRatio * 100).toFixed(0)}%`
                : `${summary.resolvedCount}/20`}
            </div>
            <div className="text-[10px] uppercase tracking-wide text-gray-500">Realization</div>
          </div>
        </div>
      </div>

      {horizons.length > 0 && (
        <div className="mt-4 pt-3 border-t border-white/10">
          <div className="text-[10px] uppercase tracking-wide text-gray-500 mb-2">
            By hold period
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-xs text-left">
              <thead>
                <tr className="text-gray-500">
                  <th className="pr-4 py-1 font-medium">Hold</th>
                  <th className="px-3 py-1 font-medium text-right">Win rate</th>
                  <th className="px-3 py-1 font-medium text-right">Avg net margin</th>
                  <th className="px-3 py-1 font-medium text-right">Avg ROI</th>
                  <th className="px-3 py-1 font-medium text-right">Resolved / pending</th>
                </tr>
              </thead>
              <tbody>
                {horizons.map((h) => (
                  <tr key={h.hours} className="border-t border-white/5">
                    <td className="pr-4 py-1.5 text-gray-200 font-mono">{h.hours}h</td>
                    <td className="px-3 py-1.5 text-right font-mono text-gray-200">
                      {h.winRate != null ? `${(h.winRate * 100).toFixed(0)}%` : "—"}
                    </td>
                    <td
                      className={`px-3 py-1.5 text-right font-mono ${(h.avgNetMargin ?? 0) >= 0 ? "text-emerald-400" : "text-rose-400"}`}
                    >
                      {h.avgNetMargin != null ? formatGp(h.avgNetMargin) : "—"}
                    </td>
                    <td className="px-3 py-1.5 text-right font-mono text-gray-300">
                      {h.avgRoiPct != null ? formatPct(h.avgRoiPct) : "—"}
                    </td>
                    <td className="px-3 py-1.5 text-right font-mono text-gray-500">
                      {h.resolvedCount} / {h.pendingCount}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {recent.length === 0 ? (
        <p className="text-xs text-gray-500 mt-3">
          No recommendations logged yet — the first batch is taken within 30 minutes of the backend
          starting.
        </p>
      ) : (
        <div className="mt-3 divide-y divide-white/5">
          {shown.map((entry) => (
            <div key={entry.id} className="flex items-center gap-2 py-1.5 text-xs">
              {entry.icon && (
                <img src={iconUrl(entry.icon)} alt="" className="w-4 h-4 object-contain shrink-0" />
              )}
              <span className="text-gray-200 w-40 truncate">{entry.name}</span>
              <span className="text-gray-500">#{entry.rank}</span>
              <span className="text-gray-500 font-mono">
                bought {formatGp(entry.buyPrice)} · planned +{formatGp(entry.netMargin)}
              </span>
              <span className="ml-auto font-mono">{outcomeBadge(entry)}</span>
              <span className="text-gray-600 w-16 text-right">{formatAgo(entry.takenAt)}</span>
            </div>
          ))}
        </div>
      )}

      {recent.length > 5 && (
        <button
          onClick={() => setExpanded((v) => !v)}
          className="text-xs text-gray-500 hover:text-gray-300 mt-2"
        >
          {expanded ? "Show less" : `Show ${recent.length - 5} more`}
        </button>
      )}
    </div>
  );
}
