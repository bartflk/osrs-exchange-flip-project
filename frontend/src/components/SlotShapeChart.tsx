import type { SlotProfileResponse } from "../api";
import { formatGp } from "../format";
import { slotToLocalLabel } from "../timeSlots";

// The picture behind an overnight pick, drawn from data the app already stored.
//
// Two things are plotted because a pick rests on two different claims, and showing only the first
// is how §14.51 shipped a 52x overstatement:
//
//   1. The SHAPE -- the item's typical buy and sell price across all 48 half-hour slots. This is
//      what "buy at 22:00, sell at 02:30" is asserting exists. If the line is flat noise, there is
//      no daily rhythm to trade and the pick is an artefact of picking the max of 48 numbers.
//   2. The OUTCOMES -- what that exact round trip actually returned on each day measured. A green
//      median with three red days is a coin flip, and no amount of curve says so.
//
// Prices are medians per slot across the sample, not a live tick.

const W = 232;
const H = 54;
const PAD_Y = 4;

function pathFor(values: (number | null)[], min: number, max: number): string {
  const range = max - min || 1;
  const step = W / Math.max(1, values.length - 1);
  let d = "";
  let penDown = false;
  values.forEach((v, i) => {
    if (v == null) {
      // A gap is a slot the item didn't trade in. Lifting the pen shows the hole rather than
      // drawing a straight line across it and implying a price that was never observed.
      penDown = false;
      return;
    }
    const x = i * step;
    const y = PAD_Y + (H - PAD_Y * 2) * (1 - (v - min) / range);
    d += `${penDown ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)} `;
    penDown = true;
  });
  return d.trim();
}

function xOf(slot: number): number {
  return (slot / 47) * W;
}

function yOf(v: number, min: number, max: number): number {
  const range = max - min || 1;
  return PAD_Y + (H - PAD_Y * 2) * (1 - (v - min) / range);
}

