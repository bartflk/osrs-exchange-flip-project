import { useEffect, useState } from "preact/hooks";
import { fetchSlotProfile, type SlotProfileResponse } from "../api";
import { formatGpFull } from "../format";
import { priceAtFill } from "../fillPricing";
import { SlotPlanSummary } from "./SlotPlanSummary";
import { SlotShapeChart } from "./SlotShapeChart";

// Owns the one fetch for a slot card and hands the same data to both the summary and the chart.
//
// They used to fetch independently, which meant the numbers in the summary and the shape in the
// chart came from two separate responses -- fine while both were read-only, and a guaranteed
// source of disagreement now that a fill-target slider re-prices both from the same sample. One
// fetch, one sample, one answer. The slider then costs nothing: every target is a different
// quantile of data already in memory, so the lines and the profit move as you drag.

export function SlotDetail({
  itemId,
  buySlot,
  sellSlot,
  units,
  fillTarget,
  placed,
}: {
  itemId: number;
  buySlot: number;
  sellSlot: number;
  units: number;
  /** 0-1. The share of days you want the offer to actually fill on. */
  fillTarget: number;
  placed: boolean;
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

  if (failed) {
    return <p className="text-[10px] text-gray-600 mt-1.5">No stored shape for this item.</p>;
  }
  if (!data) return <div className="h-[92px] mt-1.5 rounded bg-white/[0.03] animate-pulse" />;

  const pricing = priceAtFill(data.paired, fillTarget);

  return (
    <>
      {pricing && units > 0 && (
        <SlotPlanSummary
          sellSlot={sellSlot}
          profitPerUnit={pricing.profitPerUnit}
          worstDayProfit={pricing.worstDayProfit}
          winDays={pricing.winDays}
          pairedDays={pricing.days}
          units={units}
          fillRate={pricing.buyFillRate}
          placed={placed}
        />
      )}

      {/* At a high enough fill target the bid crosses above the ask and the band inverts: you are
          paying more to be certain than the round trip is worth. Measured live on Dragonstone
          bolts (e) -- 20% target bids 375 and asks 414 for +121.7k, 95% bids 407 and asks 374 for
          -157.0k. That is not a bug to hide, it is the finding: for most items the edge only
          exists at a fill rate you will not enjoy waiting for. */}
      {pricing && pricing.profitPerUnit <= 0 && (
        <p className="mt-1.5 text-[10px] leading-snug text-rose-300">
          No trade at this fill target: the bid has crossed above the ask. Lower the target, or
          accept that this item only pays when you wait.
        </p>
      )}

      {/* The two numbers the chart's rules represent, spelled out -- a line on a 54px sparkline
          shows the relationship, not the price you have to type into the game. */}
      {pricing && (
        <div className="flex items-center justify-between gap-2 mt-1.5 text-[10px]">
          <span className="text-gray-500">
            Bid{" "}
            <span className="font-mono text-blue-300 font-semibold">
              {formatGpFull(pricing.bid)}
            </span>
          </span>
          <span className="text-gray-500">
            Ask{" "}
            <span className="font-mono text-blue-300 font-semibold">
              {formatGpFull(pricing.ask)}
            </span>
          </span>
        </div>
      )}

      <SlotShapeChart
        data={data}
        buySlot={buySlot}
        sellSlot={sellSlot}
        floor={pricing?.bid ?? null}
        ceiling={pricing?.ask ?? null}
      />
    </>
  );
}
