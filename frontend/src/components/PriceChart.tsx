import { useEffect, useMemo, useRef, useState } from "preact/hooks";
// preact/compat does not re-export WheelEvent (only React-shaped types it actually mirrors), so
// these come from Preact's own JSX namespace, which is the canonical source for DOM handler types.
import type { JSX } from "preact";
import type { TimeseriesPoint, ForecastPoint } from "../api";
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

// DESIGN.md §14.35: patch notes + community discussion overlaid on the chart, same visual
// language as GE Tracker's own "GE Tax" markers with expandable "and N more..." tooltips --
// answers "did this update / community happening move the market" directly on the chart instead
// of needing to cross-reference the Update News tab separately.
export interface ChartEvent {
  ts: number; // unix seconds, midnight UTC of the event date
  title: string;
  source: string;
  link: string | null;
}

const EVENT_DOT_COLOR: Record<string, string> = {
  official: "#38bdf8", // sky
  reddit: "#fb923c", // orange
};

interface View {
  start: number;
  end: number; // exclusive
}

// DESIGN.md §14.40: your own fills drawn on the chart, for the Visualize Flip view. Deliberately
// a prop on this chart rather than a second chart component -- pan/zoom, the volume strip, event
// dots and tax markers all already work here, and a parallel implementation would drift.
export interface ChartTrade {
  ts: number; // unix seconds
  price: number;
  type: "buy" | "sell";
  quantity: number;
}

// DESIGN.md §14.43: recurring time-of-day markers. Unlike events (one moment) or trades (one
// fill), these mark an hour that repeats every day, so every occurrence inside the visible range
// gets a marker -- which is the point: you see the rhythm, not a single instant.
export interface HourMarker {
  hourUtc: number;
  kind: "buy" | "sell";
  label: string;
}

