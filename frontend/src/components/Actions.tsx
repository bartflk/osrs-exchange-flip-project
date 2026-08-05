import { useMemo, useState } from "preact/hooks";
import type { MarketItem } from "../api";
import type { HoldingEntry } from "../bankHoldings";
import { formatGp, formatPct } from "../format";
import { type Offer, loadOffers, saveOffers, parseOffersText } from "../offers";

function iconUrl(icon: string): string {
  if (!icon) return "";
  return `https://oldschool.runescape.wiki/images/${encodeURIComponent(icon.replace(/ /g, "_"))}`;
}

// Rule-based, no ML/Claude involved -- transparent thresholds so the suggestion is always
// explainable from the same numbers already shown elsewhere in the app.
const WEAK_ROI = 0.003; // 0.3% -- below this a held item's current flip margin barely beats noise

export function Actions({
  items,
  heldItems,
  holdings,
  onSelectItem,
}: {
  items: MarketItem[];
  heldItems: MarketItem[];
  holdings: Record<number, HoldingEntry>;
  onSelectItem: (item: MarketItem) => void;
}) {
  const [offers, setOffersRaw] = useState<Offer[]>(() => loadOffers());
  const [offerText, setOfferText] = useState("");
  const [offerError, setOfferError] = useState<string | null>(null);

  function setOffers(next: Offer[]) {
    setOffersRaw(next);
    saveOffers(next);
  }

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

  function removeOffer(id: string) {
    setOffers(offers.filter((o) => o.id !== id));
  }

  const heldIds = useMemo(() => new Set(Object.keys(holdings).map(Number)), [holdings]);

  // Sell candidates: items you currently hold whose live flip economics are weak right now
  // (no margin, or margin so thin it's basically noise) -- a simple, explainable heuristic,
  // not a prediction. Bank items with no current market row (too illiquid to have made this
  // poll's item list) are shown separately since there's nothing to score them against.
  const sellCandidates = useMemo(() => {
    return heldItems
      .map((item) => {
        const holding = holdings[item.id];
        if (!holding || holding.qty <= 0) return null;
        const roi = item.roi_pct ?? -Infinity;
        const weak = (item.net_margin ?? 0) <= 0 || roi < WEAK_ROI;
        if (!weak) return null;
        return { item, holding };
      })
      .filter((x): x is { item: MarketItem; holding: HoldingEntry } => x != null)
      .sort((a, b) => (b.holding.netValue ?? 0) - (a.holding.netValue ?? 0));
  }, [heldItems, holdings]);

  const unpricedHeld = useMemo(
    () => Object.entries(holdings).filter(([id]) => !heldItems.some((i) => i.id === Number(id))),
    [holdings, heldItems],
  );

  // Fresh buy candidates: current Buy Signals ranking, same as the Buy Signals tab, but flagged
  // by whether you already hold the item -- already-held items sort after fresh ones instead of
  // being hidden, since "add to an existing position" is still useful information.
  const buyCandidates = useMemo(() => {
    return items
      .filter((i) => (i.net_margin ?? 0) > 0)
      .sort((a, b) => {
        const aHeld = heldIds.has(a.id) ? 1 : 0;
        const bHeld = heldIds.has(b.id) ? 1 : 0;
        if (aHeld !== bHeld) return aHeld - bHeld;
        return b.score - a.score;
      })
      .slice(0, 12);
  }, [items, heldIds]);

  const offerRows = useMemo(() => {
    return offers.map((offer) => {
      const market = items.find((i) => i.name.toLowerCase() === offer.itemName.toLowerCase());
      let fillNote: { label: string; tone: "good" | "mid" | "bad" } | null = null;
      if (market) {
        if (offer.type === "buy" && market.low != null) {
          if (offer.price >= market.low)
            fillNote = { label: "at/above market -- should fill fast", tone: "good" };
          else if (offer.price >= market.low * 0.98)
            fillNote = { label: "slightly under market", tone: "mid" };
          else fillNote = { label: "well under market -- may sit unfilled", tone: "bad" };
        } else if (offer.type === "sell" && market.high != null) {
          if (offer.price <= market.high)
            fillNote = { label: "at/below market -- should fill fast", tone: "good" };
          else if (offer.price <= market.high * 1.02)
            fillNote = { label: "slightly over market", tone: "mid" };
          else fillNote = { label: "well over market -- may sit unfilled", tone: "bad" };
        }
      }
      return { offer, market, fillNote };
    });
  }, [offers, items]);

  return (
    <div className="space-y-6">
      <section>
        <h3 className="text-sm font-medium text-gray-300 mb-2">Consider selling</h3>
        <p className="text-xs text-gray-500 mb-3">
          Items from your Bank import whose live flip margin is currently zero/negative or under{" "}
          {formatPct(WEAK_ROI)}
          ROI -- capital that could likely do more elsewhere. Rule-based off the same net margin/ROI
          shown in Market, not a prediction.
        </p>
        {sellCandidates.length === 0 && unpricedHeld.length === 0 && (
          <div className="glass rounded-xl p-6 text-center text-gray-500 text-sm">
            {Object.keys(holdings).length === 0
              ? "No bank data yet -- import your bank in the Bank tab first."
              : "Nothing flagged -- your current holdings all look like reasonable holds right now."}
          </div>
        )}
        {sellCandidates.length > 0 && (
          <div className="grid grid-cols-1 md:grid-cols-2 2xl:grid-cols-3 gap-3">
            {sellCandidates.map(({ item, holding }) => (
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
                  <span className="text-[10px] font-semibold tracking-wide uppercase px-2 py-0.5 rounded-full bg-rose-500/15 text-rose-400 border border-rose-500/30 shrink-0">
                    Sell
                  </span>
                </div>
                <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
                  <span className="text-gray-500">You hold</span>
                  <span className="font-mono text-gray-200 text-right">
                    {holding.qty.toLocaleString()}
                  </span>
                  <span className="text-gray-500">Net margin now</span>
                  <span
                    className={`font-mono text-right ${(item.net_margin ?? 0) >= 0 ? "text-emerald-400" : "text-rose-400"}`}
                  >
                    {formatGp(item.net_margin)}
                  </span>
                  <span className="text-gray-500">ROI now</span>
                  <span
                    className={`font-mono text-right ${(item.roi_pct ?? 0) >= 0 ? "text-emerald-400" : "text-rose-400"}`}
                  >
                    {formatPct(item.roi_pct)}
                  </span>
                </div>
                <div className="mt-1 pt-2 border-t border-white/10 flex items-center justify-between">
                  <div className="text-xs text-gray-500">
                    Proceeds if sold now (after tax)
                    <div className="text-lg font-mono text-white">
                      {formatGp(holding.netValue)}gp
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
        {unpricedHeld.length > 0 && (
          <p className="text-xs text-gray-600 mt-3">
            {unpricedHeld.length} held item{unpricedHeld.length === 1 ? "" : "s"} have no current
            Market row (too illiquid to appear in this poll) -- check them manually in the Bank tab.
          </p>
        )}
      </section>

      <section>
        <h3 className="text-sm font-medium text-gray-300 mb-2">Fresh buy candidates</h3>
        <p className="text-xs text-gray-500 mb-3">
          Same ranking as Buy Signals. Items you already hold are flagged and sorted after ones you
          don't, rather than hidden -- still useful to know you could add to an existing position.
        </p>
        <div className="grid grid-cols-1 md:grid-cols-2 2xl:grid-cols-3 gap-3">
          {buyCandidates.map((item) => {
            const held = heldIds.has(item.id);
            return (
              <div
                key={item.id}
                className={`glass rounded-xl p-4 flex flex-col gap-2 ${held ? "opacity-70" : ""}`}
              >
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
                  {held ? (
                    <span className="text-[10px] font-semibold tracking-wide uppercase px-2 py-0.5 rounded-full bg-sky-500/15 text-sky-400 border border-sky-500/30 shrink-0">
                      Already hold {holdings[item.id]?.qty.toLocaleString()}
                    </span>
                  ) : (
                    <span className="text-[10px] font-semibold tracking-wide uppercase px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-400 border border-emerald-500/30 shrink-0">
                      Buy
                    </span>
                  )}
                </div>
                <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
                  <span className="text-gray-500">Buy at</span>
                  <span className="font-mono text-gray-200 text-right">{formatGp(item.low)}</span>
                  <span className="text-gray-500">Net margin</span>
                  <span className="font-mono text-emerald-400 text-right">
                    {formatGp(item.net_margin)}
                  </span>
                  <span className="text-gray-500">ROI</span>
                  <span className="font-mono text-emerald-400 text-right">
                    {formatPct(item.roi_pct)}
                  </span>
                </div>
              </div>
            );
          })}
          {buyCandidates.length === 0 && (
            <div className="glass rounded-xl p-6 text-center text-gray-500 text-sm col-span-full">
              No positive-margin items in the current Market fetch.
            </div>
          )}
        </div>
      </section>

      <section>
        <h3 className="text-sm font-medium text-gray-300 mb-2">Open GE offers</h3>
        <p className="text-xs text-gray-500 mb-2">
          Purely a display aid -- typed/pasted in by hand, compared against current market prices,
          never submitted anywhere. There's no confirmed RuneLite plugin that exports live GE offer
          slots the way Bank Memory exports bank contents (checked Exchange Logger and
          OSRS-Flipper-2 -- both log completed transaction history, not open-offer state), so this
          is manual until one exists. Stored locally in your browser only.
        </p>
        <div className="glass rounded-xl p-4 mb-3">
          <textarea
            value={offerText}
            onChange={(e) => setOfferText(e.target.value)}
            placeholder={
              "type\\titem name\\tprice\\tqty\nbuy\\tAbyssal whip\\t830000\\t5\nsell\\tArmadyl crossbow\\t34500000\\t1"
            }
            rows={3}
            className="glass rounded-lg w-full px-3 py-2 text-xs font-mono text-gray-200 placeholder:text-gray-600 outline-none"
          />
          <div className="flex items-center gap-3 mt-2">
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

        {offerRows.length > 0 && (
          <div className="glass rounded-xl overflow-hidden">
            <table className="w-full text-sm text-left">
              <thead>
                <tr className="border-b border-white/10 text-gray-500 text-xs">
                  <th className="px-4 py-2 font-medium">Type</th>
                  <th className="px-4 py-2 font-medium">Item</th>
                  <th className="px-4 py-2 font-medium">Your price</th>
                  <th className="px-4 py-2 font-medium">Qty</th>
                  <th className="px-4 py-2 font-medium">Current market</th>
                  <th className="px-4 py-2 font-medium">Fill likelihood</th>
                  <th className="px-4 py-2 font-medium"></th>
                </tr>
              </thead>
              <tbody>
                {offerRows.map(({ offer, market, fillNote }) => (
                  <tr key={offer.id} className="border-b border-white/5">
                    <td className="px-4 py-1.5">
                      <span
                        className={`text-[10px] font-semibold tracking-wide uppercase px-1.5 py-0.5 rounded ${
                          offer.type === "buy"
                            ? "bg-rose-500/15 text-rose-400 border border-rose-500/30"
                            : "bg-emerald-500/15 text-emerald-400 border border-emerald-500/30"
                        }`}
                      >
                        {offer.type}
                      </span>
                    </td>
                    <td className="px-4 py-1.5 text-gray-100">
                      {market ? (
                        <button
                          onClick={() => onSelectItem(market)}
                          className="hover:underline hover:text-white"
                        >
                          {offer.itemName}
                        </button>
                      ) : (
                        offer.itemName
                      )}
                    </td>
                    <td className="px-4 py-1.5 font-mono text-gray-300">{formatGp(offer.price)}</td>
                    <td className="px-4 py-1.5 font-mono text-gray-300">
                      {offer.qty.toLocaleString()}
                    </td>
                    <td className="px-4 py-1.5 font-mono text-gray-500">
                      {market
                        ? `${formatGp(market.low)} / ${formatGp(market.high)}`
                        : "not in current Market fetch"}
                    </td>
                    <td className="px-4 py-1.5">
                      {fillNote ? (
                        <span
                          className={
                            fillNote.tone === "good"
                              ? "text-emerald-400"
                              : fillNote.tone === "mid"
                                ? "text-amber-400"
                                : "text-rose-400"
                          }
                        >
                          {fillNote.label}
                        </span>
                      ) : (
                        <span className="text-gray-600">—</span>
                      )}
                    </td>
                    <td className="px-4 py-1.5 text-right">
                      <button
                        onClick={() => removeOffer(offer.id)}
                        className="text-xs text-gray-500 hover:text-rose-400"
                      >
                        Remove
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
