import { useCallback, useEffect, useMemo, useState } from "preact/hooks";
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
  formatWait,
  msUntilSlot,
  slotToLocalLabel,
  utcLabelToSlot,
} from "../timeSlots";
import { useCurrentSlot } from "../useCurrentSlot";
import { allocateCapital } from "../capitalAllocator";
import { NumberInput, GpInput, EmptyState, Chip, Panel, Toolbar, Field, Select } from "./ui";
import { GeSlotBoard } from "./GeSlotBoard";
import { SlotDetail } from "./SlotDetail";
import { OfferOutlook } from "./OfferOutlook";
import { buildSlotViews, countNeedsAction, type OvernightPlan } from "../geSlots";
import { rememberPlans } from "../overnightPlans";
import { InfoTip, LabelWithInfo } from "./InfoTip";
import type { ExplanationId } from "../explanations";

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

// One cell shape for both summary panels: fixed label size, tabular numerals, sub-line always
// present. The panels sit side by side, so any difference between them reads as meaning.
function Figure({
  label,
  value,
  sub,
  tone,
  explain,
}: {
  label: string;
  value: string;
  sub: string;
  tone: string;
  explain?: ExplanationId;
}) {
  return (
    <div className="min-w-0">
      <div className="flex items-center gap-1 text-[9px] uppercase tracking-wider text-gray-500">
        <span className="truncate">{label}</span>
        {explain && <InfoTip id={explain} />}
      </div>
      <div className={`font-mono text-lg font-semibold tabular-nums leading-tight truncate ${tone}`}>
        {value}
      </div>
      <div className="text-[10px] text-gray-600 truncate">{sub}</div>
    </div>
  );
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
  conservative: "High-volume staples only, easy to fill both sides, smaller edges.",
  balanced: "A mix of liquid and moderately-traded items.",
  aggressive: "Includes expensive, low-volume PvM gear, bigger edges, slower/harder to fill both sides.",
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
  // How often you want the offer to actually fill, as a share of measured days. 50% is the old
  // fixed behaviour (the plan quoted the median), kept as the default so nothing changes for
  // anyone who never touches the dial.
  const [fillTarget, setFillTarget] = useState(() => loadNumber("overnightFillTarget", 50));
  function updateFillTarget(v: number) {
    setFillTarget(Math.max(10, Math.min(95, v)));
  }
  // Persisted on a trailing timer rather than on every input event. localStorage.setItem is a
  // synchronous write, and dragging a range input fires it on every step -- with eight slot cards
  // re-rendering their SVGs on the same tick, that write lands right in the middle of the frame
  // and the drag stutters. The value the user sees updates immediately; only the save waits.
  useEffect(() => {
    const id = setTimeout(
      () => localStorage.setItem("overnightFillTarget", String(fillTarget)),
      400,
    );
    return () => clearTimeout(id);
  }, [fillTarget]);
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

  // The `items` prop is whatever the Market tab's own filter/limit currently returns (a few
  // hundred items, not the full ~4,650 catalogue) -- most overnight picks won't be in it. Same
  // "fetch the specific ids you actually need" pattern App.tsx already uses for watchlist/
  // holdings/alert items, rather than depending on them happening to already be loaded.
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

  const [pickedItems, setPickedItems] = useState<MarketItem[]>([]);
  useEffect(() => {
    // Items sitting in a real GE slot are fetched too, not just ranked picks. Clicking a tile
    // resolves the item through this catalogue, so an offer placed from another tool -- whose
    // item is usually below the Market tab's liquidity filter and therefore absent -- silently
    // did nothing when clicked. Found live on a Sanguinesti staff (uncharged) tile.
    const ids = [
      ...new Set([
        ...(picksData?.picks.map((p) => p.itemId) ?? []),
        ...(portfolio?.slots.map((sl) => sl.itemId) ?? []),
      ]),
    ];
    if (ids.length === 0) return;
    let cancelled = false;
    fetchItems({ ids })
      .then((res) => !cancelled && setPickedItems(res.items))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [picksData, portfolio]);

  const catalogue = useMemo(() => {
    const byId = new Map(items.map((i) => [i.id, i]));
    for (const i of pickedItems) byId.set(i.id, i);
    return [...byId.values()];
  }, [items, pickedItems]);

  const occupiedSlots = portfolio?.slots.length ?? 0;
  const suggestionSlots = Math.max(0, numSlots - occupiedSlots);
  const committedGp = portfolio?.totals.cashInBuyOffers ?? 0;
  const availableBankroll = Math.max(0, bankroll - committedGp);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    // Fetch the full pool (backend cap 20) regardless of risk preset -- the preset filters
    // client-side, so switching it doesn't need a round trip.
    //
    // Ranked against what is still SPENDABLE, not the whole bankroll, and that distinction is
    // the entire feature. The backend re-ranks candidates by what the given bankroll actually
    // earns (deployableUnits x profitPerUnit), so passing the full figure returns a list sized
    // for money that is already committed. Measured live: with 326m set and 310m of it already
    // in three big-ticket offers, exactly ONE of the twenty returned picks cost less than the
    // 15.8m still free -- so five empty slots sat unfillable next to idle cash, because every
    // candidate the allocator had been handed was one the user could no longer buy.
    //
    // With nothing committed this is identical to the old behaviour, since available == bankroll.
    fetchOvernightPicks(effectiveSlot, maxHoldHours, 20, availableBankroll || bankroll)
      .then((d) => !cancelled && setPicksData(d))
      .catch((e) => !cancelled && setError(e instanceof Error ? e.message : "failed"));
    return () => {
      cancelled = true;
    };
  }, [effectiveSlot, maxHoldHours, availableBankroll, bankroll]);
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
        profitPerUnit: p.profitPerUnit ?? undefined,
        fillRate: p.fillRate,
        worstDayProfit: p.worstDayProfit,
        winDays: p.winDays,
        pairedDays: p.pairedDays,
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

  // The headline used to sum only the allocator's SUGGESTIONS, so a board with 310m already
  // working in three big-ticket offers reported "projected overnight profit 254.6k" -- the value
  // of the four leftover slots, and about 3% of what the board was actually carrying. Positions
  // already placed are the majority of the plan, not an afterthought to it.
  // A slot's economics come from the live pick when it is still ranked, and from the remembered
  // plan when it is not -- which is the normal state for anything already bought, since picks are
  // ranked against the cash still free (§14.56).
  const economicsFor = useCallback(
    (itemId: number) => {
      const pick = pickById.get(itemId) ?? picksData?.picks.find((p) => p.itemId === itemId);
      if (pick && pick.profitPerUnit != null && pick.bestSellSlot != null) {
        return {
          sellSlot: pick.bestSellSlot,
          profitPerUnit: pick.profitPerUnit,
          worstDayProfit: pick.worstDayProfit,
          winDays: pick.winDays,
          pairedDays: pick.pairedDays,
          fillRate: pick.fillRate,
        };
      }
      const plan = plans.get(itemId);
      if (plan?.sellSlot != null && plan.profitPerUnit != null) {
        return {
          sellSlot: plan.sellSlot,
          profitPerUnit: plan.profitPerUnit,
          worstDayProfit: plan.worstDayProfit ?? 0,
          winDays: plan.winDays ?? 0,
          pairedDays: plan.pairedDays ?? 0,
          fillRate: plan.fillRate ?? null,
        };
      }
      return null;
    },
    [pickById, picksData, plans],
  );

  const boardOutlook = useMemo(() => {
    // Held and suggested are reported SEPARATELY, not summed. Direct request: *"I want to see the
    // expected profit from the ITEMS i have in the GE right NOW and not the items i CAN fill in."*
    // They are different kinds of claim -- one is money already committed and running, the other
    // is a proposal you have not accepted -- and a single blended figure answers neither. The
    // previous total was worse still: it counted only the proposal.
    const held = { capital: 0, expected: 0, worst: 0, offers: 0, unknown: 0, selling: 0 };
    for (const slot of portfolio?.slots ?? []) {
      if (slot.type === "sell") {
        held.selling += 1;
        continue;
      }
      held.offers += 1;
      held.capital += slot.price * slot.totalQuantity;
      const e = economicsFor(slot.itemId);
      // An offer with no plan behind it (placed by hand, or its plan aged out) contributes
      // capital but not profit, and is counted so the figure can say what it excludes rather
      // than quietly under-reporting.
      if (!e) {
        held.unknown += 1;
        continue;
      }
      held.expected += e.profitPerUnit * slot.totalQuantity;
      held.worst += e.worstDayProfit * slot.totalQuantity;
    }

    const suggested = { capital: allocation.totalCost, expected: allocation.totalProfit, worst: 0 };
    for (const a of allocation.assignments) {
      const e = economicsFor(a.item.id);
      if (e) suggested.worst += e.worstDayProfit * a.qty;
    }

    return { held, suggested };
  }, [allocation, portfolio, economicsFor]);

  // When to actually come back: the earliest sell slot across everything on the board, held or
  // suggested. "Check back at 10:30" is the question the whole page exists to answer, and it was
  // only derivable by reading eight cards and taking the minimum yourself.
  const nextCheck = useMemo(() => {
    let bestSlot: number | null = null;
    let bestWait = Infinity;
    const consider = (sellSlot: number | null | undefined) => {
      if (sellSlot == null) return;
      const wait = msUntilSlot(sellSlot);
      if (wait < bestWait) {
        bestWait = wait;
        bestSlot = sellSlot;
      }
    };
    // Only positions you are actually holding decide when to come back. A suggestion you have not
    // placed has no sell time to wake up for.
    for (const slot of portfolio?.slots ?? []) {
      if (slot.type !== "buy") continue;
      consider(economicsFor(slot.itemId)?.sellSlot);
    }
    return bestSlot == null ? null : { slot: bestSlot as number, wait: bestWait };
  }, [portfolio, economicsFor]);

  return (
    <div>
      <Toolbar
        aside={
          <>
            Buy near each item&apos;s typical price at your bedtime slot, sell near its typical
            price at the best slot within the hold window — a real (if approximate) band, not a
            live tick. {RISK_HINT[riskPreset]}
          </>
        }
      >
        <Field label="Bankroll">
          <GpInput value={bankroll} onChange={updateBankroll} className="w-36" />
        </Field>
        <Field label="Max per item">
          <NumberInput value={allocationPct} onChange={updateAllocation} className="w-20" />
          <span className="text-xs text-gray-500">%</span>
        </Field>
        <Field label="GE slots">
          <NumberInput value={numSlots} onChange={updateNumSlots} className="w-16" />
        </Field>
        <Field label="Buy time">
          <Select
            value={effectiveSlot}
            onChange={(e) => setBedtimeSlot(Number((e.target as HTMLSelectElement).value))}
          >
            {/* Your clock, and only your clock -- the UTC half was noise at the point of use. */}
            {Array.from({ length: 48 }, (_, i) => (
              <option key={i} value={i}>
                {slotToLocalLabel(i)}
              </option>
            ))}
          </Select>
          {bedtimeSlot != null && (
            <button
              onClick={() => setBedtimeSlot(null)}
              className="text-xs text-violet-400 hover:text-violet-300"
            >
              now
            </button>
          )}
        </Field>
        <Field label="Max hold">
          <NumberInput value={maxHoldHours} onChange={updateMaxHoldHours} className="w-16" />
          <span className="text-xs text-gray-500">hours</span>
        </Field>
        <Field label="Fill target" hint="higher = bid up, ask down, fills more often">
          <input
            type="range"
            min={10}
            max={95}
            step={5}
            value={fillTarget}
            onInput={(e) => updateFillTarget(Number((e.target as HTMLInputElement).value))}
            className="w-32 accent-blue-400 cursor-pointer"
          />
          <span className="font-mono text-sm text-blue-300 tabular-nums w-10">{fillTarget}%</span>
        </Field>
        <Field label="Risk preset">
          {(Object.keys(RISK_LABEL) as RiskPreset[]).map((r) => (
            <Chip key={r} active={riskPreset === r} onClick={() => updateRiskPreset(r)}>
              {RISK_LABEL[r]}
            </Chip>
          ))}
        </Field>
      </Toolbar>

      <Panel className="mb-4">
        <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
          <h3 className="text-sm font-semibold text-gray-100">
            Overnight board:{" "}
            {suggestionSlots > 0
              ? `${suggestionSlots} free slot${suggestionSlots === 1 ? "" : "s"} to fill`
              : "all slots in use"}
            {picksData && (
              <span className="ml-2 text-xs text-gray-500 font-normal">
                buying at {localOf(picksData.bedtimeSlotLabel)}
                {isNow ? " · now" : ""} · up to {picksData.maxHoldHours}h hold ·{" "}
                {picksData.itemsProfiled} items profiled · sized for{" "}
                {formatGp(picksData.bankroll)}
                {committedGp > 0 && (
                  <> free ({formatGp(committedGp)} already in offers)</>
                )}
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
            hint="Slot profiles build in the background after startup (up to 250 liquid items, refreshed every 12h), check back shortly."
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
              // Any occupied slot without a plan still gets a picture and a fill estimate --
              // an offer placed from another tool is not less worth understanding, it just
              // arrived by a different route.
              if (v.slot && v.status !== "onplan") {
                return (
                  <OfferOutlook
                    itemId={v.slot.itemId}
                    slot={liveSlot}
                    price={v.slot.price}
                    type={v.slot.type}
                  />
                );
              }
              const id = v.suggestion?.item.id ?? (v.status === "onplan" ? v.slot?.itemId : null);
              if (id == null) return null;
              const pick = pickById.get(id) ?? picksData?.picks.find((p) => p.itemId === id);
              // Live pick first; otherwise the remembered plan, so a position you are already
              // holding keeps its chart even after the item drops out of the current ranking.
              const buy = pick ? pick.slot : plans.get(id)?.buySlot;
              const sell = pick ? pick.bestSellSlot : plans.get(id)?.sellSlot;
              if (buy == null || sell == null) return null;
              // Units the summary should multiply by: a placed offer's real quantity, or the
              // quantity being suggested. Using the pick's own deployableUnits here would be
              // wrong on both counts -- it is sized for the whole free bankroll, not for this
              // one slot's share of it.
              const units = v.slot ? v.slot.totalQuantity : (v.suggestion?.qty ?? 0);
              return (
                <SlotDetail
                  itemId={id}
                  buySlot={buy}
                  sellSlot={sell}
                  units={units}
                  fillTarget={fillTarget / 100}
                  placed={v.slot != null}
                />
              );
            }}
          />
        )}

        {/* Two panels, not one row of five. The left is money already working and is the answer
            to "what am I actually holding"; the right is a proposal. Blending them produced a
            single "expected profit" that described neither -- and, before this, described only
            the proposal, so a board carrying millions in live offers reported 139k. */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 mt-4">
          <div className="rounded-xl border border-violet-400/25 bg-violet-500/[0.06] p-3">
            <div className="flex items-baseline justify-between mb-2">
              <span className="text-[10px] uppercase tracking-wider text-violet-300 font-semibold">
                Holding now
              </span>
              <span className="text-[10px] text-gray-500">
                {boardOutlook.held.offers} buy offer
                {boardOutlook.held.offers === 1 ? "" : "s"}
                {boardOutlook.held.selling > 0 && ` · ${boardOutlook.held.selling} selling`}
              </span>
            </div>
            <div className="grid grid-cols-3 gap-3">
              <Figure
                label="Expected"
                value={`${boardOutlook.held.expected >= 0 ? "+" : ""}${formatGp(boardOutlook.held.expected)}`}
                sub={`on ${formatGp(boardOutlook.held.capital)}`}
                tone={boardOutlook.held.expected >= 0 ? "text-emerald-400" : "text-rose-400"}
              />
              <Figure
                label="Worst day"
                value={`${boardOutlook.held.worst >= 0 ? "+" : ""}${formatGp(boardOutlook.held.worst)}`}
                sub="if it repeats"
                tone={boardOutlook.held.worst < 0 ? "text-rose-400" : "text-gray-300"}
              />
              <Figure
                label="Check back"
                value={nextCheck ? slotToLocalLabel(nextCheck.slot) : "-"}
                sub={nextCheck ? `in ${formatWait(nextCheck.wait)}` : "nothing to sell"}
                tone="text-sky-300"
              />
            </div>
            {boardOutlook.held.unknown > 0 && (
              /* Never fold an un-planned offer into the total as if it were a zero -- say it. */
              <p className="text-[10px] text-gray-500 mt-2">
                {boardOutlook.held.unknown} offer
                {boardOutlook.held.unknown === 1 ? "" : "s"} placed outside a plan, capital
                counted, profit not estimated.
              </p>
            )}
          </div>

          <div className="rounded-xl border border-sky-400/20 bg-sky-500/[0.04] p-3">
            <div className="flex items-baseline justify-between mb-2">
              <span className="text-[10px] uppercase tracking-wider text-sky-300 font-semibold">
                Could still fill
              </span>
              <span className="text-[10px] text-gray-500">
                {allocation.assignments.length} slot
                {allocation.assignments.length === 1 ? "" : "s"} suggested
              </span>
            </div>
            <div className="grid grid-cols-3 gap-3">
              <Figure
                label="Expected"
                value={`${boardOutlook.suggested.expected >= 0 ? "+" : ""}${formatGp(boardOutlook.suggested.expected)}`}
                sub={`on ${formatGp(boardOutlook.suggested.capital)}`}
                tone="text-emerald-400"
              />
              <Figure
                label="Worst day"
                value={`${boardOutlook.suggested.worst >= 0 ? "+" : ""}${formatGp(boardOutlook.suggested.worst)}`}
                sub="if it repeats"
                tone={boardOutlook.suggested.worst < 0 ? "text-rose-400" : "text-gray-300"}
              />
              <Figure
                label="Idle"
                value={formatGp(allocation.remainingBankroll)}
                sub="unspent"
                tone="text-gray-400"
                explain="maximizeUtilization"
              />
            </div>
          </div>
        </div>

        {limitedByBuyLimits && (
          <p className="text-[11px] text-amber-400/90 mt-2">
            Capped by GE buy limits, not by bankroll, with {suggestionSlots} slot
            {suggestionSlots === 1 ? "" : "s"} available, the current candidates can only absorb
            about {formatGp(totalCapacity)} between them (each item has a hard 4h purchase limit).
            More slots, or an "Aggressive" risk preset that reaches pricier items, would let more
            of the bankroll get used.
          </p>
        )}
      </Panel>

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
                  <th className="pb-2 pr-3 font-medium text-right">Sell at</th>
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
                      {p.buyPrice != null ? formatGpFull(p.buyPrice) : "-"}
                    </td>
                    <td className="py-2 pr-3 text-right font-mono text-violet-300">
                      {p.sellPrice != null ? formatGpFull(p.sellPrice) : "-"}
                    </td>
                    <td className="py-2 pr-3 text-right font-mono text-violet-300">
                      {p.bestSellSlotLabel ? slotToLocalLabel(utcLabelToSlot(p.bestSellSlotLabel)) : "-"}
                    </td>
                    <td className="py-2 pr-3 text-right font-mono text-gray-400">
                      {p.holdHours != null ? `${p.holdHours}h` : "-"}
                    </td>
                    <td className="py-2 pr-3 text-right font-mono text-gray-200">
                      {p.profitPerUnit != null ? formatGpFull(p.profitPerUnit) : "-"}
                    </td>
                    <td className="py-2 pr-3 text-right font-mono text-emerald-400">
                      {p.timingEdgePct != null ? `${(p.timingEdgePct * 100).toFixed(2)}%` : "-"}
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
                        {p.pairedDays > 0 ? `${p.winDays}/${p.pairedDays}` : "-"}
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
            and aggregated with a median. "Edge" is the real after-tax return, it requires
            holding for the stated time, not an instant margin.
          </p>
        </div>
      )}
    </div>
  );
}