export function PriceChart({
  points,
  blended = false,
  forecast,
  events,
  trades,
  hourMarkers,
}: {
  points: TimeseriesPoint[];
  blended?: boolean;
  // DESIGN.md §14.40: buy/sell markers for a specific flip.
  trades?: ChartTrade[];
  // DESIGN.md §14.43: "cheapest hour to buy" / "dearest hour to sell", drawn at every occurrence.
  hourMarkers?: HourMarker[];
  // DESIGN.md §14.12: IQR prediction bands -- only meaningful appended to the most recent real
  // data, so it's only ever drawn when the view hasn't been panned/zoomed away from the present.
  forecast?: ForecastPoint[];
  // DESIGN.md §14.35: patch notes / Reddit posts, positioned the same way as TAX_MARKERS.
  events?: ChartEvent[];
}) {
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const [hoveredEventGroup, setHoveredEventGroup] = useState<number | null>(null);
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

  // Forecast only makes sense appended to the most recent real point, so it's only shown when
  // the view actually reaches the end of the full series (not panned/zoomed into the past).
  const showForecast = !!forecast && forecast.length > 0 && v.end === clean.length;
  const forecastCount = showForecast ? forecast!.length : 0;
  // Total x-domain width includes the forecast region when shown -- real data compresses
  // slightly to make room on the right, same layout as the reference chart.
  const totalCount = visibleCount + forecastCount;

  const allPrices = visible
    .flatMap((p) => [p.avgHighPrice, p.avgLowPrice])
    .filter((v): v is number => v != null);
  if (showForecast) {
    for (const p of forecast!) allPrices.push(p.low, p.high);
  }
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
    return PAD_LEFT + (localIdx / Math.max(totalCount - 1, 1)) * plotW;
  }
  function y(price: number) {
    return PAD_TOP + plotH - ((price - min) / range) * plotH;
  }

  // Map an SVG-space x coordinate to a fractional index into the *full* clean array. Uses
  // totalCount (not visibleCount) to stay consistent with x()'s scale, which compresses to make
  // room for the forecast region when one is showing -- otherwise zoom-centering and hover would
  // drift out of alignment with the rendered lines whenever a forecast is displayed.
  function svgXToFullIdx(svgX: number) {
    const frac = (svgX - PAD_LEFT) / plotW;
    return v.start + frac * (totalCount - 1);
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

  function handleWheel(e: JSX.TargetedWheelEvent<SVGSVGElement>) {
    e.preventDefault();
    const rect = e.currentTarget.getBoundingClientRect();
    const svgX = ((e.clientX - rect.left) / rect.width) * WIDTH;
    zoomAt(svgX, e.deltaY > 0 ? 1.2 : 1 / 1.2);
  }

  function handleMouseDown(e: JSX.TargetedMouseEvent<SVGSVGElement>) {
    dragRef.current = { startClientX: e.clientX, startView: v };
  }

  function handleMouseMove(e: JSX.TargetedMouseEvent<SVGSVGElement>) {
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
    const localIdx = Math.round(((relX - PAD_LEFT) / plotW) * (totalCount - 1));
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

  // Group real events into buckets by rendered x position (a few pixels wide) so a busy news
  // week shows one dot with "and N more..." rather than an unreadable cluster of overlapping dots
  // -- same "and 22 more..." pattern GE Tracker's own chart uses for this exact problem.
  const eventGroups = (() => {
    if (!events || events.length === 0) return [];
    const buckets = new Map<number, { cx: number; items: ChartEvent[] }>();
    for (const e of events) {
      const cx = markerX(e.ts);
      if (cx == null) continue;
      const bucketKey = Math.round(cx / 6);
      const bucket = buckets.get(bucketKey);
      if (bucket) bucket.items.push(e);
      else buckets.set(bucketKey, { cx, items: [e] });
    }
    return [...buckets.values()];
  })();

  // Your own fills, positioned with the same interpolation as the event/tax markers so they stay
  // aligned through pan and zoom. Rendered as a dot at (fill time, fill price) plus a dashed
  // horizontal line at the average buy and average sell -- that horizontal line is the part that
  // actually answers "did I get a good price," because it reads directly against the price series.
  const tradeMarkers = (trades ?? [])
    .map((t) => ({ ...t, cx: markerX(t.ts), cy: y(t.price) }))
    .filter((t): t is ChartTrade & { cx: number; cy: number } => t.cx != null);

  function avgLine(type: "buy" | "sell"): { price: number; cy: number } | null {
    const list = (trades ?? []).filter((t) => t.type === type);
    if (!list.length) return null;
    const units = list.reduce((s, t) => s + t.quantity, 0);
    if (units <= 0) return null;
    const price = Math.round(list.reduce((s, t) => s + t.price * t.quantity, 0) / units);
    return { price, cy: y(price) };
  }
  const avgBuyLine = avgLine("buy");
  const avgSellLine = avgLine("sell");

  // Every visible point whose UTC hour matches a marked hour. Deduped to one marker per contiguous
  // run, because a 5-minute-granularity chart has twelve points inside the same hour and would
  // otherwise draw twelve overlapping balls.
  const hourMarkerDots = (() => {
    if (!hourMarkers?.length) return [];
    const out: { cx: number; kind: "buy" | "sell"; label: string; when: string }[] = [];
    for (const m of hourMarkers) {
      let lastIdx = -99;
      for (let i = v.start; i < v.end && i < clean.length; i++) {
        const d = new Date(clean[i].timestamp * 1000);
        if (d.getUTCHours() !== m.hourUtc) continue;
        if (i - lastIdx < 2) continue; // same hour block, already marked
        lastIdx = i;
        out.push({
          cx: x(i - v.start),
          kind: m.kind,
          label: m.label,
          when: d.toLocaleDateString([], { month: "short", day: "numeric" }),
        });
      }
    }
    return out;
  })();

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

  // IQR forecast band: starts as a single point at the last real price (both edges coincide),
  // then fans out through each forecast step -- same visual language as the reference chart
  // (dashed "Low/High prediction" lines around a shaded "Low/High IQR" band).
  const lastRealPrice = showForecast
    ? (visible[visible.length - 1].avgHighPrice ?? visible[visible.length - 1].avgLowPrice ?? 0)
    : 0;
  const forecastStartX = showForecast ? x(visibleCount - 1) : 0;
  const forecastStartY = showForecast ? y(lastRealPrice) : 0;

  function forecastLinePath(key: "low" | "high"): string {
    if (!showForecast) return "";
    let d = `M${forecastStartX.toFixed(1)},${forecastStartY.toFixed(1)} `;
    forecast!.forEach((p, i) => {
      d += `L${x(visibleCount - 1 + (i + 1)).toFixed(1)},${y(p[key]).toFixed(1)} `;
    });
    return d;
  }

  const forecastBandPolygon = (() => {
    if (!showForecast) return "";
    const top = [`${forecastStartX.toFixed(1)},${forecastStartY.toFixed(1)}`];
    const bottom = [`${forecastStartX.toFixed(1)},${forecastStartY.toFixed(1)}`];
    forecast!.forEach((p, i) => {
      const fx = x(visibleCount - 1 + (i + 1));
      top.push(`${fx.toFixed(1)},${y(p.high).toFixed(1)}`);
      bottom.push(`${fx.toFixed(1)},${y(p.low).toFixed(1)}`);
    });
    return `${top.join(" ")} ${bottom.reverse().join(" ")}`;
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
        // Preact spells this onDblClick; the React-style onDoubleClick left over from the §14.x
        // migration was never bound, so double-click-to-reset-zoom silently did nothing.
        onDblClick={resetZoom}
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
            stroke-width={1}
          />
        ))}
        {/* y axis labels */}
        <text x={4} y={PAD_TOP + 4} className="fill-gray-500" font-size="11">
          {formatGp(max)}
        </text>
        <text x={4} y={PAD_TOP + plotH} className="fill-gray-500" font-size="11">
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
          <path d={pathFor("avgHighPrice")} fill="none" stroke="#e2e8f0" stroke-width={1.75} />
        ) : (
          <>
            {/* sell (high) line -- green, buy (low) line -- rose-tinted */}
            <path d={pathFor("avgHighPrice")} fill="none" stroke="#34d399" stroke-width={1.75} />
            <path d={pathFor("avgLowPrice")} fill="none" stroke="#fb7185" stroke-width={1.75} />
          </>
        )}

        {/* IQR prediction band -- deterministic quantile forecast (forecast.ts), not a trained
            model. Only drawn when the view reaches the end of the real data. */}
        {showForecast && (
          <>
            <polygon points={forecastBandPolygon} fill="rgba(96,165,250,0.15)" />
            <path
              d={forecastLinePath("high")}
              fill="none"
              stroke="#34d399"
              stroke-width={1.25}
              stroke-dasharray="4,3"
            />
            <path
              d={forecastLinePath("low")}
              fill="none"
              stroke="#fb7185"
              stroke-width={1.25}
              stroke-dasharray="4,3"
            />
          </>
        )}

        {/* DESIGN.md §14.43: recurring best-buy / best-sell hours. Drawn first so price lines and
            your own fills stay on top -- these are background context, not the subject. */}
        {hourMarkerDots.map((m, i) => (
          <g key={`hm-${i}`}>
            <line
              x1={m.cx}
              x2={m.cx}
              y1={PAD_TOP}
              y2={HEIGHT - PAD_BOTTOM - VOL_HEIGHT}
              stroke={m.kind === "buy" ? "#38bdf8" : "#fb923c"}
              stroke-width={1}
              stroke-dasharray="2,4"
              opacity={0.28}
            />
            <circle
              cx={m.cx}
              cy={PAD_TOP + 6}
              r={5}
              fill={m.kind === "buy" ? "#38bdf8" : "#fb923c"}
              opacity={0.9}
            >
              <title>{`${m.label} — ${m.when}`}</title>
            </circle>
            <text
              x={m.cx}
              y={PAD_TOP + 9}
              text-anchor="middle"
              font-size={7}
              font-weight="700"
              fill="#0b1220"
              pointer-events="none"
            >
              {m.kind === "buy" ? "B" : "S"}
            </text>
          </g>
        ))}

        {/* DESIGN.md §14.40: your own fills for this flip. Average lines first so the individual
            fill dots sit on top of them. */}
        {avgBuyLine && (
          <g>
            <line
              x1={PAD_LEFT}
              x2={WIDTH - PAD_RIGHT}
              y1={avgBuyLine.cy}
              y2={avgBuyLine.cy}
              stroke="#38bdf8"
              stroke-width={1}
              stroke-dasharray="5,4"
              opacity={0.75}
            />
            <circle cx={WIDTH - PAD_RIGHT - 8} cy={avgBuyLine.cy} r={7} fill="#38bdf8" />
            <text
              x={WIDTH - PAD_RIGHT - 8}
              y={avgBuyLine.cy + 3}
              text-anchor="middle"
              font-size={9}
              font-weight="600"
              fill="#0b1220"
            >
              B
            </text>
          </g>
        )}
        {avgSellLine && (
          <g>
            <line
              x1={PAD_LEFT}
              x2={WIDTH - PAD_RIGHT}
              y1={avgSellLine.cy}
              y2={avgSellLine.cy}
              stroke="#fb923c"
              stroke-width={1}
              stroke-dasharray="5,4"
              opacity={0.75}
            />
            <circle cx={WIDTH - PAD_RIGHT - 8} cy={avgSellLine.cy} r={7} fill="#fb923c" />
            <text
              x={WIDTH - PAD_RIGHT - 8}
              y={avgSellLine.cy + 3}
              text-anchor="middle"
              font-size={9}
              font-weight="600"
              fill="#0b1220"
            >
              S
            </text>
          </g>
        )}
        {tradeMarkers.map((t, i) => (
          <circle
            key={`trade-${i}`}
            cx={t.cx}
            cy={t.cy}
            r={3.5}
            fill={t.type === "buy" ? "#38bdf8" : "#fb923c"}
            stroke="#0b1220"
            stroke-width={1}
          >
            <title>
              {`${t.type === "buy" ? "Bought" : "Sold"} ${t.quantity.toLocaleString()} @ ${formatGp(t.price)}`}
            </title>
          </circle>
        ))}

        {/* trend overlay -- a rolling average, not a forecast; purely visual context */}
        <path
          d={movingAveragePath}
          fill="none"
          stroke="rgba(224,231,255,0.5)"
          stroke-width={1}
          stroke-dasharray="3,3"
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
              stroke-width={1}
              stroke-dasharray="2,3"
            />
            <text x={m.cx + 3} y={PAD_TOP + 10} className="fill-amber-400" font-size="9">
              {m.label}
            </text>
          </g>
        ))}

        {/* Event dots -- patch notes / community discussion, positioned along the bottom axis.
            Grouped (eventGroups) so a busy week renders one dot, not a cluster. */}
        {eventGroups.map((g, i) => {
          const primarySource = g.items[0].source;
          return (
            <g
              key={i}
              onMouseEnter={() => setHoveredEventGroup(i)}
              onMouseLeave={() => setHoveredEventGroup((cur) => (cur === i ? null : cur))}
              style={{ cursor: "pointer" }}
            >
              <line
                x1={g.cx}
                x2={g.cx}
                y1={PAD_TOP}
                y2={HEIGHT - PAD_BOTTOM}
                stroke={EVENT_DOT_COLOR[primarySource] ?? "#94a3b8"}
                stroke-width={1}
                stroke-opacity={0.15}
              />
              <circle
                cx={g.cx}
                cy={HEIGHT - PAD_BOTTOM + 8}
                r={5}
                fill={EVENT_DOT_COLOR[primarySource] ?? "#94a3b8"}
                fill-opacity={0.85}
              />
              {g.items.length > 1 && (
                <text
                  x={g.cx}
                  y={HEIGHT - PAD_BOTTOM + 11}
                  text-anchor="middle"
                  font-size="7"
                  className="fill-gray-900 font-bold"
                  style={{ pointerEvents: "none" }}
                >
                  {g.items.length}
                </text>
              )}
            </g>
          );
        })}

        {/* Event tooltip -- first title + "and N more..." for a grouped bucket, same shape as
            the reference screenshot's own hover box. */}
        {hoveredEventGroup != null && eventGroups[hoveredEventGroup] && (
          <g style={{ pointerEvents: "none" }}>
            <rect
              x={Math.min(Math.max(eventGroups[hoveredEventGroup].cx - 90, PAD_LEFT), WIDTH - 190)}
              y={PAD_TOP + 4}
              width={185}
              height={eventGroups[hoveredEventGroup].items.length > 1 ? 34 : 22}
              rx={4}
              fill="rgba(15,23,42,0.95)"
              stroke="rgba(255,255,255,0.15)"
            />
            <text
              x={Math.min(Math.max(eventGroups[hoveredEventGroup].cx - 90, PAD_LEFT), WIDTH - 190) + 6}
              y={PAD_TOP + 17}
              font-size="9"
              className="fill-gray-100"
            >
              {eventGroups[hoveredEventGroup].items[0].title.slice(0, 40)}
              {eventGroups[hoveredEventGroup].items[0].title.length > 40 ? "…" : ""}
            </text>
            {eventGroups[hoveredEventGroup].items.length > 1 && (
              <text
                x={
                  Math.min(Math.max(eventGroups[hoveredEventGroup].cx - 90, PAD_LEFT), WIDTH - 190) +
                  6
                }
                y={PAD_TOP + 29}
                font-size="8"
                className="fill-gray-500"
              >
                and {eventGroups[hoveredEventGroup].items.length - 1} more…
              </text>
            )}
          </g>
        )}

        {hovered && hoverIdx != null && (
          <line
            x1={x(hoverIdx - v.start)}
            x2={x(hoverIdx - v.start)}
            y1={PAD_TOP}
            y2={PAD_TOP + plotH}
            stroke="rgba(255,255,255,0.3)"
            stroke-width={1}
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
        {showForecast && (
          <span className="flex items-center gap-1 text-gray-500">
            <span className="w-2.5 h-2.5 rounded-sm bg-sky-400/25 inline-block" /> IQR forecast
            (~24h)
          </span>
        )}
        {events && events.length > 0 && (
          <span className="flex items-center gap-1 text-gray-500">
            <span className="w-2 h-2 rounded-full bg-sky-400 inline-block" />
            <span className="w-2 h-2 rounded-full bg-orange-400 inline-block -ml-1" /> Updates /
            Reddit
          </span>
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
