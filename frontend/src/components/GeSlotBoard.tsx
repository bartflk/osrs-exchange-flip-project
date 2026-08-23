import type { ReactNode } from "preact/compat";
import type { GeSlot, MarketItem } from "../api";
import type { SlotAssignment } from "../capitalAllocator";
import { buildSlotViews, countNeedsAction, STATUS_STYLE, type SlotView } from "../geSlots";
import { formatGpFull } from "../format";

// DESIGN.md §14.42: one board that mirrors the in-game Grand Exchange, 8 boxes in the same 4x2
// reading order, so a box on screen is the box in the game.
//
// Direct request: "i want the same kind of interface where it lights up the box and tells me to
// buy/adjust price/sell. I want this interface in 1 spot so i can actually monitor and not switch
// between tabs constantly."
//
// Replaces a panel that showed hand-typed offers as slot cards while using the live RuneLite data
// only to *count* slots -- so the board could show a Dragon hunter lance that wasn't in the game
// at all, while the real Ruby/Diamond/Emerald sells appeared nowhere.
//
// Every state is derived, never asserted: fill progress comes from the slot's own
// quantitySold/totalQuantity, and the reprice/cancel verdict is the same computeRepriceGuidance()
// used for manual offers, so the two can't disagree. See geSlots.ts for the rules.

function iconUrl(icon: string | null | undefined): string {
  if (!icon) return "";
  return `https://oldschool.runescape.wiki/images/${encodeURIComponent(icon.replace(/ /g, "_"))}`;
}

export function GeSlotBoard({
  slots,
  suggestions,
  items,
  onSelectItem,
  showHeader = true,
  renderExtra,
}: {
  slots: GeSlot[];
  suggestions: SlotAssignment[];
  items: MarketItem[];
  onSelectItem: (item: MarketItem) => void;
  // Extra content rendered inside each card, below the existing status line. Overnight uses this
  // for the per-slot price-shape chart; Buy Signals passes nothing and is unchanged. Kept as a
  // render prop rather than a boolean flag so the board stays ignorant of what Overnight knows
  // (bedtime slot, sell slot, paired-day history) -- none of which belongs in a live GE board.
  renderExtra?: (v: SlotView) => ReactNode;
  // The Signals panel supplies its own header (with bankroll totals, hold-time and reroll
  // controls), so the board suppresses its own rather than stacking two titles.
  showHeader?: boolean;
}) {
  const views = buildSlotViews(slots, suggestions, items);
  const needsAction = countNeedsAction(views);

  function open(v: SlotView) {
    const id = v.slot?.itemId ?? v.suggestion?.item.id;
    const match = items.find((i) => i.id === id);
    if (match) onSelectItem(match);
  }

  return (
    <div>
      {showHeader && (
        <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
          <h3 className="text-sm font-medium text-gray-200">
            Grand Exchange
            <span className="ml-2 text-xs text-gray-500 font-normal">
              live from RuneLite · {slots.length}/8 in use
            </span>
            {needsAction > 0 && (
              <span className="ml-2 text-xs font-semibold text-amber-400">
                {needsAction} needs action
              </span>
            )}
          </h3>
        </div>
      )}

      {/* 4x2, same reading order as the in-game GE, so "slot 3" on screen is slot 3 in game. */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
        {views.map((v) => {
          const style = STATUS_STYLE[v.status];
          const pct =
            v.slot && v.slot.totalQuantity > 0
              ? (v.slot.quantitySold / v.slot.totalQuantity) * 100
              : 0;
          return (
            <div
              key={v.index}
              onClick={() => v.status !== "empty" && open(v)}
              className={`rounded-lg border p-2.5 min-h-[104px] flex flex-col ${style.box} ${
                v.status !== "empty" ? "cursor-pointer hover:brightness-125" : ""
              }`}
            >
              <div className="flex items-center justify-between mb-1">
                <span className="text-[10px] uppercase tracking-wide text-gray-600">
                  Slot {v.index}
                </span>
                <span className={`text-[10px] font-semibold uppercase ${style.tone}`}>
                  {v.slot ? `${style.label} · ${v.slot.type}` : style.label}
                </span>
              </div>

              {v.status === "empty" ? (
                <div className="flex-1 flex items-center justify-center text-xs text-gray-600">
                  —
                </div>
              ) : (
                <>
                  <div className="flex items-center gap-1.5 mb-1">
                    {(v.slot?.icon || v.suggestion?.item.icon) && (
                      <img
                        src={iconUrl(v.slot?.icon ?? v.suggestion?.item.icon)}
                        alt=""
                        className="w-4 h-4 object-contain shrink-0"
                      />
                    )}
                    <span className="text-sm text-gray-100 truncate">{v.headline}</span>
                  </div>

                  {v.slot && (
                    <>
                      <div className="flex items-baseline justify-between text-[11px] mb-1">
                        <span className="font-mono text-gray-300">{formatGpFull(v.slot.price)}</span>
                        <span className="font-mono text-gray-500">
                          {v.slot.quantitySold.toLocaleString()}/
                          {v.slot.totalQuantity.toLocaleString()}
                        </span>
                      </div>
                      <div className="h-1 bg-white/10 rounded-full overflow-hidden mb-1.5">
                        <div
                          className={`h-full ${v.slot.type === "buy" ? "bg-rose-400/70" : "bg-emerald-400/70"}`}
                          style={{ width: `${Math.min(100, pct)}%` }}
                        />
                      </div>
                    </>
                  )}

                  <p className={`text-[10px] leading-snug mt-auto ${style.tone}`}>{v.detail}</p>

                  {v.suggestedPrice != null && v.status === "reprice" && (
                    <p className="text-[10px] text-gray-400 mt-0.5 font-mono">
                      → {formatGpFull(v.suggestedPrice)}
                    </p>
                  )}

                  {renderExtra?.(v)}
                </>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
