import { useEffect, useState } from "preact/hooks";
import { fetchResearchReport, type ReportPeriod, type ResearchReport as Report } from "../api";
import { formatAgo } from "../format";

// Renders the LLM's plain "## Heading" markdown as simple blocks -- no markdown library needed
// for this narrow a subset (headings + paragraphs only, per the fixed prompt shape in llm.ts).
function renderNarrative(text: string) {
  const blocks = text.split(/\n(?=## )/).filter((b) => b.trim());
  return blocks.map((block, i) => {
    const lines = block.trim().split("\n");
    const heading = lines[0].replace(/^##\s*/, "");
    const body = lines.slice(1).join(" ").trim();
    return (
      <div key={i} className="mb-3 last:mb-0">
        <div className="text-xs font-semibold text-gray-200 mb-1">{heading}</div>
        <p className="text-sm text-gray-400 leading-relaxed">{body}</p>
      </div>
    );
  });
}

// DESIGN.md §10 item 34: daily/weekly digest, now buildable off data that already exists (Track
// Record, trend leaderboard, tiered alerts) -- the LLM's only job is turning it into prose.
export function ResearchReport() {
  const [period, setPeriod] = useState<ReportPeriod>("daily");
  const [report, setReport] = useState<Report | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function load(p: ReportPeriod, refresh = false) {
    setLoading(true);
    setError(null);
    fetchResearchReport(p, refresh)
      .then((r) => setReport(r))
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to load report"))
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    load(period);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [period]);

  return (
    <div className="glass rounded-xl p-4 mb-4">
      <div className="flex items-center justify-between flex-wrap gap-2 mb-3">
        <div>
          <h3 className="text-sm font-medium text-gray-200">Research digest</h3>
          <p className="text-xs text-gray-500">
            Synthesized by the local LLM from real Track Record, trend, and alert data — never
            invented numbers, see DESIGN.md §10 item 34.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex gap-1">
            {(["daily", "weekly"] as const).map((p) => (
              <button
                key={p}
                onClick={() => setPeriod(p)}
                className={`px-2.5 py-1 rounded-lg text-xs transition-colors ${
                  period === p
                    ? "bg-white/10 text-white"
                    : "text-gray-400 hover:text-gray-200 hover:bg-white/5"
                }`}
              >
                {p === "daily" ? "Daily" : "Weekly"}
              </button>
            ))}
          </div>
          <button
            onClick={() => load(period, true)}
            disabled={loading}
            className="px-2.5 py-1 rounded-lg text-xs bg-white/10 hover:bg-white/15 text-white transition-colors disabled:opacity-50"
          >
            {loading ? "Generating…" : "Regenerate"}
          </button>
        </div>
      </div>

      {error && <p className="text-xs text-rose-400">{error}</p>}
      {!error && !report && loading && (
        <p className="text-xs text-gray-500">Generating from local model…</p>
      )}
      {report && (
        <>
          {renderNarrative(report.narrative)}
          <p className="text-[11px] text-gray-600 mt-3 pt-2 border-t border-white/5">
            Generated {formatAgo(Math.floor(report.generatedAt / 1000))}
          </p>
        </>
      )}
    </div>
  );
}
