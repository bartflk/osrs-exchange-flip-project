import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { WheelEvent, MouseEvent } from "preact/compat";
import type { TimeseriesPoint } from "../api";
import { formatGp } from "../format";

const WIDTH = 980;
const HEIGHT = 340;
const PAD_LEFT = 64;
const PAD_RIGHT = 12;
const PAD_TOP = 10;
const PAD_BOTTOM = 24;
const VOL_HEIGHT = 48;
const MIN_VIEW_POINTS = 8;

// DESIGN.md §12.1 item 11 / §4.2: GE Tracker's chart annotates the two GE-tax-rate-change dates.
// Unix seconds, UTC midnight of each date.
const TAX_MARKERS: { ts: number; label: string }[] = [
  { ts: Date.UTC(2021, 11, 9) / 1000, label: "1% tax" },
  { ts: Date.UTC(2025, 4, 29) / 1000, label: "2% tax" },
];

interface View {
  start: number;
  end: number; // exclusive
}

export function PriceChart({
  points,
  blended = false,
}: {
  points: TimeseriesPoint[];
  blended?: boolean;
}) {
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const [view, setView] = useState<View | null>(null);
  const dragRef = useRef<{ startClientX: number; startView: View } | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);

  const clean = useMemo(
    () => points.filter((p) => p.avgHighPrice != null || p.avgLowPrice != null),
    [points],
  );

  // Reset to the full range whenever the underlying data changes (e.g. lookback switch).
  useEffect(() => {
    setView(clean.length > 0 ? { start: 0, end: clean.length } : null);
    setHoverIdx(null);
  }, [clean]);

  if (clean.length < 2 || !view) {
    return <div className="text-sm text-gray-500 py-10 text-center">Not enough data yet.</div>;
  }
  // Narrow once into a local const -- TS doesn't carry the `!view` narrowing above into the
  // nested closures (onWheel/onMouseMove/etc.) defined further down in this render.
  const v = view;

  const visible = clean.slice(v.start, v.end);
  const visibleCount = visible.length;

  const allPrices = visible
    .flatMap((p) => [p.avgHighPrice, p.avgLowPrice])
    .filter((v): v is number => v != null);
  const min = allPrices.length ? Math.min(...allPrices) : 0;
  const max = allPrices.length ? Math.max(...allPrices) : 1;
  const range = max - min || 1;
  const maxVol = Math.max(
    ...visible.map((p) => (p.highPriceVolume ?? 0) + (p.lowPriceVolume ?? 0)),
    1,
  );

  const plotW = WIDTH - PAD_LEFT - PAD_RIGHT;
  const plotH = HEIGHT - PAD_TOP - PAD_BOTTOM - VOL_HEIGHT;

  function x(localIdx: number) {
    return PAD_LEFT + (localIdx / Math.max(visibleCount - 1, 1)) * plotW;
  }
  function y(price: number) {
    return PAD_TOP + plotH - ((price - min) / range) * plotH;
  }

  // Map an SVG-space x coordinate to a fractional index into the *full* clean array.
  function svgXToFullIdx(svgX: number) {
    const frac = (svgX - PAD_LEFT) / plotW;
    return v.start + frac * (visibleCount - 1);
  }

  function pathFor(key: "avgHighPrice" | "avgLowPrice") {
    let d = "";
    let started = false;
    visible.forEach((p, i) => {
      const val = p[key];
      if (val == null) return;
      d += `${started ? "L" : "M"}${x(i).toFixed(1)},${y(val).toFixed(1)} `;
      started = true;
    });
    return d;
  }

  function clampView(next: View): View {
    let { start, end } = next;
    const width = Math.min(Math.max(end - start, MIN_VIEW_POINTS), clean.length);
    if (start < 0) {
      start = 0;
      end = width;
    }
    if (end > clean.length) {
      end = clean.length;
      start = end - width;
    }
    return { start: Math.round(start), end: Math.round(end) };
  }

  function zoomAt(svgX: number, factor: number) {
    const centerIdx = svgXToFullIdx(svgX);
    const curWidth = v.end - v.start;
    const newWidth = Math.min(Math.max(curWidth * factor, MIN_VIEW_POINTS), clean.length);
    const ratio = (centerIdx - v.start) / Math.max(curWidth, 1);
    const start = centerIdx - ratio * newWidth;
    setView(clampView({ start, end: start + newWidth }));
  }

  function handleWheel(e: WheelEvent<SVGSVGElement>) {
    e.preventDefault();
    const rect = e.currentTarget.getBoundingClientRect();
    const svgX = ((e.clientX - rect.left) / rect.width) * WIDTH;
    zoomAt(svgX, e.deltaY > 0 ? 1.2 : 1 / 1.2);
  }

  function handleMouseDown(e: MouseEvent<SVGSVGElement>) {
    dragRef.current = { startClientX: e.clientX, startView: v };
  }

  function handleMouseMove(e: MouseEvent<SVGSVGElement>) {
    if (dragRef.current) {
      const rect = e.currentTarget.getBoundingClientRect();
      const deltaPx = e.clientX - dragRef.current.startClientX;
      const deltaIdx = -(deltaPx / rect.width) * WIDTH * ((v.end - v.start) / plotW);
      const { start, end } = dragRef.current.startView;
      setView(clampView({ start: start + deltaIdx, end: end + deltaIdx }));
      return;
    }
    const rect = e.currentTarget.getBoundingClientRect();
    const relX = ((e.clientX - rect.left) / rect.width) * WIDTH;
    const localIdx = Math.round(((relX - PAD_LEFT) / plotW) * (visibleCount - 1));
    if (localIdx >= 0 && localIdx < visibleCount) setHoverIdx(v.start + localIdx);
    else setHoverIdx(null);
  }

  function handleMouseUp() {
    dragRef.current = null;
  }

  function resetZoom() {
    setView({ start: 0, end: clean.length });
  }

  const isZoomed = v.start > 0 || v.end < clean.length;
  const hovered = hoverIdx != null ? clean[hoverIdx] : null;

  // Tax-rate-change markers: interpolate each marker's timestamp to an x position within the
  // *full* clean series, then only render it if that position falls inside the current
  // (possibly zoomed) view.
  function markerX(ts: number): number | null {
    if (ts < clean[0].timestamp || ts > clean[clean.length - 1].timestamp) return null;
    for (let i = 0; i < clean.length - 1; i++) {
      const a = clean[i].timestamp;
      const b = clean[i + 1].timestamp;
      if (ts >= a && ts <= b) {
        const frac = b > a ? (ts - a) / (b - a) : 0;
        const fullIdx = i + frac;
        if (fullIdx < v.start || fullIdx > v.end) return null;
        return x(fullIdx - v.start);
      }
    }
    return null;
  }
  const visibleMarkers = TAX_MARKERS.map((m) => ({ ...m, cx: markerX(m.ts) })).filter(
    (m): m is { ts: number; label: string; cx: number } => m.cx != null,
  );

  // Simple moving-average overlay -- a light trend line, not a real forecast. Window scales with
  // how many points are currently in view so it stays legible whether zoomed to a day or a year.
  const maWindow = Math.max(3, Math.round(visibleCount / 15));
  const movingAveragePath = (() => {
    let d = "";
    let started = false;
    for (let i = 0; i < visible.length; i++) {
      const windowStart = Math.max(0, i - maWindow + 1);
      const slice = visible
        .slice(windowStart, i + 1)
        .map((p) => p.avgHighPrice)
        .filter((val): val is number => val != null);
      if (slice.length === 0) continue;
      const avg = slice.reduce((sum, val) => sum + val, 0) / slice.length;
      d += `${started ? "L" : "M"}${x(i).toFixed(1)},${y(avg).toFixed(1)} `;
      started = true;
    }
    return d;
  })();

  return (
    <div className="relative">
      <div className="flex items-center justify-between mb-1">
        <span className="text-[11px] text-gray-500">
          Scroll to zoom, drag to pan
          {isZoomed ? ` · showing ${visibleCount} of ${clean.length} points` : ""}
        </span>
        <div className="flex items-center gap-1">
          <button
            onClick={() => zoomAt(WIDTH / 2, 1 / 1.5)}
            className="w-6 h-6 rounded-md bg-white/5 hover:bg-white/10 text-gray-300 text-xs leading-none"
            title="Zoom in"
          >
            +
          </button>
          <button
            onClick={() => zoomAt(WIDTH / 2, 1.5)}
            className="w-6 h-6 rounded-md bg-white/5 hover:bg-white/10 text-gray-300 text-xs leading-none"
            title="Zoom out"
          >
            −
          </button>
          {isZoomed && (
            <button
              onClick={resetZoom}
              className="px-2 h-6 rounded-md bg-white/5 hover:bg-white/10 text-gray-300 text-[11px] leading-none"
            >
              Reset zoom
            </button>
          )}
        </div>
      </div>

      <svg
        ref={svgRef}
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        className="w-full h-auto cursor-grab active:cursor-grabbing select-none"
        onWheel={handleWheel}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={() => {
          setHoverIdx(null);
          dragRef.current = null;
        }}
        onDoubleClick={resetZoom}
      >
        {/* gridlines */}
        {[0, 0.5, 1].map((t) => (
          <line
            key={t}
            x1={PAD_LEFT}
            x2={WIDTH - PAD_RIGHT}
            y1={PAD_TOP + t * plotH}
            y2={PAD_TOP + t * plotH}
            stroke="rgba(255,255,255,0.08)"
            strokeWidth={1}
          />
        ))}
        {/* y axis labels */}
        <text x={4} y={PAD_TOP + 4} className="fill-gray-500" fontSize="11">
          {formatGp(max)}
        </text>
        <text x={4} y={PAD_TOP + plotH} className="fill-gray-500" fontSize="11">
          {formatGp(min)}
        </text>

        {/* volume bars -- stacked buy (rose, bottom) / sell (emerald, top), matching GE
            Tracker's convention instead of one flat gray bar per point. Blended (weirdgloop
            all-time) data has no buy/sell volume split, just one total -- render that as a
            single neutral bar instead of implying a split that doesn't exist in the source. */}
        {visible.map((p, i) => {
          const barW = Math.max(plotW / visibleCount - 1, 1);
          const baseY = HEIGHT - PAD_BOTTOM;
          if (blended) {
            const vol = p.highPriceVolume ?? 0;
            const h = (vol / maxVol) * VOL_HEIGHT;
            return (
              <rect
                key={v.start + i}
                x={x(i) - barW / 2}
                y={baseY - h}
                width={barW}
                height={h}
                fill="rgba(148,163,184,0.35)"
              />
            );
          }
          const buyVol = p.lowPriceVolume ?? 0;
          const sellVol = p.highPriceVolume ?? 0;
          const buyH = (buyVol / maxVol) * VOL_HEIGHT;
          const sellH = (sellVol / maxVol) * VOL_HEIGHT;
          return (
            <g key={v.start + i}>
              <rect
                x={x(i) - barW / 2}
                y={baseY - buyH}
                width={barW}
                height={buyH}
                fill="rgba(251,113,133,0.55)"
              />
              <rect
                x={x(i) - barW / 2}
                y={baseY - buyH - sellH}
                width={barW}
                height={sellH}
                fill="rgba(52,211,153,0.55)"
              />
            </g>
          );
        })}

        {blended ? (
          // Single blended price line -- avgHighPrice === avgLowPrice for every point here,
          // so a real high/low split would be fake precision.
          <path d={pathFor("avgHighPrice")} fill="none" stroke="#e2e8f0" strokeWidth={1.75} />
        ) : (
          <>
            {/* sell (high) line -- green, buy (low) line -- rose-tinted */}
            <path d={pathFor("avgHighPrice")} fill="none" stroke="#34d399" strokeWidth={1.75} />
            <path d={pathFor("avgLowPrice")} fill="none" stroke="#fb7185" strokeWidth={1.75} />
          </>
        )}

        {/* trend overlay -- a rolling average, not a forecast; purely visual context */}
        <path
          d={movingAveragePath}
          fill="none"
          stroke="rgba(224,231,255,0.5)"
          strokeWidth={1}
          strokeDasharray="3,3"
        />

        {/* GE tax-rate-change markers, only drawn when that date is within the current view */}
        {visibleMarkers.map((m) => (
          <g key={m.ts}>
            <line
              x1={m.cx}
              x2={m.cx}
              y1={PAD_TOP}
              y2={PAD_TOP + plotH}
              stroke="rgba(251,191,36,0.4)"
              strokeWidth={1}
              strokeDasharray="2,3"
            />
            <text x={m.cx + 3} y={PAD_TOP + 10} className="fill-amber-400" fontSize="9">
              {m.label}
            </text>
          </g>
        ))}

        {hovered && hoverIdx != null && (
          <line
            x1={x(hoverIdx - v.start)}
            x2={x(hoverIdx - v.start)}
            y1={PAD_TOP}
            y2={PAD_TOP + plotH}
            stroke="rgba(255,255,255,0.3)"
            strokeWidth={1}
          />
        )}
      </svg>

      <div className="flex items-center gap-4 text-xs text-gray-400 mt-1">
        {blended ? (
          <span className="flex items-center gap-1">
            <span className="w-2.5 h-2.5 rounded-full bg-slate-300 inline-block" /> Price (daily,
            blended)
          </span>
        ) : (
          <>
            <span className="flex items-center gap-1">
              <span className="w-2.5 h-2.5 rounded-full bg-emerald-400 inline-block" /> Sell (high)
            </span>
            <span className="flex items-center gap-1">
              <span className="w-2.5 h-2.5 rounded-full bg-rose-400 inline-block" /> Buy (low)
            </span>
          </>
        )}
        {hovered &&
          (blended ? (
            <span className="ml-auto font-mono text-gray-300">
              {new Date(hovered.timestamp * 1000).toLocaleDateString()} ·{" "}
              {formatGp(hovered.avgHighPrice)}
              {hovered.highPriceVolume ? ` · vol ${hovered.highPriceVolume.toLocaleString()}` : ""}
            </span>
          ) : (
            <span className="ml-auto font-mono text-gray-300">
              {new Date(hovered.timestamp * 1000).toLocaleString()} ·{" "}
              <span className="text-emerald-400">high {formatGp(hovered.avgHighPrice)}</span> ·{" "}
              <span className="text-rose-400">low {formatGp(hovered.avgLowPrice)}</span>
            </span>
          ))}
      </div>
    </div>
  );
}
