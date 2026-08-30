import type { ComponentChildren } from "preact";
import { useEffect, useState } from "preact/hooks";
import { fetchStrategySetups, type SetupItem, type StrategySetup } from "../api";
import { formatGp } from "../format";

// The wiki's own inventory setups, drawn the way the wiki draws them: the equipment silhouette
// and a 28-slot inventory, not a bullet list of item names.
//
// The shape carries the information. A list saying "Saradomin brew x7, Super restore x5,
// Anglerfish x3" is the same words as the grid, but the grid shows you at a glance that two
// thirds of the inventory is consumables and only four slots are weapons, which is what you
// actually want to know before committing to a trip. Copying the game's own layout also means
// there is nothing to learn: it is the interface the reader already has open.
//
// Variants ("Max Ranged" vs "Budget") are the reason this is worth having in a money-making tool
// at all. They are two different answers to "what can I afford", and this app is built around
// that question -- the budget setup for the Doom of Mokhaiotl is 24.8m against the max setup's
// 2.18bn, and only one of those is a decision most players are actually choosing between.

/**
 * Worn slots in the in-game grid, row by row. Empty strings are the gaps in the silhouette.
 *
 * Laid out explicitly rather than derived, because the interface is not a tidy 3-wide grid: the
 * head sits alone above a row of three, and legs sits alone between two more rows.
 */
const EQUIPMENT_GRID: string[][] = [
  ["", "head", ""],
  ["cape", "neck", "ammo"],
  ["weapon", "torso", "shield"],
  ["", "legs", ""],
  ["gloves", "boots", "ring"],
];

function wikiImage(file: string): string {
  return `https://oldschool.runescape.wiki/images/${encodeURIComponent(file.replace(/ /g, "_"))}`;
}

/**
 * The image to show for an item: the GE catalogue's icon, else the wiki thumbnail the backend
 * resolved, else nothing and the name shows through.
 *
 * The second of those carries most of these setups. Half the pieces in a real loadout are
 * untradeable -- Darklight, an infernal cape, void, Rada's blessing -- so the GE catalogue has no
 * icon for them. Guessing a filename from the item name was tried first and mostly 404'd, because
 * the wiki's files carry dose and charge suffixes the guides do not ("Saradomin brew" is stored at
 * "Saradomin brew(4) detail.png"). The backend now asks the wiki's API instead, which resolves
 * redirects and normalisation on the way.
 */
function iconUrl(item: SetupItem): string | null {
  if (item.icon) return wikiImage(item.icon);
  return item.imageUrl;
}

function Cell({ item, slot }: { item: SetupItem | null | undefined; slot?: string }) {
  // Whether the image actually failed, tracked rather than assumed.
  //
  // The first version stacked the item name UNDERNEATH the image so a 404 would reveal it with no
  // state to manage. That was wrong, and visibly so: item sprites are transparent PNGs, so the
  // text showed straight through every icon in the grid and the whole panel read as though it had
  // rendered on top of itself. Text is now shown only when there is genuinely nothing to draw.
  const [failed, setFailed] = useState(false);
  const url = item ? iconUrl(item) : null;

  if (!item) {
    return (
      <div
        className="w-9 h-9 rounded border border-white/5 bg-black/30"
        title={slot ? `${slot}: empty` : undefined}
      />
    );
  }
  return (
    <div
      // Untradeables are the norm in these setups, not an error, so they get a neutral border
      // rather than a warning colour. Only the total says anything about what is missing.
      className="w-9 h-9 rounded border border-white/10 bg-black/40 flex items-center justify-center overflow-hidden"
      title={`${item.name}${item.price != null ? `: ${formatGp(item.price)}` : ": not tradeable, no GE price"}`}
    >
      {url && !failed ? (
        <img
          src={url}
          alt=""
          loading="lazy"
          className="max-w-[30px] max-h-[30px]"
          onError={() => setFailed(true)}
        />
      ) : (
        <span className="text-[8px] text-gray-500 text-center leading-[1.1] px-0.5 line-clamp-3">
          {item.name}
        </span>
      )}
    </div>
  );
}

/**
 * The three grids side by side, sized to their contents.
 *
 * `w-fit` on the wrapper is what stops this sprawling. The panel used to be a flex row inside a
 * full-width cell, so the grids sat at the far left with several hundred pixels of dead space and
 * the cost floating alone in the middle of it -- three small objects spread across a very wide
 * board. Shrink-wrapping the group keeps them together and hands the reclaimed width back to the
 * columns beside it.
 */
