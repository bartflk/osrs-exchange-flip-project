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
 * The icon to try for an item, preferring the GE catalogue's filename and falling back to the
 * wiki's own naming convention.
 *
 * The fallback carries most of these setups. Half the pieces in a real loadout are untradeable --
 * infernal cape, ferocious gloves, void, Rada's blessing -- so they are absent from the GE item
 * catalogue and have no icon recorded there, which left the most recognisable items in the grid
 * rendering as truncated text. The wiki hosts an image for them anyway, at "Item name.png", so
 * that is tried second and the text is kept only for the ones where even that 404s.
 */
function iconUrl(item: SetupItem): string {
  if (item.icon) return wikiImage(item.icon);
  return wikiImage(`${item.name.charAt(0).toUpperCase()}${item.name.slice(1)}.png`);
}

function Cell({ item, slot }: { item: SetupItem | null | undefined; slot?: string }) {
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
      className="relative w-9 h-9 rounded border border-white/10 bg-black/40 flex items-center justify-center overflow-hidden"
      title={`${item.name}${item.price != null ? ` — ${formatGp(item.price)}` : " — not tradeable, no GE price"}`}
    >
      <span className="absolute inset-0 flex items-center justify-center text-[7px] text-gray-500 text-center leading-tight px-0.5">
        {item.name.slice(0, 10)}
      </span>
      {/* Sits ON TOP of the name, so a 404 reveals the text underneath with no state to manage
          and no flash of a broken-image glyph. */}
      <img
        src={iconUrl(item)}
        alt=""
        loading="lazy"
        className="relative max-w-[30px] max-h-[30px]"
        onError={(e) => {
          (e.currentTarget as HTMLImageElement).style.display = "none";
        }}
      />
    </div>
  );
}

function SetupView({ setup }: { setup: StrategySetup }) {
  return (
    <div className="flex flex-wrap gap-5">
      <div>
        <div className="text-[10px] uppercase tracking-wider text-gray-500 mb-1.5">Worn</div>
        <div className="inline-flex flex-col gap-1 p-2 rounded-lg bg-black/25 border border-white/5">
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
      </div>

      <div>
        <div className="text-[10px] uppercase tracking-wider text-gray-500 mb-1.5">
          Inventory
          <span className="normal-case tracking-normal text-gray-600">
            {" "}
            &middot; {setup.inventory.filter(Boolean).length}/28 filled
          </span>
        </div>
        <div className="inline-grid grid-cols-4 gap-1 p-2 rounded-lg bg-black/25 border border-white/5">
          {setup.inventory.map((item, i) => (
            <Cell key={i} item={item} />
          ))}
        </div>
      </div>

      <div className="flex flex-col gap-3">
        {setup.runePouch.length > 0 && (
          <div>
            <div className="text-[10px] uppercase tracking-wider text-gray-500 mb-1.5">
              Rune pouch
            </div>
            <div className="inline-flex gap-1 p-2 rounded-lg bg-black/25 border border-white/5">
              {setup.runePouch.map((r) => (
                <Cell key={r.name} item={r} />
              ))}
            </div>
          </div>
        )}
        <div>
          <div className="text-[10px] uppercase tracking-wider text-gray-500 mb-1">Cost</div>
          <div className="font-mono text-lg text-gray-100 tabular-nums">
            {formatGp(setup.cost)}
          </div>
          {/* Stated as a floor, always. Void, quest gear, capes and consumables like Saradomin
              brews carry no GE price, and on a "Budget" setup those are most of the kit -- a
              total that quietly omitted them would understate exactly the barrier it exists to
              describe. */}
          <div className="text-[10px] text-gray-500 mt-0.5 max-w-[16rem]">
            floor: only {setup.pricedCount} of {setup.totalCount} pieces are tradeable, the rest
            have no GE price
          </div>
        </div>
      </div>
    </div>
  );
}

export function StrategySetupPanel({ activity }: { activity: string }) {
  const [data, setData] = useState<{ page: string | null; setups: StrategySetup[] } | null>(null);
  const [failed, setFailed] = useState(false);
  const [variant, setVariant] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setData(null);
    setFailed(false);
    setVariant(0);
    fetchStrategySetups(activity)
      .then((d) => !cancelled && setData(d))
      .catch(() => !cancelled && setFailed(true));
    return () => {
      cancelled = true;
    };
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
        <div className="text-[10px] uppercase tracking-wider text-gray-500">
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
