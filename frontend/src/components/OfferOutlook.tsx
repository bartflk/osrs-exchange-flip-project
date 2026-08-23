import { useEffect, useState } from "preact/hooks";
import { fetchSlotProfile, type SlotProfileResponse } from "../api";
import { formatGpFull } from "../format";
import { SlotShapeChart } from "./SlotShapeChart";

// The same picture and odds for an offer that has NO overnight plan behind it.
//
// Direct report: "when i use for example flipping copilot, the offers i put in dont have the same
// UI as the (on plan - Sell) one with all the info. I still do want some kind of visualization and
// prediction on these." Six of eight slots were showing a single line of reprice text while one
// planned slot got a chart, a forecast and a fill rate -- and nothing about the other six made
// them less worth understanding. They just arrived by a different route.
//
// A plan supplies a buy slot and a sell slot. An offer placed by hand supplies neither, only a
// price. But "would this price have filled at this time of day?" needs nothing more than the price
// and the daily readings at that slot, both of which exist. So the question shifts from "how good
// is this plan" to "how does the price you actually chose compare to what this item does at this
// hour" -- which is the question you have when you are looking at someone else's suggestion.

function pctBelow(price: number, values: number[]): number | null {
  if (!values.length) return null;
  return values.filter((v) => v <= price).length / values.length;
}

export function OfferOutlook({
  itemId,
  slot,
  price,
  type,
}: {
  itemId: number;
  /** Half-hour slot to judge the offer against -- the one it is sitting in now. */
  slot: number;
  price: number;
  type: "buy" | "sell";
}) {
  const [data, setData] = useState<SlotProfileResponse | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setData(null);
    setFailed(false);
    // Same slot for both legs: this is not a round trip, it is one resting offer.
    fetchSlotProfile(itemId, slot, slot)
      .then((d) => !cancelled && setData(d))
      .catch(() => !cancelled && setFailed(true));
    return () => {
      cancelled = true;
    };
  }, [itemId, slot]);

  if (failed || (data && data.slots.length === 0)) return null;
  if (!data) return <div className="h-[70px] mt-1.5 rounded bg-white/[0.03] animate-pulse" />;

  // A buy fills when the day's low comes down to your price; a sell fills when the day's high
  // rises to it. Same counting, opposite direction.
  const fill =
    type === "buy"
      ? pctBelow(price, data.buyDays)
      : data.sellDays.length
        ? data.sellDays.filter((v) => v >= price).length / data.sellDays.length
        : null;
  const sample = type === "buy" ? data.buyDays.length : data.sellDays.length;

  if (sample === 0) {
    return (
      <p className="text-[10px] text-gray-600 mt-1.5">
        No stored readings at this time of day, so no fill estimate.
      </p>
    );
  }

  const tone =
    fill == null
      ? "text-gray-500"
      : fill >= 0.7
        ? "text-emerald-400"
        : fill >= 0.4
          ? "text-amber-400"
          : "text-rose-400";

  return (
    <div className="mt-1.5">
      <div className="flex items-baseline justify-between gap-2 rounded-lg border border-white/8 bg-black/25 px-2 py-1.5">
        <div className="min-w-0">
          <div className="text-[9px] uppercase tracking-wider text-gray-500">Your price fills</div>
          <div className={`font-mono text-[13px] font-semibold tabular-nums ${tone}`}>
            {fill == null ? "—" : `${Math.round(fill * 100)}%`}
            <span className="text-[9px] font-normal text-gray-500"> of days</span>
          </div>
        </div>
        <div className="text-right min-w-0">
          <div className="text-[9px] uppercase tracking-wider text-gray-500">At this hour</div>
          <div className="font-mono text-[11px] text-gray-400 tabular-nums">
            {sample} day{sample === 1 ? "" : "s"} measured
          </div>
        </div>
      </div>

      <div className="flex items-center justify-between gap-2 mt-1.5 text-[10px]">
        <span className="text-gray-500">
          Your {type} <span className="font-mono text-blue-300 font-semibold">{formatGpFull(price)}</span>
        </span>
      </div>

      {/* Only the offer's own price is ruled here. There is no plan, so drawing a second line
          would imply a paired leg that was never chosen. */}
      <SlotShapeChart
        data={data}
        buySlot={slot}
        sellSlot={slot}
        floor={type === "buy" ? price : null}
        ceiling={type === "sell" ? price : null}
      />
    </div>
  );
}
