import { useEffect, useState } from "preact/hooks";
import { formatGp } from "../format";
import { formatWait, msUntilSlot, slotToLocalLabel } from "../timeSlots";

// The three things an overnight slot has to answer that the chart underneath it does not:
// what this position is worth in gp (not gp/unit), when to come back, and what it costs if the
// week's worst day repeats.
//
// Direct request: "the slots dont really say how much predicted gp you will earn, what time to
// wake up and check." Both were derivable from what was already on screen -- units were in one
// corner and profit-per-unit in a sentence two lines down, and multiplying them was left to the
// reader at 3am. The sell time was there as a chart label with no indication of how long away it
// was, which is the part that actually decides when you set an alarm.

function Cell({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: string;
  sub?: string;
  tone: string;
}) {
  return (
    <div className="min-w-0">
      <div className="text-[9px] uppercase tracking-wider text-gray-500 truncate">{label}</div>
      <div className={`font-mono text-[13px] font-semibold tabular-nums truncate ${tone}`}>
        {value}
      </div>
      {sub && <div className="text-[9px] text-gray-500 truncate">{sub}</div>}
    </div>
  );
}

// Takes plain numbers rather than an HourlyPick so it can be fed from either a live pick or a
// remembered plan -- a held position must keep its figures after the item leaves the ranking.
export function SlotPlanSummary({
  sellSlot,
  profitPerUnit,
  worstDayProfit,
  winDays,
  pairedDays,
  units,
}: {
  sellSlot: number;
  profitPerUnit: number;
  worstDayProfit: number;
  winDays: number;
  pairedDays: number;
  units: number;
}) {
  // Re-render every 30s so "in 14h 20m" stays true while the board is left open overnight --
  // this is the number the user is meant to plan around, so a stale one is worse than none.
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 30_000);
    return () => clearInterval(id);
  }, []);

  const expected = profitPerUnit * units;
  const worst = worstDayProfit * units;
  const wait = msUntilSlot(sellSlot);

  return (
    <div className="mt-2 grid grid-cols-3 gap-2 rounded-lg border border-white/8 bg-black/25 px-2 py-1.5">
      <Cell
        label="Expected"
        value={`${expected >= 0 ? "+" : ""}${formatGp(expected)}`}
        sub={`${units.toLocaleString()} × ${formatGp(profitPerUnit)}`}
        tone={expected >= 0 ? "text-emerald-400" : "text-rose-400"}
      />
      <Cell
        label="Check back"
        value={slotToLocalLabel(sellSlot)}
        sub={`in ${formatWait(wait)}`}
        tone="text-sky-300"
      />
      {/* Deliberately given equal billing to the expected figure rather than tucked into prose.
          A median is not a promise, and this is the leg of the range you cannot react to. */}
      <Cell
        label="Worst day"
        value={worst < 0 ? formatGp(worst) : `+${formatGp(worst)}`}
        sub={`${winDays}/${pairedDays} days won`}
        tone={worst < 0 ? "text-rose-400" : "text-gray-300"}
      />
    </div>
  );
}
