import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import {
  extractGeOffersFromScreenshot,
  fetchTrackRecord,
  fetchPortfolio,
  type MarketItem,
  type PortfolioResponse,
} from "../api";
import { formatGp, formatGpFull, formatPct } from "../format";
import { allocateCapital } from "../capitalAllocator";
import { NumberInput, Chip, Button } from "./ui";
import { type Offer, loadOffers, saveOffers } from "../offers";
import { type Fill, loadFills, saveFills } from "../fills";
import { GeOffersPanel } from "./GeOffersPanel";
import { GeSlotBoard } from "./GeSlotBoard";
import { buildSlotViews, countNeedsAction } from "../geSlots";
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
  // DESIGN.md §14.43: overnight/multi-session holds. These share 6h's zero liquidity floor on
  // purpose -- past a few hours the binding constraint stops being "can this fill in time" and
  // becomes "am I willing to carry the price risk", which liquidity doesn't measure. Adding a
  // fake extra filter here would imply a distinction the data doesn't support. The per-item
  // timing edge in TradingHoursPanel is the thing that actually differentiates these.
  { key: "12h", label: "12h", minLiquidity: 0 },
  { key: "18h", label: "18h", minLiquidity: 0 },
  { key: "24h", label: "24h", minLiquidity: 0 },
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

  // DESIGN.md §14.41: the allocator now plans against the real Grand Exchange, not against
  // hand-typed offers. Polled on the same 20s cadence the backend reads the slot files.
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

  // Don't suggest an item that's already on the GE or already sitting in inventory unsold:
  // in both cases you'd be adding to a position rather than opening a new flip, and the
  // allocator's per-item cap wouldn't know about the exposure it already has.
  //
  // Still unions in `offers` (the manual list) so anything hand-entered keeps working, but the
  // live slots are what actually populate this now.
  const trackedNames = useMemo(() => {
    const names = new Set(offers.map((o) => o.itemName.toLowerCase()));
    for (const s of portfolio?.slots ?? []) names.add(s.name.toLowerCase());
    for (const p of portfolio?.positions ?? []) names.add(p.name.toLowerCase());
    return names;
  }, [offers, portfolio]);

  // Computed here as well as inside the board so the panel header can show the count without the
  // board having to call back up. Cheap: a pure map over at most 8 slots.
  const needsAction = useMemo(
    () => countNeedsAction(buildSlotViews(portfolio?.slots ?? [], [], items)),
    [portfolio, items],
  );

  // Units already bought per item inside the current 4h GE limit window.
  const remainingLimits = useMemo(() => {
    const map = new Map<number, number>();
    for (const b of portfolio?.buyLimits ?? []) {
      if (b.remaining != null) map.set(b.itemId, b.remaining);
    }
    return map;
  }, [portfolio]);

  // DESIGN.md §14.42: the manual-offer editing helpers (trackSlot / markFilled / removeOffer /
  // switchToAlternative / applyReprice / applyFilledQty and their editing state) used to live
  // here to drive the hand-typed slot cards. Those cards are gone -- GeSlotBoard renders the real
  // GE slots from RuneLite -- so every one of them was unreachable. Removed rather than left
  // dangling; the manual paste path still works via GeOffersPanel below, which owns its own state.

  // Screenshot -> vision model -> offers, moved here (was previously local to GeOffersPanel) so
  // paste/upload can cover the whole slot grid, not just a side panel -- per direct request,
  // screenshotting your GE and pasting is now the primary flow, the old textbox is a fallback.
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [screenshotLoading, setScreenshotLoading] = useState(false);
  const [screenshotMessage, setScreenshotMessage] = useState<string | null>(null);
  // Offers the screenshot claims are now in an "Empty" slot, held for confirmation rather than
  // removed immediately -- a small local vision model reporting "this slot is empty" turned out
  // live-testing to be unreliable on anything less than a full, uncropped 8-slot screenshot (it
  // can claim every slot is empty even when it only actually saw one), so silently trusting that
  // to delete tracked offers risked wiping real, still-open trades. Cheap and additive updates
  // (new offers, price/progress refreshes) still apply immediately; only the destructive part
  // waits for a click.
  const [pendingClear, setPendingClear] = useState<Offer[]>([]);

  async function handleScreenshotFile(file: File) {
    if (!file.type.startsWith("image/")) {
      setScreenshotMessage("That's not an image file.");
      return;
    }
    setScreenshotLoading(true);
    setScreenshotMessage(null);
    try {
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.onerror = () => reject(reader.error ?? new Error("Failed to read file"));
        reader.readAsDataURL(file);
      });
      const { offers: extracted, emptySlotIndexes } = await extractGeOffersFromScreenshot(dataUrl);
      if (extracted.length === 0 && emptySlotIndexes.length === 0) {
        // Genuinely ambiguous from here: either nothing in the shot was readable, or it's a
        // slot mid-setup (item/qty chosen but no price typed in yet) -- neither is a model
        // failure. Say so instead of implying something broke. (If emptySlotIndexes is non-empty
        // but extracted is empty, that's NOT ambiguous -- it means the visible grid really is all
        // empty, and freed-slot cleanup below still needs to run.)
        setScreenshotMessage(
          "No offers with both a price and quantity visible -- either the GE is empty, or a slot is still mid-setup (no price entered yet).",
        );
        return;
      }

      // Re-screenshotting the same open offer (e.g. to update fill progress) shouldn't create a
      // second slot for the same item -- match against what's already tracked and update in
      // place (price/qty/filledQty), keeping id and trackedAt so Trade Health's staleness clock
      // doesn't reset. Only genuinely new offers get appended as new slots.
      //
      // The SAME item can legitimately occupy several real GE slots at once (e.g. 3 sell offers
      // + 1 buy offer on the same item, all visible in one screenshot) -- name+type alone can't
      // tell those apart on a re-screenshot without risking one slot's price/progress getting
      // silently overwritten with another slot's data. slotIndex (the actual 1-8 GE slot
      // position, when the model could read it) is matched first since it's unambiguous; name+
      // type is only used as a fallback, and only when there's exactly one candidate on both
      // sides -- if it's ambiguous, the extracted offer is added as new rather than guessing
      // which existing slot it belongs to (a stray duplicate is a much smaller problem than
      // silently corrupting a different slot's tracked price).
      let updated = 0;
      let added = 0;
      const now = Math.floor(Date.now() / 1000);
      const remainingExtracted = [...extracted];
      const sameKey = (a: { type: string; itemName: string }, b: { type: string; itemName: string }) =>
        a.type === b.type && a.itemName.toLowerCase() === b.itemName.toLowerCase();
      // A physical GE slot can only ever be one type at a time -- if a candidate's slotIndex
      // matches but its type doesn't, that's the model producing conflicting data within the
      // same response (seen live: the same slotIndex reported for both a buy and a sell entry
      // in one read), not a real match.
      const slotMatch = (
        a: { type: string; slotIndex?: number | null },
        b: { type: string; slotIndex?: number | null },
      ) => a.slotIndex != null && b.slotIndex != null && a.slotIndex === b.slotIndex && a.type === b.type;
      // A same-name candidate that reports a DIFFERENT known slotIndex than the existing offer is
      // clearly a different physical offer, not an update to this one -- excluding it from the
      // name-based fallback is what stops that from silently overwriting the wrong tracked slot.
      const slotConflict = (a: { slotIndex?: number | null }, b: { slotIndex?: number | null }) =>
        a.slotIndex != null && b.slotIndex != null && a.slotIndex !== b.slotIndex;

      const merged = offers.map((existing) => {
        let idx = remainingExtracted.findIndex((e) => slotMatch(e, existing));
        if (idx === -1) {
          const candidates = remainingExtracted
            .map((e, i) => ({ e, i }))
            .filter(({ e }) => sameKey(e, existing) && !slotConflict(e, existing));
          if (candidates.length === 1) idx = candidates[0].i;
        }
        if (idx === -1) return existing;
        const [match] = remainingExtracted.splice(idx, 1);
        updated++;
        return {
          ...existing,
          price: match.price,
          qty: match.qty,
          filledQty: match.filledQty,
          slotIndex: match.slotIndex ?? existing.slotIndex,
        };
      });
      for (const e of remainingExtracted) {
        added++;
        merged.push({
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          type: e.type,
          itemName: e.itemName,
          price: e.price,
          qty: e.qty,
          filledQty: e.filledQty,
          slotIndex: e.slotIndex,
          trackedAt: now,
        });
      }

      // Additions/updates apply immediately -- they only add information or refresh a
      // price/progress you can still see and correct yourself. Everything the screenshot claims
      // is now "Empty" STAYS in the tracked list (nothing is removed here) and is only flagged
      // for the confirmation banner below -- see pendingClear above for why the actual removal
      // waits for a click instead of happening on the spot.
      setOffers(merged);
      const emptySet = new Set(emptySlotIndexes);
      const toClear = merged.filter((o) => o.slotIndex != null && emptySet.has(o.slotIndex));
      if (toClear.length > 0) setPendingClear(toClear);

      const parts: string[] = [];
      if (added > 0) parts.push(`added ${added}`);
      if (updated > 0) parts.push(`updated ${updated} existing`);
      setScreenshotMessage(
        parts.length > 0
          ? `Screenshot read: ${parts.join(", ")} -- check the slots, prices may need a nudge.`
          : "Screenshot read: no changes.",
      );
    } catch (err) {
      setScreenshotMessage(err instanceof Error ? err.message : "Failed to read the screenshot.");
    } finally {
      setScreenshotLoading(false);
    }
  }

  // User confirmed these slots really are empty now -- apply the same completion logic that
  // would've run automatically: log a fill for whatever actually filled (using filledQty, not
  // the full requested qty, since a cancel-with-partial-fill is real too), and hand a completed
  // buy off to a tracked sell at the current market price, same as clicking "I bought it".
  function confirmClear() {
    const now = Math.floor(Date.now() / 1000);
    const clearIds = new Set(pendingClear.map((o) => o.id));
    const newFills: Fill[] = [];
    const newSellOffers: Offer[] = [];
    for (const o of pendingClear) {
      const filled = o.filledQty ?? 0;
      if (filled <= 0) continue; // never filled, then cancelled -- nothing to log
      newFills.push({
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        type: o.type,
        itemName: o.itemName,
        price: o.price,
        qty: filled,
        filledAt: now,
      });
      if (o.type === "buy") {
        const market = items.find((i) => i.name.toLowerCase() === o.itemName.toLowerCase());
        newSellOffers.push({
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          type: "sell",
          itemName: o.itemName,
          price: market?.high ?? o.price,
          qty: filled,
          filledQty: 0,
          slotIndex: null,
          trackedAt: now,
        });
      }
    }
    // Single combined update -- the actual removal happens here, not before the confirm click,
    // so a wrongly-flagged "empty" slot never disappears from tracking without you agreeing to it.
    setOffers([...offers.filter((o) => !clearIds.has(o.id)), ...newSellOffers]);
    if (newFills.length > 0) setFills([...newFills, ...fills]);
    setPendingClear([]);
  }

  function dismissClear() {
    setPendingClear([]);
  }

  // Screenshots taken with Win+Shift+S (or copied from any image viewer) land on the clipboard
  // as image data, not text -- catching paste at the container level means "screenshot, then
  // Ctrl+V anywhere in this panel" just works, no need to save-to-file first.
  function handlePanelPaste(e: ClipboardEvent) {
    const item = Array.from(e.clipboardData?.items ?? []).find((i) => i.type.startsWith("image/"));
    if (!item) return; // let normal text paste (e.g. into the textarea) proceed untouched
    const file = item.getAsFile();
    if (!file) return;
    e.preventDefault();
    handleScreenshotFile(file);
  }

  // DESIGN.md §10 item 17 / §14.16: reprice/cancel guidance, re-evaluated fresh every time
  // `items` updates (i.e. every poll cycle) since computeRepriceGuidance is a pure function of
  // the offer + current market row -- no separate "re-check" trigger needed.

  const minLiquidity = TIMEFRAMES.find((t) => t.key === timeframe)?.minLiquidity ?? 0;

  // DESIGN.md §14.41: slots occupied on the real GE can't be planned into. This used to count
  // only hand-entered offers, which meant that once the manual list fell out of use it read 0 and
  // the allocator confidently laid out 8 buys against a Grand Exchange that was already 8/8 full.
  const occupiedSlots = portfolio?.slots.length ?? offers.length;
  const suggestionSlots = Math.max(0, numSlots - occupiedSlots);

  // Cash committed to open buy offers is already spent -- planning with it would double-spend the
  // same gp. Bankroll stays the user's number; this just nets off what the GE is holding.
  const committedGp = portfolio?.totals.cashInBuyOffers ?? 0;
  const availableBankroll = Math.max(0, bankroll - committedGp);

  const allocation = useMemo(
    () =>
      allocateCapital(items, {
        bankroll: availableBankroll,
        numSlots: suggestionSlots,
        maxAllocationPct: allocationPct,
        minLiquidity,
        skipCount: rerollCount * numSlots,
        excludeNames: trackedNames,
        remainingLimits,
      }),
    [
      items,
      availableBankroll,
      suggestionSlots,
      numSlots,
      allocationPct,
      minLiquidity,
      rerollCount,
      trackedNames,
      remainingLimits,
    ],
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

  // DESIGN.md §10 item 12: discount displayed "projected profit" by how well projections have
  // actually panned out historically (Track Record's realized ÷ projected ratio), not just report
  // win rate as an easy-to-ignore separate stat. Fetched once independently rather than lifted
  // from <TrackRecord/> above -- same self-contained-per-component pattern the rest of this app
  // already uses, and this is the only other place on the page that needs the number.
  const [realizationRatio, setRealizationRatio] = useState<number | null>(null);
  useEffect(() => {
    fetchTrackRecord()
      .then((res) => setRealizationRatio(res.summary.realizationRatio))
      .catch(() => {});
  }, []);

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
          Full width, 4-wide grid to actually resemble the real GE's 4x2 slot layout instead of a
          cramped 2-wide column squeezed next to a side panel -- per direct request. onPaste
          covers this whole section (not just a corner textbox) since screenshot+Ctrl-V is the
          primary way offers get tracked now, not the fallback. */}
      <div className="mb-4" onPaste={handlePanelPaste}>
        <div className="glass rounded-xl p-4">
          <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
            <h3 className="text-sm font-medium text-gray-200">
              {/* Says what it's actually planning, rather than implying all 8 slots are yours to
                  fill when the GE says otherwise. */}
              Grand Exchange —{" "}
              {suggestionSlots > 0
                ? `${suggestionSlots} free slot${suggestionSlots === 1 ? "" : "s"} to fill`
                : "all slots in use"}
              {portfolio && (
                <span className="ml-2 text-xs text-gray-500 font-normal">
                  live · {occupiedSlots}/{numSlots} in use
                  {committedGp > 0 ? ` · ${formatGp(committedGp)} committed` : ""}
                </span>
              )}
              {/* The whole point of the board: how many boxes are asking for a decision, visible
                  without reading all eight. */}
              {needsAction > 0 && (
                <span className="ml-2 text-xs font-semibold text-amber-400">
                  {needsAction} needs action
                </span>
              )}
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
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={(e) => {
                  const file = (e.target as HTMLInputElement).files?.[0];
                  if (file) handleScreenshotFile(file);
                  (e.target as HTMLInputElement).value = "";
                }}
              />
              <button
                onClick={() => fileInputRef.current?.click()}
                disabled={screenshotLoading}
                title="Or just paste (Ctrl+V) a screenshot anywhere in this box -- a local vision model reads the slots"
                className="px-2.5 py-1 rounded-lg text-xs bg-sky-500/15 text-sky-400 hover:bg-sky-500/25 border border-sky-500/30 disabled:opacity-50 disabled:cursor-wait"
              >
                {screenshotLoading ? "Reading screenshot…" : "📋 Upload/paste GE screenshot"}
              </button>
            </div>
          </div>

          {screenshotMessage && (
            <p className="text-[11px] text-amber-400 mb-3">{screenshotMessage}</p>
          )}

          {pendingClear.length > 0 && (
            <div className="rounded-lg bg-amber-500/10 border border-amber-500/30 p-3 mb-3">
              <p className="text-xs text-amber-300 mb-2">
                The last screenshot shows {pendingClear.length} slot{pendingClear.length === 1 ? "" : "s"} you're
                tracking as now <span className="font-medium">Empty</span>:{" "}
                {pendingClear.map((o) => `${o.type} ${o.itemName}`).join(", ")}. Remove from tracking?
                {pendingClear.some((o) => (o.filledQty ?? 0) > 0) &&
                  " (Anything that had filled progress will be logged to Recently Filled first.)"}
              </p>
              <div className="flex items-center gap-3">
                <button
                  onClick={confirmClear}
                  className="px-3 py-1.5 rounded-lg text-xs bg-amber-500/20 text-amber-300 hover:bg-amber-500/30 border border-amber-500/40"
                >
                  Clear {pendingClear.length} slot{pendingClear.length === 1 ? "" : "s"}
                </button>
                <button
                  onClick={dismissClear}
                  className="px-3 py-1.5 rounded-lg text-xs text-gray-400 hover:text-gray-200"
                >
                  Keep tracking them
                </button>
              </div>
            </div>
          )}

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

          {/* DESIGN.md §14.42: one board mirroring the in-game GE. Replaces the old grid, which
              rendered hand-typed offers as slot cards while using the live RuneLite data only to
              count slots -- so it could show an offer that wasn't in the game while the real ones
              appeared nowhere. Occupied boxes come from RuneLite; empty ones get the allocator's
              suggestion. */}
          <GeSlotBoard
            slots={portfolio?.slots ?? []}
            suggestions={allocation.assignments}
            items={items}
            onSelectItem={onSelectItem}
            showHeader={false}
          />
        </div>
      </div>

      <div className="mb-4">
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
                {realizationRatio != null ? "Calibrated profit" : "Projected profit"}
                <div className="text-lg font-mono text-emerald-400">
                  {formatGp(realizationRatio != null ? projectedProfit * realizationRatio : projectedProfit)}
                </div>
                {realizationRatio != null && (
                  <div
                    className="text-[10px] text-gray-600"
                    title="Raw projection scaled by Track Record's realized-vs-projected ratio -- see the Realization stat above"
                  >
                    {formatGp(projectedProfit)} raw × {(realizationRatio * 100).toFixed(0)}%
                  </div>
                )}
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