export function SlotShapeChart({
  data,
  buySlot,
  sellSlot,
  floor,
  ceiling,
}: {
  data: SlotProfileResponse;
  buySlot: number;
  sellSlot: number;
  /** The price you would bid at the chosen fill target -- drawn as a horizontal rule. */
  floor?: number | null;
  /** The price you would ask. */
  ceiling?: number | null;
}) {
  const buys = data.slots.map((s) => s.buyPrice);
  const sells = data.slots.map((s) => s.sellPrice);
  const all = [...buys, ...sells].filter((v): v is number => v != null);
  if (all.length < 2) {
    return <p className="text-[10px] text-gray-600 mt-1.5">Not enough stored points to draw.</p>;
  }
  // The floor and ceiling must be inside the y-range or they simply do not draw, and they are the
  // part the reader is adjusting. They come from the DAILY values at two slots while the paths
  // come from 48 slot medians, so at an aggressive fill target the bid can legitimately sit above
  // every median on the chart. Range covers both.
  const scaleValues = [...all];
  if (floor != null) scaleValues.push(floor);
  if (ceiling != null) scaleValues.push(ceiling);
  const min = Math.min(...scaleValues);
  const max = Math.max(...scaleValues);

  const buyPoint = data.slots[buySlot]?.buyPrice ?? null;
  const sellPoint = data.slots[sellSlot]?.sellPrice ?? null;

  // The hold window wraps past midnight whenever the sell slot is earlier in the day than the
  // buy slot -- which is the normal case for an overnight trade, not an edge case. Drawn as two
  // rectangles rather than one so the wrap reads correctly instead of shading the daytime.
  const wraps = sellSlot < buySlot;
  const bands: { x: number; w: number }[] = wraps
    ? [
        { x: xOf(buySlot), w: W - xOf(buySlot) },
        { x: 0, w: xOf(sellSlot) },
      ]
    : [{ x: xOf(buySlot), w: xOf(sellSlot) - xOf(buySlot) }];

  const winPct = data.pairedDays > 0 ? data.winDays / data.pairedDays : 0;
  // Same thresholds as the "Days won" column, so the two can't tell different stories.
  const winTone =
    data.pairedDays === 0
      ? "text-gray-500"
      : winPct >= 0.7
        ? "text-emerald-400"
        : winPct <= 0.5
          ? "text-amber-400"
          : "text-gray-300";

  return (
    <div className="mt-1.5">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full block" style={{ height: `${H}px` }}>
        {bands.map((b, i) => (
          <rect key={i} x={b.x} y={0} width={Math.max(0, b.w)} height={H} fill="rgba(139,92,246,0.10)" />
        ))}

        {/* Floor and ceiling: the two prices you would actually place at the current fill target.
            Horizontal because they are a decision, not a series -- the whole point is seeing where
            a flat line you choose sits against a shape you do not control. */}
        {floor != null && (
          <line
            x1="0"
            x2={W}
            y1={yOf(floor, min, max)}
            y2={yOf(floor, min, max)}
            stroke="rgb(96,165,250)"
            stroke-width="1.2"
            stroke-dasharray="3 2"
          />
        )}
        {ceiling != null && (
          <line
            x1="0"
            x2={W}
            y1={yOf(ceiling, min, max)}
            y2={yOf(ceiling, min, max)}
            stroke="rgb(96,165,250)"
            stroke-width="1.2"
            stroke-dasharray="3 2"
          />
        )}

        <path d={pathFor(sells, min, max)} fill="none" stroke="rgb(52,211,153)" stroke-width="1.2" />
        <path d={pathFor(buys, min, max)} fill="none" stroke="rgb(251,113,133)" stroke-width="1.2" />

        {buyPoint != null && (
          <circle cx={xOf(buySlot)} cy={yOf(buyPoint, min, max)} r="3" fill="rgb(251,113,133)" stroke="#0f1015" stroke-width="1" />
        )}
        {sellPoint != null && (
          <circle cx={xOf(sellSlot)} cy={yOf(sellPoint, min, max)} r="3" fill="rgb(52,211,153)" stroke="#0f1015" stroke-width="1" />
        )}
      </svg>

      <div className="flex items-center justify-between text-[9px] text-gray-600 mt-0.5">
        <span>00:00</span>
        <span className="text-rose-400">● buy {slotToLocalLabel(buySlot)}</span>
        <span className="text-emerald-400">● sell {slotToLocalLabel(sellSlot)}</span>
        <span>24:00</span>
      </div>

      {/* One bar per measured day, in date order: the outcomes the median is a summary of. A
          reader can see three red days behind a green median without reading a number. */}
      {data.paired.length > 0 && (
        <div className="flex items-end gap-[2px] h-4 mt-1.5">
          {data.paired.map((p) => {
            const scale = Math.max(...data.paired.map((x) => Math.abs(x.profit))) || 1;
            const h = Math.max(2, (Math.abs(p.profit) / scale) * 14);
            return (
              <div
                key={p.day}
                title={`${p.day}: buy ${formatGp(p.buy)} → sell ${formatGp(p.sell)} = ${p.profit >= 0 ? "+" : ""}${formatGp(p.profit)}`}
                className={`flex-1 rounded-sm ${p.profit >= 0 ? "bg-emerald-500/60" : "bg-rose-500/60"}`}
                style={{ height: `${h}px` }}
              />
            );
          })}
        </div>
      )}

      <p className="text-[10px] leading-snug text-gray-400 mt-1.5">
        Median day{" "}
        <span className={data.medianProfit != null && data.medianProfit >= 0 ? "text-emerald-400" : "text-rose-400"}>
          {data.medianProfit != null
            ? `${data.medianProfit >= 0 ? "+" : ""}${formatGp(data.medianProfit)}/unit`
            : "-"}
        </span>
        , profitable on <span className={winTone}>{data.winDays} of {data.pairedDays}</span> days
        {data.spanDays > 0 && data.spanDays > data.pairedDays
          ? ` spread over ${data.spanDays}`
          : ""}
        .
      </p>
    </div>
  );
}
