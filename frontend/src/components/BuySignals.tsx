import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { MarketItem } from "../api";
import { formatGp, formatGpFull, formatPct } from "../format";
import { allocateCapital } from "../capitalAllocator";
import { NumberInput, Chip, Button } from "./ui";
import { type Offer, loadOffers, saveOffers } from "../offers";
import { type Fill, loadFills, saveFills } from "../fills";
import { computeRepriceGuidance, ACTION_LABEL, ACTION_TONE } from "../repriceGuidance";
import { GeOffersPanel } from "./GeOffersPanel";
import { diffAndSnapshotSignals, type SignalsDiff } from "../signalsDiff";

function iconUrl(icon: string): string {
  if (!icon) return "";
  return `https://oldschool.runescape.wiki/images/${encodeURIComponent(icon.replace(/ /g, "_"))}`;
}

function loadNumber(key: string, fallback: number): number {
  const raw = localStorage.getItem(key);
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) ? n : fallback;
}

// DESIGN.md §10 item 21 / §14.23: a timeframe changes which items even qualify -- a 5-minute
// hold needs an item liquid enough to actually fill and resell inside that window; a 6-hour
// hold can tolerate a much thinner book in exchange for wider margin. Thresholds are a starting
// judgment call (not backtested), same caveat as MarketTable's volatility badge tiers.
const TIMEFRAMES: { key: string; label: string; minLiquidity: number }[] = [
  { key: "5m", label: "5m", minLiquidity: 300 },
  { key: "15m", label: "15m", minLiquidity: 150 },
  { key: "30m", label: "30m", minLiquidity: 80 },
  { key: "1h", label: "1h", minLiquidity: 30 },
  { key: "2h", label: "2h", minLiquidity: 10 },
  { key: "6h", label: "6h", minLiquidity: 0 },
];

