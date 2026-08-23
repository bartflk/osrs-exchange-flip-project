import { useEffect, useMemo, useState } from "preact/hooks";
import {
  fetchItems,
  fetchOvernightPicks,
  fetchPortfolio,
  type HourlyPick,
  type MarketItem,
  type OvernightPicksResponse,
  type PortfolioResponse,
} from "../api";
import { formatGp, formatGpFull } from "../format";
import {
  slotToDualLabel,
  slotToLocalLabel,
  utcLabelToSlot,
  localZoneLabel,
} from "../timeSlots";
import { useCurrentSlot } from "../useCurrentSlot";
import { allocateCapital } from "../capitalAllocator";
import { NumberInput, GpInput, EmptyState, Chip } from "./ui";
import { GeSlotBoard } from "./GeSlotBoard";
import { SlotShapeChart } from "./SlotShapeChart";
import { buildSlotViews, countNeedsAction, type OvernightPlan } from "../geSlots";
import { rememberPlans } from "../overnightPlans";
import { InfoTip, LabelWithInfo } from "./InfoTip";

// Overnight Trading, Phase 1 -- direct request: "I want the GE screen copied and have Overnight
// positions to buy bottom of the band so i can wake up, set them up to sell them at the top of
// the band in the morning or after i come from work." A standalone page (not a sub-section of
// Buy Signals), mirroring the same 8-slot board -- fed by backend/src/slotProfiles.ts's
// computeOvernightPicks(), the same "buy price vs. that day's mean" band the Bollinger/Item-of-
// the-Hour features already compute, just window-constrained to an actual overnight hold instead
// of a full day. See Design/DESIGN.md's Overnight Trading status note for the full write-up and
// what Phases 2-4 (weekly, month+, Reddit correlation) deliberately don't attempt yet.

function iconUrl(icon: string | null): string {
  if (!icon) return "";
  return `https://oldschool.runescape.wiki/images/${encodeURIComponent(icon.replace(/ /g, "_"))}`;
}

// §14.49: slot rendering moved to the shared timeSlots helper so the bedtime picker, the summary
// line and the sell-at column can't drift apart on what "20:30" means.
function localOf(slotLabel: string): string {
  return slotToLocalLabel(utcLabelToSlot(slotLabel));
}

function loadNumber(key: string, fallback: number): number {
  const raw = localStorage.getItem(key);
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) ? n : fallback;
}

// Risk preset: a client-side floor on the slot-profile volume (units/hr) each pick needs to
// qualify. Direct request: "the items its giving me are high volume items, what about items like
// the nox hally, you CAN buy big ticket items too." Two separate things were true at once here --
// (1) the slot-profiling job itself only ever profiled the 250 most-liquid-by-UNIT-VOLUME items,
// which structurally excludes expensive PvM gear (fixed backend-side, see
// db.ts's getHighValueItemIds -- a second profiling track ranked by price instead), and (2) even
// once profiled, a big-ticket/low-volume pick is a genuinely different risk than a thousand-unit-
// per-hour rune trade (harder to fill both sides, wider real-world slippage than the median-price
// band implies). This preset is the second half: it doesn't hide anything the backend computed,
// it just lets you choose how much of that harder-to-fill tail to include.
type RiskPreset = "conservative" | "balanced" | "aggressive";
const RISK_MIN_VOLUME: Record<RiskPreset, number> = {
  conservative: 500,
  balanced: 50,
  aggressive: 0,
};
const RISK_LABEL: Record<RiskPreset, string> = {
  conservative: "Conservative",
  balanced: "Balanced",
  aggressive: "Aggressive",
};
const RISK_HINT: Record<RiskPreset, string> = {
  conservative: "High-volume staples only — easy to fill both sides, smaller edges.",
  balanced: "A mix of liquid and moderately-traded items.",
  aggressive: "Includes expensive, low-volume PvM gear — bigger edges, slower/harder to fill both sides.",
};

