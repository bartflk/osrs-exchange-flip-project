import { useState } from "preact/hooks";
import { formatAgo, formatGp } from "../format";
import { type Offer, parseOffersText } from "../offers";
import { type Fill } from "../fills";

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
}: {
  offers: Offer[];
  setOffers: (next: Offer[]) => void;
  fills: Fill[];
  setFills: (next: Fill[]) => void;
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

  return (
    <div className="glass rounded-xl p-4">
      <h3 className="text-sm font-medium text-gray-300 mb-2">Track a GE offer</h3>
      <p className="text-xs text-gray-500 mb-2">
        Paste offers here, or use "Track this buy" on a slot to the left -- either way it shows up
        as an occupied slot in the Capital allocator grid, compared against current market prices.
        Never submitted anywhere: there's no confirmed RuneLite plugin that exports live GE offer
        slots the way Bank Memory exports bank contents, so this is manual until one exists. Stored
        locally in your browser only.
      </p>
      <div className="rounded-lg bg-white/[0.02] border border-white/5 p-3 mb-3">
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
