import { useState } from "preact/hooks";
import { formatAgo, formatGp } from "../format";
import { type Offer, parseOffersText } from "../offers";
import { type Fill } from "../fills";

// Screenshot reading (paste/upload) now lives in BuySignals.tsx, wrapping the whole Capital
// allocator + this panel so Ctrl+V works anywhere in that area, not just inside this box -- see
// BuySignals.tsx for that flow and why it moved. This panel is now just the fallback manual-entry
// path (collapsed by default -- screenshot is the primary flow) plus the fills log.
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
  const [showManualEntry, setShowManualEntry] = useState(false);
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
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-sm font-medium text-gray-300">Recently filled</h3>
        <button
          onClick={() => setShowManualEntry((v) => !v)}
          className="text-[11px] text-gray-500 hover:text-gray-300"
        >
          {showManualEntry ? "Hide manual entry" : "Paste offers manually instead"}
        </button>
      </div>

      {showManualEntry && (
        <div className="rounded-lg bg-white/[0.02] border border-white/5 p-3 mb-3">
          <p className="text-[11px] text-gray-500 mb-2">
            Fallback for when a screenshot isn't handy -- one offer per line, tab-separated. Never
            submitted anywhere, stored locally only.
          </p>
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
                Clear all tracked offers
              </button>
            )}
            {offerError && <span className="text-xs text-amber-400">{offerError}</span>}
          </div>
        </div>
      )}

      {fills.length === 0 ? (
        <p className="text-xs text-gray-500 py-2">
          Nothing filled yet -- mark an offer "bought"/"sold" on a slot above to log it here.
        </p>
      ) : (
        <>
          <div className="flex items-center justify-end mb-1.5">
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
        </>
      )}
    </div>
  );
}
