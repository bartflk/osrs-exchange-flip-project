import { useEffect, useState } from "preact/hooks";
import { fetchSlotProfile, type SlotProfileResponse } from "../api";
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
  itemId,
  buySlot,
  sellSlot,
}: {
  itemId: number;
  buySlot: number;
  sellSlot: number;
}) {
  const [data, setData] = useState<SlotProfileResponse | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setData(null);
    setFailed(false);
    fetchSlotProfile(itemId, buySlot, sellSlot)
      .then((d) => !cancelled && setData(d))
      .catch(() => !cancelled && setFailed(true));
    return () => {
      cancelled = true;
    };
  }, [itemId, buySlot, sellSlot]);

  if (failed) return <p className="text-[10px] text-gray-600 mt-1.5">No stored shape for this item.</p>;
  if (!data) return <div className="h-[54px] mt-1.5 rounded bg-white/[0.03] animate-pulse" />;

  const buys = data.slots.map((s) => s.buyPrice);
  const sells = data.slots.map((s) => s.sellPrice);
  const all = [...buys, ...sells].filter((v): v is number => v != null);
  if (all.length < 2) {
    return <p className="text-[10px] text-gray-600 mt-1.5">Not enough stored points to draw.</p>;
  }
  const min = Math.min(...all);
  const max = Math.max(...all);

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

  const worst = data.paired.length ? Math.min(...data.paired.map((p) => p.profit)) : null;

  return (
    <div className="mt-1.5">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full block" style={{ height: `${H}px` }}>
        {bands.map((b, i) => (
          <rect key={i} x={b.x} y={0} width={Math.max(0, b.w)} height={H} fill="rgba(139,92,246,0.10)" />
        ))}

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
        <span>24:00 UTC</span>
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
        Buy {slotToLocalLabel(buySlot)}, sell {slotToLocalLabel(sellSlot)}. Median day{" "}
        <span className={data.medianProfit != null && data.medianProfit >= 0 ? "text-emerald-400" : "text-rose-400"}>
          {data.medianProfit != null
            ? `${data.medianProfit >= 0 ? "+" : ""}${formatGp(data.medianProfit)}/unit`
            : "—"}
        </span>
        , profitable on <span className={winTone}>{data.winDays} of {data.pairedDays}</span> days
        {data.spanDays > 0 && data.spanDays > data.pairedDays
          ? ` spread over ${data.spanDays}`
          : ""}
        .
        {/* The worst day is the number that actually matters for a position you sleep through --
            you cannot react to it, so it belongs next to the median rather than buried. */}
        {worst != null && worst < 0 && (
          <span className="text-rose-400"> Worst day {formatGp(worst)}/unit.</span>
        )}
      </p>
    </div>
  );
}
