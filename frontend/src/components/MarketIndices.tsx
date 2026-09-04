import { useEffect, useMemo, useState } from "preact/hooks";
import { fetchIndices, type MarketIndex, type TrendWindow } from "../api";
import { formatGp } from "../format";
import { Chip } from "./ui";

// One number per item group, so a move across a whole segment is visible without reading four
// thousand rows. DESIGN.md §16.
//
// Membership comes from the wiki's own category graph rather than a hand-written list, so it keeps
// up with the game on its own. The six PvM tier rows are the exception and say so: "high-end PvM
// gear" is not a wiki category, it is this app's opinion, and a reader is entitled to know which
// one they are looking at.
//
// This sits ALONGSIDE the filter preset chips rather than replacing them. The presets are the
// user's own saved views; an index is a fact about the market. They answer different questions and
// removing one to make room for the other would be a downgrade.

const WINDOWS: TrendWindow[] = ["1h", "4h", "12h", "24h", "7d", "30d"];

/** Group order, fixed rather than derived, so the board does not reshuffle between polls. */
const GROUP_ORDER = ["Combat gear", "PvM tiers", "Content", "Consumables", "Materials", "Ammunition", "By skill"];

function pct(v: number | null): string {
  if (v == null) return "n/a";
  return `${v >= 0 ? "+" : ""}${(v * 100).toFixed(2)}%`;
}

function tone(v: number | null): string {
  if (v == null) return "text-gray-600";
  if (v > 0.0005) return "text-emerald-400";
  if (v < -0.0005) return "text-rose-400";
  return "text-gray-400";
}

/**
 * How many of the basket's members rose, as a bar.
 *
 * The point of showing this next to the percentage: "Ranged weapons +0.50%" is a different fact
 * depending on whether 60 of 90 items rose or one bow carried it. Breadth and the top contributor
 * are the two columns that tell those apart.
 */
function BreadthBar({ up, down }: { up: number; down: number }) {
  const total = up + down;
  if (total === 0) return <div className="h-1 w-16 rounded-full bg-white/5" />;
  const upPct = (up / total) * 100;
  return (
    <div
      className="h-1 w-16 rounded-full bg-rose-500/40 overflow-hidden"
      title={`${up} up, ${down} down`}
    >
      <div className="h-full bg-emerald-500/70" style={{ width: `${upPct}%` }} />
    </div>
  );
}

function IndexRow({
  index,
  active,
  onSelect,
}: {
  index: MarketIndex;
  active: boolean;
  onSelect: () => void;
}) {
  const empty = index.changePct == null;
  return (
    <button
      onClick={onSelect}
      disabled={empty}
      className={`w-full text-left px-2 py-1.5 rounded-lg transition-colors flex items-center gap-2 ${
        active ? "bg-violet-500/15 ring-1 ring-violet-500/40" : "hover:bg-white/[0.04]"
      } ${empty ? "opacity-40 cursor-default" : ""}`}
    >
      <span className="text-xs text-gray-200 flex-1 min-w-0 truncate">
        {index.label}
        {index.derived && (
          <span
            className="ml-1 text-[9px] uppercase tracking-wide text-violet-400/80"
            title="Grouped by this app, not a wiki category. Equipment with an offensive bonus, split at 1m and 50m: round numbers chosen for legibility, not thresholds found in the data."
          >
            ours
          </span>
        )}
      </span>

      <span
        className={`font-mono text-xs tabular-nums w-16 text-right ${tone(index.changePct)}`}
        title="Turnover-weighted: each item counts for the gp that actually changed hands, so the figure tracks where money moved rather than which item got talked about."
      >
        {pct(index.changePct)}
      </span>

      <span
        className={`font-mono text-[10px] tabular-nums w-14 text-right ${tone(index.medianChangePct)}`}
        title="The median member's move. A median, not a mean, because these baskets include genuinely tiny items and a few of those swinging 200% on two trades would drag a mean to nonsense."
      >
        {pct(index.medianChangePct)}
      </span>

      <BreadthBar up={index.up} down={index.down} />

      <span
        className="text-[10px] text-gray-600 w-28 truncate hidden xl:block"
        title={
          index.topContributor
            ? `${index.topContributor.name} carries ${Math.round(index.topContributor.weight * 100)}% of this basket's turnover and moved ${pct(index.topContributor.changePct)}`
            : undefined
        }
      >
        {index.topContributor
          ? `${Math.round(index.topContributor.weight * 100)}% ${index.topContributor.name}`
          : ""}
      </span>

      <span className="text-[10px] text-gray-700 w-14 text-right tabular-nums hidden lg:block">
        {index.scored}/{index.total}
      </span>
    </button>
  );
}