// Turns a ranked overnight pick into a full MarketItem-shaped candidate for allocateCapital() --
// low/net_margin/score are shadow-copied to the OVERNIGHT band's buy/sell prices and edge, not
// the item's live market numbers, since the whole point is planning against tonight's typical
// slot prices rather than this second's tick. allocateCapital() itself is untouched (§ plan).
function toOvernightCandidate(pick: HourlyPick, catalogue: MarketItem[]): MarketItem | null {
  const base = catalogue.find((i) => i.id === pick.itemId);
  if (!base || pick.buyPrice == null || pick.profitPerUnit == null) return null;
  return {
    ...base,
    low: pick.buyPrice,
    high: pick.sellPrice ?? base.high,
    net_margin: pick.profitPerUnit,
    liquidity: pick.volume,
    buy_limit: pick.buyLimit ?? base.buy_limit,
    score: pick.score,
  };
}

export function OvernightTrading({
  items,
  onSelectItem,
}: {
  items: MarketItem[];
  onSelectItem: (item: MarketItem) => void;
}) {
  const [bankroll, setBankroll] = useState(() => loadNumber("bankroll", 10_000_000));
  const [allocationPct, setAllocationPct] = useState(() => loadNumber("allocationPct", 15));
  const [numSlots, setNumSlots] = useState(() => loadNumber("overnightNumSlots", 8));
  const [maxHoldHours, setMaxHoldHours] = useState(() => loadNumber("overnightHoldHours", 8));
  const [bedtimeSlot, setBedtimeSlot] = useState<number | null>(null);
  // §14.50: live, so "now" rolls over on its own instead of freezing at page load.
  const liveSlot = useCurrentSlot();
  const effectiveSlot = bedtimeSlot ?? liveSlot;
  const [riskPreset, setRiskPreset] = useState<RiskPreset>(
    () => (localStorage.getItem("overnightRiskPreset") as RiskPreset | null) ?? "balanced",
  );
  function updateRiskPreset(v: RiskPreset) {
    setRiskPreset(v);
    localStorage.setItem("overnightRiskPreset", v);
  }

  function updateBankroll(v: number) {
    setBankroll(v);
    localStorage.setItem("bankroll", String(v));
  }
  function updateAllocation(v: number) {
    setAllocationPct(v);
    localStorage.setItem("allocationPct", String(v));
  }
  function updateNumSlots(v: number) {
    const clamped = Math.max(1, Math.min(8, v));
    setNumSlots(clamped);
    localStorage.setItem("overnightNumSlots", String(clamped));
  }
  function updateMaxHoldHours(v: number) {
    const clamped = Math.max(2, Math.min(14, v));
    setMaxHoldHours(clamped);
    localStorage.setItem("overnightHoldHours", String(clamped));
  }

  const [picksData, setPicksData] = useState<OvernightPicksResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    setError(null);
    // Fetch the full pool (backend cap 20) regardless of risk preset -- the preset filters
    // client-side, so switching it doesn't need a round trip. Bankroll matters here beyond
    // sizing: the backend re-ranks candidates by what THIS bankroll actually earns
    // (deployableUnits x profitPerUnit), so a stale/default bankroll silently returns the wrong
    // candidate SET, not just the wrong quantities -- this was missed when Overnight was first
    // built and Item of the Hour was later made bankroll-aware without it (§14.46/§14.48).
    fetchOvernightPicks(effectiveSlot, maxHoldHours, 20, bankroll)
      .then((d) => !cancelled && setPicksData(d))
      .catch((e) => !cancelled && setError(e instanceof Error ? e.message : "failed"));
    return () => {
      cancelled = true;
    };
  }, [effectiveSlot, maxHoldHours, bankroll]);

  // The `items` prop is whatever the Market tab's own filter/limit currently returns (a few
  // hundred items, not the full ~4,650 catalogue) -- most overnight picks won't be in it. Same
  // "fetch the specific ids you actually need" pattern App.tsx already uses for watchlist/
  // holdings/alert items, rather than depending on them happening to already be loaded.
  const [pickedItems, setPickedItems] = useState<MarketItem[]>([]);
  useEffect(() => {
    const ids = picksData?.picks.map((p) => p.itemId) ?? [];
    if (ids.length === 0) return;
    let cancelled = false;
    fetchItems({ ids })
      .then((res) => !cancelled && setPickedItems(res.items))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [picksData]);

  const catalogue = useMemo(() => {
    const byId = new Map(items.map((i) => [i.id, i]));
    for (const i of pickedItems) byId.set(i.id, i);
    return [...byId.values()];
  }, [items, pickedItems]);

  // Same live-portfolio pattern as BuySignals: real GE slots can't be double-planned into, and
  // cash already committed to open buy offers is already spent.
  const [portfolio, setPortfolio] = useState<PortfolioResponse | null>(null);
  useEffect(() => {
    let cancelled = false;
    function load() {
      fetchPortfolio()
        .then((p) => !cancelled && setPortfolio(p))
        .catch(() => {});
    }
    load();
    const id = setInterval(load, 20_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  const occupiedSlots = portfolio?.slots.length ?? 0;
  const suggestionSlots = Math.max(0, numSlots - occupiedSlots);
  const committedGp = portfolio?.totals.cashInBuyOffers ?? 0;
  const availableBankroll = Math.max(0, bankroll - committedGp);
  const trackedNames = useMemo(() => {
    const names = new Set<string>();
    for (const s of portfolio?.slots ?? []) names.add(s.name.toLowerCase());
    for (const p of portfolio?.positions ?? []) names.add(p.name.toLowerCase());
    return names;
  }, [portfolio]);
  const remainingLimits = useMemo(() => {
    const map = new Map<number, number>();
    for (const b of portfolio?.buyLimits ?? []) {
      if (b.remaining != null) map.set(b.itemId, b.remaining);
    }
    return map;
  }, [portfolio]);

  const riskFilteredPicks = useMemo(() => {
    if (!picksData) return [];
    const minVolume = RISK_MIN_VOLUME[riskPreset];
    return picksData.picks.filter((p) => p.volume >= minVolume);
  }, [picksData, riskPreset]);

  // The board renders allocator assignments (item + qty), which carry no timing information --
  // the buy/sell slots live on the pick that produced them. Keyed by item id so a card can find
  // its own history without threading picks through the shared board component.
  const pickById = useMemo(
    () => new Map(riskFilteredPicks.map((p) => [p.itemId, p])),
    [riskFilteredPicks],
  );

  // Plans are built from the UNFILTERED pick list on purpose. Once you place an overnight offer,
  // that item leaves the allocator's candidates (it already holds a slot) and can also fall out
  // of the risk-preset filter -- and both of those would silently strip the plan from an offer
  // you placed *because of* the plan, putting the board straight back to demanding a reprice.
  const plans = useMemo(() => {
    const current: OvernightPlan[] = [];
    for (const p of picksData?.picks ?? []) {
      if (p.bestSellSlot == null) continue;
      current.push({
        itemId: p.itemId,
        buyPrice: p.buyPrice,
        sellPrice: p.sellPrice,
        buySlotLabel: slotToLocalLabel(p.slot),
        sellSlotLabel: slotToLocalLabel(p.bestSellSlot),
        buySlot: p.slot,
        sellSlot: p.bestSellSlot,
      });
    }
    // Remembered, not just read: an offer you placed on plan must keep its plan when the bankroll,
    // risk preset or bedtime changes and the item leaves the live pick list. See overnightPlans.ts.
    return rememberPlans(current);
  }, [picksData]);

  const candidates = useMemo(() => {
    return riskFilteredPicks
      .map((p) => toOvernightCandidate(p, catalogue))
      .filter((c): c is MarketItem => c != null);
  }, [riskFilteredPicks, catalogue]);

  const allocation = useMemo(
    () =>
      allocateCapital(candidates, {
        bankroll: availableBankroll,
        numSlots: suggestionSlots,
        maxAllocationPct: allocationPct,
        excludeNames: trackedNames,
        remainingLimits,
        // "put all my money to work" -- prefer candidates whose GE buy limit can actually absorb
        // a real fraction of the bankroll, not just the highest-edge pick regardless of how
        // little of it the real GE will let you buy in one 4h window.
        maximizeUtilization: true,
      }),
    [candidates, availableBankroll, suggestionSlots, allocationPct, trackedNames, remainingLimits],
  );

  // Even with the above, a large bankroll over few slots can be capped by GE buy limits
  // themselves -- a hard game rule, not something any ranking can get around. Surface why, rather
  // than showing a big "idle" number with no explanation.
  const totalCapacity = useMemo(
    () =>
      candidates.reduce((sum, c) => {
        const limit = Math.min(c.buy_limit ?? Infinity, remainingLimits.get(c.id) ?? Infinity);
        const capForItem = availableBankroll * (allocationPct / 100);
        return sum + Math.min(capForItem, limit * (c.low ?? 0));
      }, 0),
    [candidates, remainingLimits, availableBankroll, allocationPct],
  );
  const limitedByBuyLimits =
    suggestionSlots > 0 && allocation.remainingBankroll > availableBankroll * 0.1 && totalCapacity < availableBankroll;

  const needsAction = useMemo(
    () => countNeedsAction(buildSlotViews(portfolio?.slots ?? [], [], catalogue, plans)),
    [portfolio, catalogue, plans],
  );

  const isNow = effectiveSlot === liveSlot;

  return (
    <div>
      <div className="glass rounded-xl p-4 mb-4 flex flex-wrap items-end gap-6">
        <label className="text-xs text-gray-400 flex flex-col gap-1">
          Bankroll (gp)
          <GpInput value={bankroll} onChange={updateBankroll} className="w-40" />
        </label>
        <label className="text-xs text-gray-400 flex flex-col gap-1">
          Max allocation per item (%)
          <NumberInput value={allocationPct} onChange={updateAllocation} className="w-24" />
        </label>
        <label className="text-xs text-gray-400 flex flex-col gap-1">
          GE slots
          <NumberInput value={numSlots} onChange={updateNumSlots} className="w-20" />
        </label>
        <label className="text-xs text-gray-400 flex flex-col gap-1">
          Buy time (bedtime) <span className="text-gray-600">({localZoneLabel()})</span>
          <div className="flex items-center gap-1.5">
            <select
              value={effectiveSlot}
              onChange={(e) => setBedtimeSlot(Number((e.target as HTMLSelectElement).value))}
              className="bg-white/5 border border-white/10 rounded-lg px-2 py-1.5 text-xs text-gray-200"
            >
              {/* §14.49: your clock first -- nobody picks a bedtime in UTC. The UTC value stays
                  visible because the API, the slot data and every design note are keyed on it. */}
              {Array.from({ length: 48 }, (_, i) => (
                <option key={i} value={i}>
                  {slotToDualLabel(i)}
                </option>
              ))}
            </select>
            {bedtimeSlot != null && (
              <button
                onClick={() => setBedtimeSlot(null)}
                className="text-xs text-violet-400 hover:text-violet-300"
              >
                now
              </button>
            )}
          </div>
        </label>
        <label className="text-xs text-gray-400 flex flex-col gap-1">
          Max hold (hours)
          <NumberInput value={maxHoldHours} onChange={updateMaxHoldHours} className="w-20" />
        </label>
        <label className="text-xs text-gray-400 flex flex-col gap-1">
          Risk preset
          <div className="flex items-center gap-1.5">
            {(Object.keys(RISK_LABEL) as RiskPreset[]).map((r) => (
              <Chip key={r} active={riskPreset === r} onClick={() => updateRiskPreset(r)}>
                {RISK_LABEL[r]}
              </Chip>
            ))}
          </div>
        </label>
        <p className="text-xs text-gray-500 max-w-sm">
          Buy near each item's typical price at your bedtime slot, sell near its typical price at
          the best slot within the hold window — a real (if approximate) band, not a live tick.
          {" "}
          {RISK_HINT[riskPreset]}
        </p>
      </div>

      <div className="glass rounded-xl p-4 mb-4">
        <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
          <h3 className="text-sm font-medium text-gray-200">
            Overnight board —{" "}
            {suggestionSlots > 0
              ? `${suggestionSlots} free slot${suggestionSlots === 1 ? "" : "s"} to fill`
              : "all slots in use"}
            {picksData && (
              <span className="ml-2 text-xs text-gray-500 font-normal">
                buying at {localOf(picksData.bedtimeSlotLabel)} {localZoneLabel()} (
                {picksData.bedtimeSlotLabel} UTC){isNow ? " · now" : ""} · up to{" "}
                {picksData.maxHoldHours}h hold ·{" "}
                {picksData.itemsProfiled} items profiled · sized for {formatGp(picksData.bankroll)}
              </span>
            )}
            {needsAction > 0 && (
              <span className="ml-2 text-xs font-semibold text-amber-400">
                {needsAction} needs action
              </span>
            )}
          </h3>
        </div>

        {error && <p className="text-xs text-rose-400">{error}</p>}

        {picksData && picksData.itemsProfiled === 0 && (
          <EmptyState
            title="No item profiles yet"
            hint="Slot profiles build in the background after startup (up to 250 liquid items, refreshed every 12h) — check back shortly."
          />
        )}

        {(!picksData || picksData.itemsProfiled > 0) && (
          <GeSlotBoard
            slots={portfolio?.slots ?? []}
            suggestions={allocation.assignments}
            items={catalogue}
            onSelectItem={onSelectItem}
            showHeader={false}
            plans={plans}
            // The whole point of this page is a position you sleep through, so each box shows the
            // daily price shape it is betting on and how that exact round trip actually went, day
            // by day. Only suggested boxes get one: a live offer already in the GE is a decision
            // you have made, and its history is no longer the question.
            renderExtra={(v) => {
              // Suggested boxes show the shape they are proposing; a box already running the
              // plan shows the same shape, because "when do I sell this" is exactly the question
              // once the buy is placed.
              const id = v.suggestion?.item.id ?? (v.status === "onplan" ? v.slot?.itemId : null);
              if (id == null) return null;
              const pick = pickById.get(id) ?? picksData?.picks.find((p) => p.itemId === id);
              // Live pick first; otherwise the remembered plan, so a position you are already
              // holding keeps its chart even after the item drops out of the current ranking.
              const buy = pick ? pick.slot : plans.get(id)?.buySlot;
              const sell = pick ? pick.bestSellSlot : plans.get(id)?.sellSlot;
              if (buy == null || sell == null) return null;
              return <SlotShapeChart itemId={id} buySlot={buy} sellSlot={sell} />;
            }}
          />
        )}

        <div className="grid grid-cols-3 gap-3 mt-3 text-xs">
          <div>
            <div className="text-gray-500">Spend</div>
            <div className="font-mono text-gray-200">{formatGp(allocation.totalCost)}</div>
          </div>
          <div>
            <div className="text-gray-500">Projected overnight profit</div>
            <div className="font-mono text-emerald-400">{formatGp(allocation.totalProfit)}</div>
          </div>
          <div>
            <div className="text-gray-500 inline-flex items-center gap-1">
              Idle bankroll
              <InfoTip id="maximizeUtilization" />
            </div>
            <div className="font-mono text-gray-400">{formatGp(allocation.remainingBankroll)}</div>
          </div>
        </div>

        {limitedByBuyLimits && (
          <p className="text-[11px] text-amber-400/90 mt-2">
            Capped by GE buy limits, not by bankroll — with {suggestionSlots} slot
            {suggestionSlots === 1 ? "" : "s"} available, the current candidates can only absorb
            about {formatGp(totalCapacity)} between them (each item has a hard 4h purchase limit).
            More slots, or an "Aggressive" risk preset that reaches pricier items, would let more
            of the bankroll get used.
          </p>
        )}
      </div>

      {/* Raw ranked picks feeding the board above, so every slot's price/edge can be checked
          against the real numbers rather than taken on faith -- same transparency principle as
          Item of the Hour. */}
      {riskFilteredPicks.length > 0 && (
        <div className="glass rounded-xl p-4">
          <h3 className="text-sm font-medium text-gray-200 mb-3">
            Ranked overnight candidates
            <span className="ml-2 text-xs text-gray-500 font-normal">
              {riskFilteredPicks.length} of {picksData?.picks.length ?? 0} pass the {RISK_LABEL[riskPreset].toLowerCase()} volume floor
            </span>
          </h3>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-[11px] uppercase tracking-wide text-gray-500 text-left">
                  <th className="pb-2 pr-3 font-medium">Item</th>
                  <th className="pb-2 pr-3 font-medium text-right">Buy @</th>
                  <th className="pb-2 pr-3 font-medium text-right">Sell @</th>
                  <th className="pb-2 pr-3 font-medium text-right">Sell at ({localZoneLabel()})</th>
                  <th className="pb-2 pr-3 font-medium text-right">Hold</th>
                  <th className="pb-2 pr-3 font-medium text-right">
                    <LabelWithInfo id="timingEdge">Profit/u</LabelWithInfo>
                  </th>
                  <th className="pb-2 pr-3 font-medium text-right">
                    <LabelWithInfo id="timingEdge">Edge</LabelWithInfo>
                  </th>
                    <th className="pb-2 pr-3 font-medium text-right">
                    <LabelWithInfo id="daysWon">Days won</LabelWithInfo>
                  </th>
                  <th className="pb-2 pr-3 font-medium text-right">
                    <LabelWithInfo id="deployableUnits">Buy qty</LabelWithInfo>
                  </th>
                  <th className="pb-2 pr-3 font-medium text-right">Capital</th>
                  <th className="pb-2 font-medium text-right">Profit</th>
                </tr>
              </thead>
              <tbody>
                {riskFilteredPicks.map((p) => (
                  <tr
                    key={p.itemId}
                    onClick={() => {
                      const match = catalogue.find((i) => i.id === p.itemId);
                      if (match) onSelectItem(match);
                    }}
                    className="border-t border-white/5 hover:bg-white/5 cursor-pointer"
                  >
                    <td className="py-2 pr-3">
                      <div className="flex items-center gap-2">
                        {p.icon && (
                          <img src={iconUrl(p.icon)} alt="" className="w-4 h-4 object-contain" />
                        )}
                        <span className="text-gray-200 whitespace-nowrap">{p.name}</span>
                      </div>
                    </td>
                    <td className="py-2 pr-3 text-right font-mono text-gray-300">
                      {p.buyPrice != null ? formatGpFull(p.buyPrice) : "—"}
                    </td>
                    <td className="py-2 pr-3 text-right font-mono text-violet-300">
                      {p.sellPrice != null ? formatGpFull(p.sellPrice) : "—"}
                    </td>
                    <td className="py-2 pr-3 text-right font-mono text-violet-300">
                      {p.bestSellSlotLabel ? slotToLocalLabel(utcLabelToSlot(p.bestSellSlotLabel)) : "—"}
                    </td>
                    <td className="py-2 pr-3 text-right font-mono text-gray-400">
                      {p.holdHours != null ? `${p.holdHours}h` : "—"}
                    </td>
                    <td className="py-2 pr-3 text-right font-mono text-gray-200">
                      {p.profitPerUnit != null ? formatGpFull(p.profitPerUnit) : "—"}
                    </td>
                    <td className="py-2 pr-3 text-right font-mono text-emerald-400">
                      {p.timingEdgePct != null ? `${(p.timingEdgePct * 100).toFixed(2)}%` : "—"}
                    </td>
                      {/* §14.51: the sample, next to the claim. "4/7 days" is the difference
                          between a pattern and a coincidence, and it costs one column. */}
                      <td
                        className={`py-2 pr-3 text-right font-mono ${
                          p.pairedDays > 0 && p.winDays / p.pairedDays >= 0.7
                            ? "text-emerald-400"
                            : p.pairedDays > 0 && p.winDays / p.pairedDays <= 0.5
                              ? "text-amber-400"
                              : "text-gray-400"
                        }`}
                        title={
                        `Median of ${p.pairedDays} days where both the buy and sell slot had a reading` +
                        (p.pairedSpanDays > p.pairedDays
                          ? `, spread across ${p.pairedSpanDays} calendar days`
                          : "")
                      }
                      >
                        {p.pairedDays > 0 ? `${p.winDays}/${p.pairedDays}` : "—"}
                      </td>
                    {/* Units this bankroll can actually take (buy limit or affordability,
                        whichever binds), what that ties up, and what it earns -- same bankroll-
                        aware sizing Item of the Hour uses (§14.46), not a percentage. Amber when
                        the position is a large share of the slot's typical volume: past that
                        point you're setting the price, not taking it. */}
                    <td
                      className={`py-2 pr-3 text-right font-mono ${
                        p.fillShare != null && p.fillShare > 0.5 ? "text-amber-400" : "text-gray-300"
                      }`}
                      title={
                        p.fillShare != null
                          ? `${(p.fillShare * 100).toFixed(0)}% of this slot's typical volume (${p.volume.toLocaleString()}/30m)`
                          : undefined
                      }
                    >
                      {p.deployableUnits.toLocaleString()}
                    </td>
                    <td className="py-2 pr-3 text-right font-mono text-gray-400">
                      {formatGp(p.capitalUsed)}
                    </td>
                    <td className="py-2 text-right font-mono text-emerald-300">
                      {formatGp(p.cycleProfit)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-[10px] text-gray-600 mt-2 leading-relaxed">
            Same method as Item of the Hour, window-constrained to an actual overnight hold:
            median buy/sell price per half-hour slot over the last ~7.6 days, detrended per day
            and aggregated with a median. "Edge" is the real after-tax return — it requires
            holding for the stated time, not an instant margin.
          </p>
        </div>
      )}
    </div>
  );
}
