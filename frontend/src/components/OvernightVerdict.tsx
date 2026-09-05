import { useEffect, useState } from "preact/hooks";
import { fetchItemOvernight, type ForecastResponse, type OvernightVerdict } from "../api";
import { formatGp } from "../format";

// Should you hold THIS item overnight, in one line, with the numbers that decide it underneath.
//
// The ranked board answers "what are the best eight tonight". Looking at an item's chart raises a
// different question, "what about this one", and an absence from a top-eight list is not an answer
// to it: an item can be missing because it failed a gate, because it has no profile yet, or simply
// because nine others scored higher. Those are three different facts and the reader needs to know
// which one they are looking at.
//
// The verdict comes from the same gate function the board runs, with the same bankroll and hold
// window. Nothing is recomputed here, so this panel and that board cannot disagree.

function Stat({
  label,
  value,
  tone = "text-gray-200",
  title,
}: {
  label: string;
  value: string;
  tone?: string;
  title?: string;
}) {
  return (
    <div title={title}>
      <div className="text-[10px] uppercase tracking-wider text-gray-500">{label}</div>
      <div className={`font-mono text-sm tabular-nums ${tone}`}>{value}</div>
    </div>
  );
}

/**
 * What the forecast band says about the hold, expressed as a downside rather than a direction.
 *
 * Deliberately not a second verdict. The band is a statement about volatility, not about whether
 * a trade is good, and the two get confused the moment they sit next to each other. Framed as
 * "the bad case" because that is the only thing a band can honestly contribute to a decision you
 * will be asleep for.
 */
function BandRisk({
  forecast,
  reference,
  referenceLabel,
}: {
  forecast: ForecastResponse;
  /** Price the band is measured against: the plan's buy price, or today's if there is no plan. */
  reference: number | null;
  referenceLabel: string;
}) {
  const last = forecast.points[forecast.points.length - 1];
  if (!last || !reference || reference <= 0) return null;

  const buyPrice = reference;
  const downside = (last.outerLow - buyPrice) / buyPrice;
  const upside = (last.outerHigh - buyPrice) / buyPrice;
  const noisy = forecast.flatShare > 0.5;

  return (
    <div className="mt-3 pt-3 border-t border-white/8">
      <div className="text-[10px] uppercase tracking-wider text-gray-500 mb-1.5">
        Where the band puts it in {forecast.horizonHours}h
        <span className="normal-case tracking-normal text-gray-600">
          {" "}
          against {referenceLabel}, from {forecast.historicalSamples} half-hour steps
        </span>
      </div>
      <div className="grid grid-cols-3 gap-3">
        <Stat
          label="Bad case"
          value={`${(downside * 100).toFixed(1)}%`}
          tone={downside < -0.02 ? "text-rose-400" : "text-gray-300"}
          title="10th percentile of the projected band against your buy price. One night in ten lands below this if the item keeps behaving as it has."
        />
        <Stat
          label="Median"
          value={`${(((last.mid - buyPrice) / buyPrice) * 100).toFixed(1)}%`}
          title="The drift, carried forward. Not a prediction of direction, just where the middle of the band sits."
        />
        <Stat
          label="Good case"
          value={`${(upside * 100).toFixed(1)}%`}
          tone="text-gray-300"
          title="90th percentile of the projected band against your buy price."
        />
      </div>
      {noisy && (
        <p className="text-[10px] text-amber-400/80 mt-1.5">
          {Math.round(forecast.flatShare * 100)}% of half-hour steps had no price change at all, so
          this band is describing an item that mostly sits still. Treat its width as a floor.
        </p>
      )}
    </div>
  );
}