function SetupView({ setup }: { setup: StrategySetup }) {
  const filled = setup.inventory.filter(Boolean).length;
  return (
    <div className="flex flex-wrap items-start gap-3 w-fit">
      <Grid label="Worn">
        <div className="flex flex-col gap-1">
          {EQUIPMENT_GRID.map((row, ri) => (
            <div key={ri} className="flex gap-1 justify-center">
              {row.map((slot, ci) =>
                slot === "" ? (
                  <div key={ci} className="w-9 h-9" />
                ) : (
                  <Cell key={ci} slot={slot} item={setup.equipment[slot]} />
                ),
              )}
            </div>
          ))}
        </div>
      </Grid>

      <Grid label="Inventory" note={`${filled}/28`}>
        <div className="grid grid-cols-4 gap-1">
          {setup.inventory.map((item, i) => (
            <Cell key={i} item={item} />
          ))}
        </div>
      </Grid>

      <div className="flex flex-col gap-3">
        {setup.runePouch.length > 0 && (
          <Grid label="Rune pouch">
            <div className="flex gap-1">
              {setup.runePouch.map((r) => (
                <Cell key={r.name} item={r} />
              ))}
            </div>
          </Grid>
        )}
        <div>
          <div className="text-[11px] uppercase tracking-wider text-gray-500">Kit cost</div>
          <div className="font-mono text-lg text-gray-100 tabular-nums leading-tight">
            {formatGp(setup.cost)}
          </div>
          {/* Stated as a floor, always. Void, quest gear, capes and consumables like Saradomin
              brews carry no GE price, and on a "Budget" setup those are most of the kit -- a
              total that quietly omitted them would understate exactly the barrier it exists to
              describe. */}
          <div className="text-[10.5px] text-gray-600 max-w-[12rem] leading-snug">
            floor &middot; {setup.pricedCount} of {setup.totalCount} pieces have a GE price
          </div>
        </div>
      </div>
    </div>
  );
}

function Grid({
  label,
  note,
  children,
}: {
  label: string;
  note?: string;
  children: ComponentChildren;
}) {
  return (
    <div>
      <div className="text-[11px] uppercase tracking-wider text-gray-500 mb-1">
        {label}
        {note && <span className="normal-case tracking-normal text-gray-600"> {note}</span>}
      </div>
      <div className="inline-block p-1.5 rounded-lg bg-black/25 border border-white/5">
        {children}
      </div>
    </div>
  );
}

export function StrategySetupPanel({
  activity,
  onResolved,
}: {
  activity: string;
  /** Whether a real loadout was found, so the caller can drop its own weaker gear list. */
  onResolved?: (found: boolean) => void;
}) {
  const [data, setData] = useState<{ page: string | null; setups: StrategySetup[] } | null>(null);
  const [failed, setFailed] = useState(false);
  const [variant, setVariant] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setData(null);
    setFailed(false);
    setVariant(0);
    fetchStrategySetups(activity)
      .then((d) => {
        if (cancelled) return;
        setData(d);
        onResolved?.(d.setups.length > 0);
      })
      .catch(() => {
        if (cancelled) return;
        setFailed(true);
        onResolved?.(false);
      });
    return () => {
      cancelled = true;
    };
    // onResolved deliberately excluded: callers pass an inline closure, so including it would
    // refetch the wiki on every parent render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activity]);

  if (failed) return null;
  if (!data) {
    return <div className="text-[11px] text-gray-600">Loading the wiki&apos;s setup…</div>;
  }
  // Most activities are not bosses and have no Strategies page. Rendering an empty "no setup"
  // card under every farming run would be pure noise.
  if (data.setups.length === 0) return null;

  const active = data.setups[Math.min(variant, data.setups.length - 1)];
  return (
    <div>
      <div className="flex items-baseline justify-between gap-3 flex-wrap mb-2">
        <div className="text-[11px] uppercase tracking-wider text-gray-500">
          Setup from the wiki
          {data.page && (
            <a
              href={`https://oldschool.runescape.wiki/w/${encodeURIComponent(data.page.replace(/ /g, "_"))}`}
              target="_blank"
              rel="noreferrer"
              className="normal-case tracking-normal text-violet-400 hover:text-violet-300 ml-1.5"
            >
              {data.page} ↗
            </a>
          )}
        </div>
        {data.setups.length > 1 && (
          <div className="flex gap-1">
            {data.setups.map((s, i) => (
              <button
                key={s.variant}
                onClick={() => setVariant(i)}
                className={`text-[10px] px-2 py-0.5 rounded-full border transition-colors ${
                  i === variant
                    ? "bg-violet-500/20 text-violet-300 border-violet-500/40"
                    : "bg-white/5 text-gray-400 border-white/10 hover:text-gray-200"
                }`}
              >
                {s.variant}
              </button>
            ))}
          </div>
        )}
      </div>
      <SetupView setup={active} />
    </div>
  );
}
