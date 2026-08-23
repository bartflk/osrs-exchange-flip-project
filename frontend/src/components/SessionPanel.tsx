import { useEffect, useState } from "preact/hooks";
import { fetchSession, type SessionStats } from "../api";
import { formatGp, formatPct } from "../format";
import { Button } from "./ui";
import { InfoTip } from "./InfoTip";
import type { ExplanationId } from "../explanations";

const SESSION_KEY = "sessionStartedAt";

function loadSessionStart(): number {
  const raw = localStorage.getItem(SESSION_KEY);
  const parsed = raw ? Number(raw) : NaN;
  if (Number.isFinite(parsed) && parsed > 0) return parsed;
  const now = Math.floor(Date.now() / 1000);
  localStorage.setItem(SESSION_KEY, String(now));
  return now;
}

function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function Row({
  label,
  value,
  tone,
  explain,
}: {
  label: string;
  value: string;
  tone?: "good" | "bad";
  explain?: ExplanationId;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3 text-sm">
      <span className="text-gray-500 inline-flex items-center gap-1">
        {label}
        {explain && <InfoTip id={explain} />}
      </span>
      <span
        className={`font-mono ${
          tone === "good" ? "text-emerald-400" : tone === "bad" ? "text-rose-400" : "text-gray-200"
        }`}
      >
        {value}
      </span>
    </div>
  );
}

// DESIGN.md §14.40: the session tracker, modelled on Flipping Copilot's floating session panel.
// The session boundary is a user decision, not something the backend should guess, so the start
// marker lives in localStorage and gets passed to /api/session -- "Reset session" just moves it.
export function SessionPanel() {
  const [since, setSince] = useState<number>(() => loadSessionStart());
  const [stats, setStats] = useState<SessionStats | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    function load() {
      fetchSession(since)
        .then((s) => !cancelled && setStats(s))
        .catch((e) => !cancelled && setError(e instanceof Error ? e.message : "failed"));
    }
    load();
    // The ledger polls the slot files every 20s, so refreshing faster than that only re-renders
    // the same numbers.
    const id = setInterval(load, 20_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [since]);

  // Separate 1s timer purely so the elapsed clock ticks -- it reads from the client rather than
  // waiting on the backend, so the panel doesn't look frozen between refreshes.
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, []);

  function reset() {
    const now = Math.floor(Date.now() / 1000);
    localStorage.setItem(SESSION_KEY, String(now));
    setSince(now);
    setStats(null);
  }

  // `tick` isn't part of the arithmetic -- it exists only so the 1s interval above re-renders
  // this component, at which point Date.now() is re-read and the clock advances.
  void tick;
  const elapsed = Math.max(0, Math.floor(Date.now() / 1000) - since);

  return (
    <div className="glass rounded-xl p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-medium text-gray-200">Session</h3>
        <Button onClick={reset} className="text-xs">
          Reset session
        </Button>
      </div>

      {error ? (
        <p className="text-xs text-rose-400 py-2">{error}</p>
      ) : !stats ? (
        <p className="text-xs text-gray-500 py-2">Loading…</p>
      ) : (
        <>
          <div className="mb-3">
            <div className="text-[11px] uppercase tracking-wide text-gray-500 inline-flex items-center gap-1">
              Profit
              <InfoTip id="realisedProfit" />
            </div>
            <div
              className={`text-2xl font-semibold font-mono ${
                stats.realizedProfit > 0
                  ? "text-emerald-400"
                  : stats.realizedProfit < 0
                    ? "text-rose-400"
                    : "text-gray-300"
              }`}
            >
              {formatGp(stats.realizedProfit)}
            </div>
          </div>

          <div className="space-y-1.5">
            <Row
              label="Unrealized profit"
              value={formatGp(stats.unrealizedProfit)}
              tone={stats.unrealizedProfit > 0 ? "good" : stats.unrealizedProfit < 0 ? "bad" : undefined}
            />
            <Row label="Flips made" value={String(stats.flipsFinished)} />
            <Row label="ROI" value={stats.roiPct != null ? formatPct(stats.roiPct) : "-"} />
            <Row label="Session time" value={formatDuration(elapsed)} />
            <Row label="Hourly profit" value={`${formatGp(stats.gpPerHour ?? 0)}/hr`} explain="gpPerHour" />
            <Row label="Portfolio value" value={formatGp(stats.positionsValue)} />
            <Row label="Tax paid" value={formatGp(stats.taxPaid)} explain="geTax" />
          </div>

          {/* Surfaced rather than silently dropped: these are sells whose buys happened before
              capture started, so their cost basis is unknown. Counting them would have reported
              a fabricated 147k gp/hr on the very first run -- see flips.ts computeSession(). */}
          {stats.excludedUnmatchedFlips > 0 && (
            <p className="mt-3 pt-3 border-t border-white/10 text-[11px] text-amber-400/80 leading-relaxed">
              {stats.excludedUnmatchedFlips} flip{stats.excludedUnmatchedFlips === 1 ? "" : "s"} (
              {formatGp(stats.excludedUnmatchedRevenue)} of sales) excluded, bought before tracking
              started, so profit can't be calculated. See Missed flips.
            </p>
          )}
        </>
      )}
    </div>
  );
}