export function BuySignals({
  items,
  onSelectItem,
}: {
  items: MarketItem[];
  onSelectItem: (item: MarketItem) => void;
}) {
  const [bankroll, setBankroll] = useState(() => loadNumber("bankroll", 10_000_000));
  const [allocationPct, setAllocationPct] = useState(() => loadNumber("allocationPct", 15));
  const [numSlots, setNumSlots] = useState(() => loadNumber("numSlots", 8));
  const [timeframe, setTimeframe] = useState<string>(
    () => localStorage.getItem("allocatorTimeframe") ?? "1h",
  );
  const [rerollCount, setRerollCount] = useState(0);

  function updateTimeframe(key: string) {
    setTimeframe(key);
    setRerollCount(0);
    localStorage.setItem("allocatorTimeframe", key);
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
    setNumSlots(v);
    localStorage.setItem("numSlots", String(v));
  }

  // DESIGN.md §10 item 17 / §14.16, moved next to the allocator per direct request (was
  // previously at the bottom of the Actions tab): "Track" turns an allocator suggestion into a
  // tracked GE offer, live-re-evaluated (reprice/cancel guidance) as the market moves.
  // `offers` is lifted here (not owned by GeOffersPanel) so both the allocator's "Track this
  // buy" button and the panel's own paste-in flow mutate the same list, not two independently
  // loaded copies of the same localStorage store.
  const [offers, setOffersRaw] = useState<Offer[]>(() => loadOffers());

  function setOffers(next: Offer[]) {
    setOffersRaw(next);
    saveOffers(next);
  }

  // Lifted up from GeOffersPanel (was previously local to it) -- both the tracked-offer slot
  // cards below and GeOffersPanel's "recently filled" log need the same live list now.
  const [fills, setFillsRaw] = useState<Fill[]>(() => loadFills());

  function setFills(next: Fill[]) {
    setFillsRaw(next);
    saveFills(next);
  }

  const trackedNames = useMemo(
    () => new Set(offers.map((o) => o.itemName.toLowerCase())),
    [offers],
  );

  function trackSlot(itemName: string, price: number, qty: number) {
    const newOffer: Offer = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      type: "buy",
      itemName,
      price,
      qty,
    };
    setOffers([...offers, newOffer]);
  }

  // Marking a buy filled doesn't just clear the slot -- it hands off to a tracked sell offer
  // for the same item/qty (seeded at the current recommended sell price, still editable/
  // acceptable like any tracked price) so the round trip stays visible in the same grid until
  // you actually sell. Marking a sell filled closes the loop and frees the slot.
  function markFilled(offer: Offer, market: MarketItem | undefined) {
    const fill: Fill = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      type: offer.type,
      itemName: offer.itemName,
      price: offer.price,
      qty: offer.qty,
      filledAt: Math.floor(Date.now() / 1000),
    };
    setFills([fill, ...fills]);
    if (offer.type === "buy") {
      const sellOffer: Offer = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        type: "sell",
        itemName: offer.itemName,
        price: market?.high ?? offer.price,
        qty: offer.qty,
      };
      setOffers([...offers.filter((o) => o.id !== offer.id), sellOffer]);
    } else {
      setOffers(offers.filter((o) => o.id !== offer.id));
    }
  }

  function removeOffer(id: string) {
    setOffers(offers.filter((o) => o.id !== id));
  }

  function applyReprice(offerId: string, price: number) {
    setOffers(offers.map((o) => (o.id === offerId ? { ...o, price } : o)));
  }

  // Accept-the-real-price flow: what you actually managed to place on the GE often isn't the
  // exact suggested figure (rounding, a few ticks of market movement between "track" and
  // clicking confirm in-game) -- both a fresh "Track this buy" and any already-tracked offer's
  // price need to be hand-editable, not just auto-filled from the recommendation.
  const [editingOfferId, setEditingOfferId] = useState<string | null>(null);
  const [editPriceDraft, setEditPriceDraft] = useState(0);
  const [pendingTrackItemId, setPendingTrackItemId] = useState<number | null>(null);
  const [pendingTrackPrice, setPendingTrackPrice] = useState(0);

  // DESIGN.md §10 item 17 / §14.16: reprice/cancel guidance, re-evaluated fresh every time
  // `items` updates (i.e. every poll cycle) since computeRepriceGuidance is a pure function of
  // the offer + current market row -- no separate "re-check" trigger needed.
  const offerRows = useMemo(() => {
    return offers.map((offer) => {
      const market = items.find((i) => i.name.toLowerCase() === offer.itemName.toLowerCase());
      return { offer, market, guidance: computeRepriceGuidance(offer, market) };
    });
  }, [offers, items]);

  const minLiquidity = TIMEFRAMES.find((t) => t.key === timeframe)?.minLiquidity ?? 0;

  // A tracked/open offer is already occupying one of your real GE slots -- it shouldn't also
  // eat one of the *remaining* suggested slots, and the item shouldn't be suggested again while
  // you already have an open offer on it (excludeNames below).
  const suggestionSlots = Math.max(0, numSlots - offers.length);

  const allocation = useMemo(
    () =>
      allocateCapital(items, {
        bankroll,
        numSlots: suggestionSlots,
        maxAllocationPct: allocationPct,
        minLiquidity,
        skipCount: rerollCount * numSlots,
        excludeNames: trackedNames,
      }),
    [items, bankroll, suggestionSlots, numSlots, allocationPct, minLiquidity, rerollCount, trackedNames],
  );

  const signals = useMemo(() => {
    const allocation = bankroll * (allocationPct / 100);
    return items
      .filter((i) => (i.net_margin ?? 0) > 0 && i.low)
      .map((i) => {
        const affordableQty = i.low ? Math.floor(allocation / i.low) : 0;
        const qty = Math.max(0, Math.min(i.buy_limit ?? Infinity, affordableQty));
        const projectedProfit = qty * (i.net_margin ?? 0);
        return { item: i, qty, projectedProfit };
      })
      .filter((s) => s.qty > 0)
      .sort((a, b) => b.item.score - a.item.score)
      .slice(0, 30);
  }, [items, bankroll, allocationPct]);

  // DESIGN.md §10 item 6: diff against what was here last time the tab was open, once per page
  // load only -- not every poll tick, which would just be noise as prices wiggle minute to minute.
  const [signalsDiff, setSignalsDiff] = useState<SignalsDiff | null>(null);
  const diffTakenRef = useRef(false);
  useEffect(() => {
    if (diffTakenRef.current || signals.length === 0) return;
    diffTakenRef.current = true;
    setSignalsDiff(diffAndSnapshotSignals(signals.map((s) => s.item.name)));
  }, [signals]);

  return (
    <div>
      <div className="glass rounded-xl p-4 mb-4 flex flex-wrap items-end gap-6">
        <label className="text-xs text-gray-400 flex flex-col gap-1">
          Bankroll (gp)
          <NumberInput value={bankroll} onChange={updateBankroll} className="w-40" />
        </label>
        <label className="text-xs text-gray-400 flex flex-col gap-1">
          Max allocation per item (%)
          <NumberInput value={allocationPct} onChange={updateAllocation} className="w-24" />
        </label>
        <label className="text-xs text-gray-400 flex flex-col gap-1">
          GE slots
          <NumberInput
            value={numSlots}
            onChange={(v) => updateNumSlots(Math.max(1, Math.min(8, v)))}
            className="w-20"
          />
        </label>
        <p className="text-xs text-gray-500 max-w-md">
          Suggested quantity = min(buy limit, {formatGp(bankroll * (allocationPct / 100))} ÷ buy
          price). Ranked by the same score as the Market tab. No account/bank data yet — see
          DESIGN.md §6.5.
        </p>
      </div>

      {/* DESIGN.md §11.3 item 7: capital allocator -- fills your actual GE slots, one item each,
          respecting the per-item cap and the total bankroll (not just "everything affordable").
          §14.20: Open GE offers now sits next to it (was at the bottom of the Actions tab) --
          allocator says what to buy, offers panel tracks/re-evaluates it as the market moves. */}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4 mb-4 items-start">
        <div className="glass rounded-xl p-4">
          <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
            <h3 className="text-sm font-medium text-gray-200">
              Capital allocator — fill your {numSlots} GE slots
            </h3>
            <div className="flex items-center gap-4 text-xs">
              <span className="text-gray-500">
                Spent{" "}
                <span className="text-gray-200 font-mono">{formatGp(allocation.totalCost)}</span>
              </span>
              <span className="text-gray-500">
                Idle{" "}
                <span className="text-gray-200 font-mono">
                  {formatGp(allocation.remainingBankroll)}
                </span>
              </span>
              <span className="text-gray-500">
                Projected profit{" "}
                <span className="text-emerald-400 font-mono">
                  {formatGp(allocation.totalProfit)}
                </span>
              </span>
            </div>
          </div>

          {/* DESIGN.md §10 item 21 / §14.23: timeframe changes which items qualify (liquidity
              floor), reroll cycles to the next batch of qualifying candidates deterministically. */}
          <div className="flex items-center justify-between flex-wrap gap-2 mb-3">
            <div className="flex items-center gap-1.5">
              <span className="text-[10px] uppercase tracking-wide text-gray-500 mr-1">
                Hold time
              </span>
              {TIMEFRAMES.map((t) => (
                <Chip
                  key={t.key}
                  active={timeframe === t.key}
                  onClick={() => updateTimeframe(t.key)}
                >
                  {t.label}
                </Chip>
              ))}
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setRerollCount((c) => c + 1)}
              title="Cycle to the next batch of qualifying candidates"
            >
              🎲 Reroll
            </Button>
          </div>

          {offerRows.length === 0 && allocation.assignments.length === 0 ? (
            <p className="text-xs text-gray-500">
              No affordable slots at the current bankroll/allocation.
            </p>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {/* A tracked/open offer is a real GE slot already in use -- show it as one of the
                  slot cards (not a separate side list) so the grid reflects your actual 8 slots,
                  not just what the allocator would suggest from scratch. */}
              {offerRows.map(({ offer, market, guidance }, idx) => {
                const isWarning = guidance.action !== "hold" && guidance.action !== "unknown";
                const isEditing = editingOfferId === offer.id;
                return (
                  <div
                    key={offer.id}
                    onClick={() => !isEditing && market && onSelectItem(market)}
                    className={`text-left rounded-lg border p-3 transition-colors bg-white/[0.03] ${
                      market && !isEditing ? "cursor-pointer hover:bg-white/[0.06]" : ""
                    } ${
                      guidance.action === "cancel"
                        ? "border-rose-500/40"
                        : isWarning
                          ? "border-amber-500/40"
                          : "border-white/10"
                    }`}
                  >
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-[10px] uppercase tracking-wide text-gray-500">
                        Slot {idx + 1}
                      </span>
                      <span
                        className={`text-[10px] font-semibold uppercase px-1.5 py-0.5 rounded ${
                          offer.type === "buy"
                            ? "bg-rose-500/15 text-rose-400 border border-rose-500/30"
                            : "bg-emerald-500/15 text-emerald-400 border border-emerald-500/30"
                        }`}
                      >
                        {offer.type}
                      </span>
                    </div>
                    <div className="flex items-center gap-2 min-w-0">
                      {market?.icon && (
                        <img src={iconUrl(market.icon)} alt="" className="w-5 h-5 object-contain shrink-0" />
                      )}
                      <span className="text-sm text-gray-100 truncate">{offer.itemName}</span>
                    </div>
                    <div className="mt-2 flex items-center justify-between text-xs">
                      <span className="text-gray-500">
                        qty <span className="text-gray-200 font-mono">{offer.qty.toLocaleString()}</span>
                      </span>
                      {isEditing ? (
                        <div
                          className="flex items-center gap-1"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <NumberInput
                            value={editPriceDraft}
                            onChange={setEditPriceDraft}
                            className="w-24 !py-0.5 !px-1.5 text-xs"
                          />
                          <button
                            onClick={() => {
                              applyReprice(offer.id, editPriceDraft);
                              setEditingOfferId(null);
                            }}
                            className="text-emerald-400 hover:text-emerald-300 text-xs px-1"
                            title="Save your actual order price"
                          >
                            ✓
                          </button>
                          <button
                            onClick={() => setEditingOfferId(null)}
                            className="text-gray-500 hover:text-rose-400 text-xs px-1"
                          >
                            ✕
                          </button>
                        </div>
                      ) : (
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            setEditingOfferId(offer.id);
                            setEditPriceDraft(offer.price);
                          }}
                          className="text-gray-300 font-mono hover:text-white underline decoration-dotted decoration-gray-600 underline-offset-2"
                          title="Click to enter the exact price you actually placed"
                        >
                          {formatGpFull(offer.price)}
                        </button>
                      )}
                    </div>
                    <div className="mt-1.5 text-[11px]">
                      <span className={`font-medium ${ACTION_TONE[guidance.action]}`}>
                        {isWarning ? "⚠ " : ""}
                        {ACTION_LABEL[guidance.action]}
                      </span>{" "}
                      <span className="text-gray-500">{guidance.reason}</span>
                    </div>
                    <div className="mt-2 flex items-center gap-2 flex-wrap" onClick={(e) => e.stopPropagation()}>
                      {guidance.suggestedPrice != null && (
                        <button
                          onClick={() => applyReprice(offer.id, guidance.suggestedPrice!)}
                          className="text-[11px] text-sky-400 hover:text-sky-300"
                        >
                          Accept {formatGpFull(guidance.suggestedPrice)}
                        </button>
                      )}
                      <button
                        onClick={() => markFilled(offer, market)}
                        className="text-[11px] text-emerald-400 hover:text-emerald-300"
                      >
                        {offer.type === "buy" ? "I bought it" : "I sold it"}
                      </button>
                      <button
                        onClick={() => removeOffer(offer.id)}
                        className="text-[11px] text-gray-500 hover:text-rose-400 ml-auto"
                      >
                        Remove
                      </button>
                    </div>
                  </div>
                );
              })}

              {allocation.assignments.map((a) => (
                <div
                  key={a.slot}
                  onClick={() => onSelectItem(a.item)}
                  className="text-left rounded-lg border border-white/10 bg-white/[0.03] hover:bg-white/[0.06] p-3 transition-colors cursor-pointer"
                >
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-[10px] uppercase tracking-wide text-gray-500">
                      Slot {offerRows.length + a.slot}
                    </span>
                    <span className="text-[10px] font-mono text-gray-500">
                      {formatPct(a.item.roi_pct)}
                    </span>
                  </div>
                  <div className="flex items-center gap-2 min-w-0">
                    {a.item.icon && (
                      <img
                        src={`https://oldschool.runescape.wiki/images/${encodeURIComponent(a.item.icon.replace(/ /g, "_"))}`}
                        alt=""
                        className="w-5 h-5 object-contain shrink-0"
                      />
                    )}
                    <span className="text-sm text-gray-100 truncate">{a.item.name}</span>
                  </div>
                  <div className="mt-2 flex items-center justify-between text-xs">
                    <span className="text-gray-500">
                      qty{" "}
                      <span className="text-gray-200 font-mono">{a.qty.toLocaleString()}</span>
                    </span>
                    <span className="text-emerald-400 font-mono">
                      +{formatGp(a.projectedProfit)}
                    </span>
                  </div>
                  {pendingTrackItemId === a.item.id ? (
                    <div
                      className="mt-2 flex items-center gap-1.5"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <NumberInput
                        value={pendingTrackPrice}
                        onChange={setPendingTrackPrice}
                        className="flex-1 !py-1 !px-1.5 text-xs"
                        title="Enter the price you're actually placing this buy at"
                      />
                      <button
                        onClick={() => {
                          trackSlot(a.item.name, pendingTrackPrice, a.qty);
                          setPendingTrackItemId(null);
                        }}
                        className="text-emerald-400 hover:text-emerald-300 text-xs px-1.5"
                        title="Confirm and track at this price"
                      >
                        ✓
                      </button>
                      <button
                        onClick={() => setPendingTrackItemId(null)}
                        className="text-gray-500 hover:text-rose-400 text-xs px-1.5"
                      >
                        ✕
                      </button>
                    </div>
                  ) : (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setPendingTrackItemId(a.item.id);
                        setPendingTrackPrice(a.item.low ?? 0);
                      }}
                      className="mt-2 w-full text-[11px] py-1 rounded-md transition-colors bg-sky-500/15 text-sky-400 hover:bg-sky-500/25 border border-sky-500/30"
                    >
                      Track this buy
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        <GeOffersPanel offers={offers} setOffers={setOffers} fills={fills} setFills={setFills} />
      </div>

      {signalsDiff && signalsDiff.previousAt != null && (
        <div className="glass rounded-xl p-3 mb-3 text-xs flex flex-wrap items-center gap-x-5 gap-y-1">
          <span className="text-gray-500 uppercase tracking-wide text-[10px]">
            Since last visit
          </span>
          {signalsDiff.entered.length === 0 && signalsDiff.left.length === 0 ? (
            <span className="text-gray-500">No change in the top 30</span>
          ) : (
            <>
              {signalsDiff.entered.length > 0 && (
                <span className="text-emerald-400">
                  + entered: <span className="text-gray-300">{signalsDiff.entered.join(", ")}</span>
                </span>
              )}
              {signalsDiff.left.length > 0 && (
                <span className="text-rose-400">
                  − left: <span className="text-gray-300">{signalsDiff.left.join(", ")}</span>
                </span>
              )}
            </>
          )}
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 2xl:grid-cols-3 gap-3">
        {signals.map(({ item, qty, projectedProfit }) => (
          <div key={item.id} className="glass rounded-xl p-4 flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 min-w-0">
                {item.icon && (
                  <img
                    src={iconUrl(item.icon)}
                    alt=""
                    className="w-6 h-6 object-contain shrink-0"
                  />
                )}
                <button
                  onClick={() => onSelectItem(item)}
                  className="text-gray-100 font-medium truncate hover:text-white hover:underline text-left"
                >
                  {item.name}
                </button>
              </div>
              <span className="text-[10px] font-semibold tracking-wide uppercase px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-400 border border-emerald-500/30 shrink-0">
                Buy
              </span>
            </div>

            <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
              <span className="text-gray-500">Buy at</span>
              <span className="font-mono text-gray-200 text-right">{formatGpFull(item.low)}</span>
              <span className="text-gray-500">Sell at</span>
              <span className="font-mono text-gray-200 text-right">{formatGpFull(item.high)}</span>
              <span className="text-gray-500">Net margin</span>
              <span className="font-mono text-emerald-400 text-right">
                {formatGpFull(item.net_margin)}
              </span>
              <span className="text-gray-500">ROI</span>
              <span className="font-mono text-emerald-400 text-right">
                {formatPct(item.roi_pct)}
              </span>
            </div>

            <div className="mt-1 pt-2 border-t border-white/10 flex items-center justify-between">
              <div className="text-xs text-gray-500">
                Suggested qty
                <div className="text-lg font-mono text-white">{qty.toLocaleString()}</div>
              </div>
              <div className="text-xs text-gray-500 text-right">
                Projected profit
                <div className="text-lg font-mono text-emerald-400">
                  {formatGp(projectedProfit)}
                </div>
              </div>
            </div>
          </div>
        ))}
        {signals.length === 0 && (
          <div className="glass rounded-xl p-10 text-center text-gray-400 col-span-full">
            No signals match your current bankroll/allocation and the Market tab's liquidity filter.
          </div>
        )}
      </div>
    </div>
  );
}
