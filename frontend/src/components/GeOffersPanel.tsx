import { useRef, useState } from "preact/hooks";
import type { MarketItem } from "../api";
import { formatAgo, formatGp } from "../format";
import { type Offer, parseOffersText } from "../offers";
import { type Fill } from "../fills";
import { extractGeOffersFromScreenshot } from "../api";

// Lives next to the Capital Allocator (BuySignals.tsx) rather than at the bottom of the Actions
// tab -- the allocator suggests what to buy, this tracks/re-evaluates it as the market moves, so
// they belong in the same view. `offers`/`fills` are lifted to the shared parent (BuySignals) so
// the allocator's own slot grid (which now renders each tracked offer as an occupied GE slot,
// not a separate side list) and this panel's paste-in flow both read/write the same live lists.
export function GeOffersPanel({
  offers,
  setOffers,
  fills,
  setFills,
  items,
}: {
  offers: Offer[];
  setOffers: (next: Offer[]) => void;
  fills: Fill[];
  setFills: (next: Fill[]) => void;
  items: MarketItem[];
}) {
  const [offerText, setOfferText] = useState("");
  const [offerError, setOfferError] = useState<string | null>(null);

  function handleAddOffers() {
    const { offers: parsed, skipped } = parseOffersText(offerText);
    if (parsed.length === 0) {
      setOfferError(
        skipped.length
          ? "Couldn't read any of that -- check the format below."
          : "Paste something first.",
      );
      return;
    }
    setOffers([...offers, ...parsed]);
    setOfferText("");
    setOfferError(
      skipped.length
        ? `Added ${parsed.length}, skipped ${skipped.length} unreadable line(s).`
        : null,
    );
  }

  // Screenshot -> vision model -> offers. A local Qwen2.5-VL (via Ollama, same OpenAI-compatible
  // pattern as llm.ts's text model) reads the GE trade-slot screenshot and returns structured
  // {type, itemName, price, qty} per slot -- same shape a pasted/typed offer produces, so it
  // feeds straight into the existing offers list with no separate code path.
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

  return (
    <div className="glass rounded-xl p-4" onPaste={handlePanelPaste}>
      <h3 className="text-sm font-medium text-gray-300 mb-2">Track a GE offer</h3>
      <p className="text-xs text-gray-500 mb-2">
        Paste offers here, or use "Track this buy" on a slot to the left -- either way it shows up
        as an occupied slot in the Capital allocator grid, compared against current market prices.
        Never submitted anywhere: there's no confirmed RuneLite plugin that exports live GE offer
        slots the way Bank Memory exports bank contents, so this is manual until one exists. Stored
        locally in your browser only.
      </p>

      {pendingClear.length > 0 && (
        <div className="rounded-lg bg-amber-500/10 border border-amber-500/30 p-3 mb-3">
          <p className="text-xs text-amber-300 mb-2">
            The last screenshot shows {pendingClear.length} slot{pendingClear.length === 1 ? "" : "s"} you're
            tracking as now <span className="font-medium">Empty</span>: {" "}
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

      <div className="rounded-lg bg-white/[0.02] border border-white/5 p-3 mb-3">
        <div className="flex items-center justify-between mb-2 gap-2 flex-wrap">
          <span className="text-[11px] text-gray-500">
            Screenshot your GE trade screen, then paste (Ctrl+V) anywhere in this panel or upload
            it -- a local vision model reads the slots and fills them in below.
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
            className="px-2.5 py-1 rounded-lg text-xs bg-sky-500/15 text-sky-400 hover:bg-sky-500/25 border border-sky-500/30 disabled:opacity-50 disabled:cursor-wait shrink-0"
          >
            {screenshotLoading ? "Reading screenshot…" : "Upload screenshot"}
          </button>
        </div>
        {screenshotMessage && (
          <p className="text-[11px] text-amber-400 mb-2">{screenshotMessage}</p>
        )}

        <textarea
          value={offerText}
          onInput={(e) => setOfferText((e.target as HTMLTextAreaElement).value)}
          placeholder={
            "type\\titem name\\tprice\\tqty\nbuy\\tAbyssal whip\\t830000\\t5\nsell\\tArmadyl crossbow\\t34500000\\t1"
          }
          rows={3}
          className="glass rounded-lg w-full px-3 py-2 text-xs font-mono text-gray-200 placeholder:text-gray-600 outline-none"
        />
        <div className="flex items-center gap-3 mt-2 flex-wrap">
          <button
            onClick={handleAddOffers}
            className="px-3 py-1.5 rounded-lg text-sm bg-white/10 hover:bg-white/15 text-white transition-colors"
          >
            Add offers
          </button>
          {offers.length > 0 && (
            <button
              onClick={() => setOffers([])}
              className="px-3 py-1.5 rounded-lg text-sm text-gray-500 hover:text-rose-400"
            >
              Clear all
            </button>
          )}
          {offerError && <span className="text-xs text-amber-400">{offerError}</span>}
        </div>
      </div>

      {offers.length === 0 && fills.length === 0 && (
        <p className="text-xs text-gray-500 py-2">
          Nothing tracked yet -- paste offers above, or track a Capital allocator slot.
        </p>
      )}

      {fills.length > 0 && (
        <div className="mt-3 pt-3 border-t border-white/5">
          <div className="flex items-center justify-between mb-1.5">
            <div className="text-[10px] uppercase tracking-wide text-gray-500">Recently filled</div>
            <button
              onClick={() => setFills([])}
              className="text-[11px] text-gray-600 hover:text-rose-400"
            >
              Clear
            </button>
          </div>
          <div className="space-y-1">
            {fills.slice(0, 8).map((fill) => (
              <div key={fill.id} className="flex items-center gap-2 text-xs">
                <span
                  className={`text-[10px] font-semibold uppercase ${
                    fill.type === "buy" ? "text-rose-400" : "text-emerald-400"
                  }`}
                >
                  {fill.type}
                </span>
                <span className="text-gray-300 truncate">{fill.itemName}</span>
                <span className="text-gray-500 font-mono">
                  {formatGp(fill.price)} x{fill.qty.toLocaleString()}
                </span>
                <span className="ml-auto text-gray-600">{formatAgo(fill.filledAt)}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