export function MarketIndices({
  activeKey,
  onSelectIndex,
}: {
  activeKey: string | null;
  /** Null clears the filter. The caller owns the market table's state. */
  onSelectIndex: (key: string | null, label: string) => void;
}) {
  const [window, setWindow] = useState<TrendWindow>("24h");
  const [indices, setIndices] = useState<MarketIndex[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setIndices(null);
    setError(null);
    fetchIndices(window)
      .then((d) => !cancelled && setIndices(d.indices))
      .catch((e) => !cancelled && setError(e instanceof Error ? e.message : "failed"));
    return () => {
      cancelled = true;
    };
  }, [window]);

  const grouped = useMemo(() => {
    if (!indices) return [];
    const byGroup = new Map<string, MarketIndex[]>();
    for (const i of indices) {
      const list = byGroup.get(i.group);
      if (list) list.push(i);
      else byGroup.set(i.group, [i]);
    }
    // Within a group, biggest turnover first: the baskets where real money sits are the ones worth
    // reading, and alphabetical order would bury them under Capes.
    for (const list of byGroup.values()) list.sort((a, b) => b.turnover - a.turnover);
    return GROUP_ORDER.filter((g) => byGroup.has(g)).map((g) => ({
      group: g,
      rows: byGroup.get(g)!,
    }));
  }, [indices]);

  return (
    <div className="glass rounded-xl p-4">
      <div className="flex items-baseline justify-between gap-3 flex-wrap mb-3">
        <div>
          <h3 className="text-sm font-semibold text-gray-100">
            Market indices
            <span className="ml-2 text-[11px] font-normal text-gray-500">
              grouped by the wiki&apos;s own categories, priced live
            </span>
          </h3>
          <p className="text-[10px] text-gray-600 mt-0.5 max-w-3xl">
            First figure is turnover-weighted, so it follows the money. Second is the median
            member, so it follows the crowd. The two disagreeing means one item is carrying the
            basket, which the contributor column names. Click an index to filter the table below
            to its members.
          </p>
        </div>
        <div className="flex gap-1">
          {WINDOWS.map((w) => (
            <Chip key={w} active={window === w} onClick={() => setWindow(w)}>
              {w}
            </Chip>
          ))}
        </div>
      </div>

      {error && <p className="text-xs text-rose-400">{error}</p>}
      {!indices && !error && <p className="text-xs text-gray-500">Loading indices…</p>}

      {indices && (
        <>
          <div className="grid grid-cols-1 lg:grid-cols-2 2xl:grid-cols-3 gap-x-6 gap-y-3">
            {/* Collapsed by default to the groups a flipper reads first. Forty-five rows opened on
                every page load would bury the price table this panel sits above. */}
            {(collapsed ? grouped.slice(0, 3) : grouped).map(({ group, rows }) => (
              <div key={group}>
                <div className="text-[10px] uppercase tracking-wider text-gray-500 mb-1 px-2">
                  {group}
                </div>
                {rows.map((i) => (
                  <IndexRow
                    key={i.key}
                    index={i}
                    active={activeKey === i.key}
                    onSelect={() =>
                      onSelectIndex(activeKey === i.key ? null : i.key, i.label)
                    }
                  />
                ))}
              </div>
            ))}
          </div>
          {grouped.length > 3 && (
            <button
              onClick={() => setCollapsed((v) => !v)}
              className="mt-2 text-xs text-violet-400 hover:text-violet-300"
            >
              {collapsed ? `Show ${grouped.length - 3} more groups` : "Show fewer"}
            </button>
          )}
          <p className="text-[10px] text-gray-600 mt-2">
            Turnover across all indices:{" "}
            {formatGp(indices.reduce((s, i) => s + i.turnover, 0))} per hour. An index greyed out
            has no member with price history in this window.
          </p>
        </>
      )}
    </div>
  );
}
