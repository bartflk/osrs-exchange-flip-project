import { useMemo, useState } from "preact/hooks";
import type { BankImportSummary } from "../api";
import { formatGp, formatAgo } from "../format";

// DESIGN.md §10 item 14: bank value history -- `bank_imports` already stores `total_value` per
// import, so this is purely a chart over data that already exists, no new backend work. A
// simple line, not the full pan/zoom PriceChart -- imports are occasional (user-triggered),
// not a continuous poll series, so there's nothing to zoom into.
const WIDTH = 900;
const HEIGHT = 160;
const PAD_LEFT = 56;
const PAD_RIGHT = 12;
const PAD_TOP = 12;
const PAD_BOTTOM = 20;

export function NetWorthChart({
  history,
  title = "Net worth over time",
  unitLabel = "imports",
  note,
}: {
  history: BankImportSummary[];
  // §14.47: the series is whatever the caller supplies, and the automatic Bank Value Tracker
  // feed is BANK VALUE, not net worth. Left mislabelled it read "-89% since first import" for a
  // user whose capital had simply moved onto the Exchange -- the chart contradicted the net-worth
  // figure sitting directly above it. The caller now has to say what it's actually plotting.
  title?: string;
  unitLabel?: string;
  note?: string;
}) {
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  // history arrives newest-first (matches the import-history table's sort); charting wants
  // oldest-first left-to-right.
  const points = useMemo(() => [...history].reverse(), [history]);

  if (points.length < 2) {
    return (
      <div className="glass rounded-xl px-4 py-6 text-center text-xs text-gray-500">
        Need at least 2 saved imports to chart net worth over time.
      </div>
    );
  }

  const values = points.map((p) => p.total_value);
  const min = Math.min(...values, 0);
  const max = Math.max(...values);
  const range = max - min || 1;
  const plotW = WIDTH - PAD_LEFT - PAD_RIGHT;
  const plotH = HEIGHT - PAD_TOP - PAD_BOTTOM;

  function x(i: number) {
    return PAD_LEFT + (i / (points.length - 1)) * plotW;
  }
  function y(value: number) {
    return PAD_TOP + plotH - ((value - min) / range) * plotH;
  }

  const path = points
    .map((p, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(p.total_value).toFixed(1)}`)
    .join(" ");
  const first = points[0].total_value;
  const last = points[points.length - 1].total_value;
  const changePct = first > 0 ? (last - first) / first : 0;
  const hovered = hoverIdx != null ? points[hoverIdx] : null;

  return (
    <div className="glass rounded-xl p-4">
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs uppercase tracking-wide text-gray-500">
          {title} ({points.length} {unitLabel})
        </span>
        <span
          className={`text-xs font-mono ${changePct >= 0 ? "text-emerald-400" : "text-rose-400"}`}
        >
          {changePct >= 0 ? "+" : ""}
          {(changePct * 100).toFixed(1)}% since first reading
        </span>
      </div>
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        className="w-full h-auto"
        onMouseMove={(e) => {
          const rect = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
          const relX = ((e.clientX - rect.left) / rect.width) * WIDTH;
          const idx = Math.round(((relX - PAD_LEFT) / plotW) * (points.length - 1));
          setHoverIdx(idx >= 0 && idx < points.length ? idx : null);
        }}
        onMouseLeave={() => setHoverIdx(null)}
      >
        <text x={4} y={PAD_TOP + 4} className="fill-gray-500" font-size="10">
          {formatGp(max)}
        </text>
        <text x={4} y={PAD_TOP + plotH} className="fill-gray-500" font-size="10">
          {formatGp(min)}
        </text>
        <path d={path} fill="none" stroke="#38bdf8" stroke-width="1.75" />
        {points.map((p, i) => (
          <circle key={p.id} cx={x(i)} cy={y(p.total_value)} r={2} fill="#38bdf8" />
        ))}
        {hovered && hoverIdx != null && (
          <line
            x1={x(hoverIdx)}
            x2={x(hoverIdx)}
            y1={PAD_TOP}
            y2={PAD_TOP + plotH}
            stroke="rgba(255,255,255,0.3)"
            stroke-width="1"
          />
        )}
      </svg>
      {note && <p className="text-[10px] text-gray-500 mt-2 leading-relaxed px-1">{note}</p>}
      <div className="text-xs font-mono text-gray-400 text-right h-4">
        {hovered ? `${formatAgo(hovered.imported_at)} · ${formatGp(hovered.total_value)}gp` : ""}
      </div>
    </div>
  );
}