export function OvernightVerdictPanel({
  itemId,
  bankroll,
  maxHoldHours = 8,
  forecast,
  currentPrice,
}: {
  itemId: number;
  bankroll: number;
  maxHoldHours?: number;
  forecast?: ForecastResponse | null;
  /**
   * Today's price, used as the band's reference when there is no plan to measure against.
   *
   * Without this the band only appeared on items that already passed every gate, which is exactly
   * backwards: the reader looking at an item the board rejected is the one who most wants to know
   * how far it might move tonight.
   */
  currentPrice?: number | null;
}) {
  const [data, setData] = useState<OvernightVerdict | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setData(null);
    setFailed(false);
    fetchItemOvernight(itemId, { bankroll, maxHoldHours })
      .then((d) => !cancelled && setData(d))
      .catch(() => !cancelled && setFailed(true));
    return () => {
      cancelled = true;
    };
  }, [itemId, bankroll, maxHoldHours]);

  if (failed) return null;
  if (!data) {
    return (
      <div className="glass rounded-xl p-4 mb-4 text-[11px] text-gray-600">
        Checking overnight suitability…
      </div>
    );
  }

  const pick = data.pick;
  const good = pick != null;

  return (
    <div className="glass rounded-xl p-4 mb-4">
      <div className="flex items-center gap-3 flex-wrap">
        <span
          className={`px-2.5 py-1 rounded-lg text-xs font-semibold uppercase tracking-wide ${
            good
              ? "bg-emerald-500/15 text-emerald-300 border border-emerald-400/40"
              : "bg-white/5 text-gray-400 border border-white/10"
          }`}
        >
          {good ? "Overnight buy" : "Not tonight"}
        </span>
        <span className="text-[11px] text-gray-500">
          buying at {data.slotLabel}, holding up to {data.maxHoldHours}h
        </span>
      </div>

      {good && pick ? (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mt-3">
            <Stat
              label="Edge after tax"
              value={`${((pick.timingEdgePct ?? 0) * 100).toFixed(2)}%`}
              tone="text-emerald-400"
              title="Median paired-day return: sell price minus GE tax minus buy price, over the buy price."
            />
            <Stat
              label="Won"
              value={`${pick.winDays}/${pick.pairedDays} days`}
              title="Days in the sample where this buy-and-sell pair actually made money. The gate is 80%."
            />
            <Stat
              label="Fills"
              value={pick.fillRate == null ? "n/a" : `${Math.round(pick.fillRate * 100)}%`}
              tone={
                pick.fillRate != null && pick.fillRate < 0.4 ? "text-amber-300" : "text-gray-200"
              }
              title="Share of measured days the market came down to this bid. The price quoted is a median, so this sits near half; below that the offer more often just sits there."
            />
            <Stat
              label="Your cycle"
              value={formatGp(pick.cycleProfit)}
              title="What this earns YOUR bankroll for one buy-limit cycle, after tax. Percentage edge is the wrong objective when capital is the binding constraint."
            />
          </div>

          {/* The worst measured day, always. A median hides it completely, and a position you
              sleep through cannot be reacted to, so the bad day is the number that decides
              whether the size is sane. */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mt-3 pt-3 border-t border-white/8">
            <Stat
              label="Buy at"
              value={formatGp(pick.buyPrice ?? 0)}
              title="Median low at this slot. The plan price."
            />
            <Stat
              label="Sell at"
              value={`${formatGp(pick.sellPrice ?? 0)} · ${pick.bestSellSlotLabel ?? ""}`}
            />
            <Stat
              label="Worst day"
              value={`${formatGp(pick.worstDayProfit)}/unit`}
              tone={pick.worstDayProfit < 0 ? "text-rose-400" : "text-gray-300"}
              title="The worst single day in the sample, per unit, after tax. This is what a bad night costs."
            />
            <Stat
              label="vs live"
              value={
                pick.liveDriftPct == null ? "n/a" : `${(pick.liveDriftPct * 100).toFixed(1)}%`
              }
              title="How far the plan price sits from today's market. Rejected past 2% in either direction: above it the bid never fills, below it the bid fills instantly and overpays."
            />
          </div>
        </>
      ) : (
        <p className="text-[11px] text-gray-400 mt-2 max-w-2xl">
          {data.reason}
          {!data.profiled && (
            <span className="text-gray-600">
              {" "}
              A profile is being built now; check back after the next refresh.
            </span>
          )}
        </p>
      )}

      {forecast && forecast.points.length > 0 && (
        <BandRisk
          forecast={forecast}
          reference={pick?.buyPrice ?? currentPrice ?? null}
          referenceLabel={pick?.buyPrice ? "the plan's buy price" : "today's price"}
        />
      )}

      <p className="text-[10px] text-gray-600 mt-2">
        Same gates as the ranked overnight board, so this cannot disagree with it. A pass is not a
        promise: it means the pattern held on the days measured, and the worst day above is what it
        cost when it did not.
      </p>
    </div>
  );
}
