import { useMemo, useState } from "preact/hooks";
import type { MarketItem } from "../api";
import { formatGp, formatPct } from "../format";
import { type WatchEntry, toggleWatch } from "../watchlist";
import { type BlockEntry, toggleBlock } from "../blocklist";
import { Badge, Button, EmptyState } from "./ui";
import { InfoTip, Tip } from "./InfoTip";
import type { ExplanationId } from "../explanations";
import { showToast } from "../toast";

// No-entry sign (circle + diagonal bar) -- reads as "blocked" at a glance, unlike a bare
// emoji whose rendering varies by OS/font and doesn't reliably look like "block" at 16px.
function BlockIcon({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 20 20" fill="none" className={className} aria-hidden="true">
      <circle cx="10" cy="10" r="7.25" stroke="currentColor" strokeWidth="1.6" />
      <line x1="5.4" y1="14.6" x2="14.6" y2="5.4" stroke="currentColor" strokeWidth="1.6" />
    </svg>
  );
}

type SortKey =
  | "name"
  | "rank"
  | "gp_per_hour"
  | "low"
  | "high"
  | "net_margin"
  | "roi_pct"
  | "daily_volume"
  | "margin_x_volume"
  | "potential_profit"
  | "price_age";

// Sort keys whose "natural" first click is ascending (A-Z, soonest-first) rather than the
// descending "biggest number first" every gp/pct/score column defaults to.
const ASC_FIRST: Partial<Record<SortKey, true>> = { name: true, price_age: true };

// Potential profit = net margin over a full buy-limit cycle (the most you could pocket
// flipping this item to its GE limit right now) -- not tracked server-side, since it's a
// pure function of fields the item already carries, so it's computed here rather than adding
// a redundant column to the backend's scoring query.
function potentialProfit(item: MarketItem): number | null {
  if (item.net_margin == null || item.buy_limit == null) return null;
  return item.net_margin * item.buy_limit;
}

// Per-column filter rules (funnel icon in each numeric header) -- distinct from the global
// filter bar above the table (search/preset/price-range/membership), which stays in App.tsx.
// Kept self-contained here since nothing outside this table needs to know about them.
type FilterOp = "gte" | "lte" | "eq" | "neq" | "gt" | "lt" | "between";

const OP_LABELS: Record<FilterOp, string> = {
  gte: "≥ Greater than or equal",
  lte: "≤ Less than or equal",
  eq: "= Equals",
  neq: "≠ Not equal to",
  gt: "> Greater than",
  lt: "< Less than",
  between: "↔ Between",
};

interface ColumnFilter {
  op: FilterOp;
  value: number;
  value2?: number; // only used by "between"
}

// ROI is stored as a fraction (0.05 = 5%) but displayed and typed as a percent -- convert once
// here rather than asking the user to type "0.05" to mean 5%.
const PERCENT_KEYS: Partial<Record<SortKey, true>> = { roi_pct: true };

/**
 * The older of the two last-trade times, in seconds.
 *
 * The OLDER on purpose. A margin is the difference between a buy price and a sell price, so it is
 * only as current as whichever of the two is staler; a fresh instabuy against a sell price from
 * last Tuesday is not a spread, it is a memory. Measured across the whole catalogue the mean
 * last-trade age is over five days, so this is not a rare edge.
 */
function priceAge(item: MarketItem): number | null {
  const ages = [item.buy_age, item.sell_age].filter((a): a is number => a != null);
  return ages.length ? Math.max(...ages) : null;
}

function columnValue(item: MarketItem, key: SortKey): number | null {
  if (key === "name") return null; // not filterable, no funnel on that header
  const raw =
    key === "potential_profit"
      ? potentialProfit(item)
      : key === "price_age"
        ? priceAge(item)
        : key === "rank"
          ? (item.flip?.score ?? null)
          : key === "gp_per_hour"
            ? (item.flip?.gpPerHour ?? null)
            : item[key];
  if (raw == null) return null;
  return PERCENT_KEYS[key] ? raw * 100 : raw;
}

function matchesFilter(value: number | null, filter: ColumnFilter): boolean {
  if (value == null) return false; // no data can't satisfy a numeric rule
  switch (filter.op) {
    case "gte":
      return value >= filter.value;
    case "lte":
      return value <= filter.value;
    case "eq":
      return value === filter.value;
    case "neq":
      return value !== filter.value;
    case "gt":
      return value > filter.value;
    case "lt":
      return value < filter.value;
    case "between":
      return value >= filter.value && value <= (filter.value2 ?? filter.value);
  }
}

// Nine columns carrying what eleven used to, because four of the old ones were not answering a
// question anyone asks of a flipping table.
//
// GONE. Tax was a deterministic 2% of the sell price that Margin had already subtracted, so it
// spent a column restating arithmetic. Score was net_margin x log10(liquidity) over a volatility
// penalty, and measured on live data 29 of its top 30 items were the same 30 as sorting by raw
// margin: an opaque number that reordered a column already on screen. Liquidity/hr and Limit did
// not vanish, they moved under the columns they qualify, because neither is read on its own.
//
// NEW, and both taken from what the competing tools lead with. Volume/day says whether anybody
// trades this at all, which nothing here answered before. Margin x volume says where profit
// actually moves through the market, as opposed to where the widest spread is sitting untouched.
// Age says whether the two prices the margin is built from are minutes or days old.
const columns: {
  key: SortKey;
  label: string;
  align?: "right";
  title?: string;
  explain?: ExplanationId;
}[] = [
  {
    key: "rank",
    label: "Rank",
    align: "right",
    title:
      "How good a flip this is, 0 to 100, from five factors: what one GE slot earns per hour, the return after tax as a risk buffer, how much of a buy-limit cycle the market can absorb, how recent the two prices are, and whether this spread is normal for this item. Hover a rank to see the five. Underneath is the money itself, per hour, for one slot.",
  },
  { key: "low", label: "Buy", align: "right", title: "Most recent price someone bought at" },
  { key: "high", label: "Sell", align: "right", title: "Most recent price someone sold at" },
  {
    key: "net_margin",
    label: "Margin",
    align: "right",
    explain: "netMargin",
    title: "Per unit after the 2% GE tax. ROI underneath is that margin over the buy price.",
  },
  {
    key: "daily_volume",
    label: "Vol/day",
    align: "right",
    title:
      "Units traded across the whole game in the last 24 hours. Underneath is what you could realistically fill in an hour, the thinner side of the last hour of trade.",
  },
  {
    key: "margin_x_volume",
    label: "Margin x vol",
    align: "right",
    title:
      "Margin times daily volume: the profit the whole market moved through this item in a day. Where the money is, as distinct from where the widest untouched spread is. It is NOT what you can make, that is the next column.",
  },
  {
    key: "potential_profit",
    label: "Per limit",
    align: "right",
    explain: "potentialProfit",
    title:
      "What YOU clear buying to the GE limit once, after tax. The buy limit underneath is the cap, per 4 hours.",
  },
  {
    key: "price_age",
    label: "Age",
    align: "right",
    title:
      "Time since the last real trade, taking the older of the buy and sell side. The margin is only as current as the staler of the two.",
  },
];

// DESIGN.md §14.12: tiered volatility badge, coefficient of variation of the high price over a
// trailing 24h (volatility.ts). Thresholds are a starting judgment call, not derived from a
// backtest -- revisit once real usage shows whether they're well-calibrated.
function volatilityTone(pct: number): "success" | "warning" | "danger" {
  if (pct < 0.05) return "success";
  if (pct < 0.15) return "warning";
  return "danger";
}

/** Volume reads as a count, not money, so it gets its own compact form rather than formatGp. */
function compactCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}m`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}k`;
  return String(n);
}

function shortAge(seconds: number): string {
  if (seconds < 90) return `${Math.round(seconds)}s`;
  if (seconds < 5400) return `${Math.round(seconds / 60)}m`;
  if (seconds < 172800) return `${Math.round(seconds / 3600)}h`;
  return `${Math.round(seconds / 86400)}d`;
}

/**
 * How stale the two prices behind the margin are, worst side first.
 *
 * Coloured rather than merely printed, because this is the column that says whether the rest of
 * the row is describing today. Across the whole catalogue the mean last-trade age is over five
 * days: most of what the Grand Exchange lists is not trading, and a spread quoted off two prices
 * from last week is arithmetic on fossils.
 */
function AgeCell({ item }: { item: MarketItem }) {
  const worst = priceAge(item);
  if (worst == null) return <span className="text-gray-700">-</span>;
  const tone = worst < 600 ? "text-gray-300" : worst < 3600 ? "text-amber-300" : "text-rose-400";
  const panel = (
    <>
      <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-[11px]">
        <span className="text-gray-400">Last buy</span>
        <span className="font-mono text-rose-300 text-right">
          {item.buy_age != null ? `${shortAge(item.buy_age)} ago` : "never"}
        </span>
        <span className="text-gray-400">Last sell</span>
        <span className="font-mono text-emerald-300 text-right">
          {item.sell_age != null ? `${shortAge(item.sell_age)} ago` : "never"}
        </span>
      </div>
      <p className="mt-2.5 text-[10.5px] text-gray-400 leading-relaxed">
        The column shows the OLDER of the two, because a margin is the gap between a buy price and a
        sell price and is only as current as whichever of them is staler.
      </p>
      <p className="mt-1.5 text-[10px] text-gray-600 leading-snug">
        Under 10 minutes reads as live, under an hour as worth checking, past that the spread is
        describing a market that has probably moved. Measured across the whole catalogue the mean
        last-trade age is over five days, so most of what the GE lists is not trading at all.
      </p>
    </>
  );
  return (
    <Tip title="Price age" content={panel} width={250}>
      <span className={tone}>{shortAge(worst)}</span>
    </Tip>
  );
}

/**
 * A day of price in twelve points.
 *
 * Deliberately unlabelled and unscaled: every number is already in a column to the left, and what
 * a number cannot show is whether the price is walking down into the spread you are about to buy.
 * Coloured by the net move so the direction survives at this size, where a 40px line does not read
 * as up or down on its own. Fewer than three points draws nothing, because two points is a
 * straight line between two arbitrary moments and would read as a stable price.
 */
function Sparkline({ points }: { points?: number[] }) {
  if (!points || points.length < 3) {
    return <span className="text-[10px] text-gray-700" title="Not enough local history yet">-</span>;
  }
  const w = 56;
  const h = 16;
  const min = Math.min(...points);
  const max = Math.max(...points);
  const span = max - min || 1;
  const d = points
    .map((p, i) => {
      const px = (i / (points.length - 1)) * w;
      const py = h - ((p - min) / span) * h;
      return `${i === 0 ? "M" : "L"}${px.toFixed(1)},${py.toFixed(1)}`;
    })
    .join(" ");
  const change = (points[points.length - 1] - points[0]) / (points[0] || 1);
  const stroke = change > 0.001 ? "#34d399" : change < -0.001 ? "#fb7185" : "#94a3b8";
  const panel = (
    <>
      <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-[11px]">
        <span className="text-gray-400">Move over the day</span>
        <span
          className={`font-mono text-right ${change >= 0 ? "text-emerald-400" : "text-rose-400"}`}
        >
          {change >= 0 ? "+" : ""}
          {(change * 100).toFixed(1)}%
        </span>
        <span className="text-gray-400">High</span>
        <span className="font-mono text-right text-gray-200">{formatGp(max)}</span>
        <span className="text-gray-400">Low</span>
        <span className="font-mono text-right text-gray-200">{formatGp(min)}</span>
        <span className="text-gray-400">Points</span>
        <span className="font-mono text-right text-gray-500">{points.length} of 12</span>
      </div>
      <p className="mt-2.5 text-[10px] text-gray-500 leading-snug">
        Two-hour buckets from this install&apos;s own price history, so an item it has been
        watching for less than a day draws a shorter line. Shape only, and unscaled: the prices are
        in the columns to the left.
      </p>
    </>
  );
  return (
    <Tip title="Last 24 hours" content={panel} width={240}>
      <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} className="overflow-visible block">
        <path d={d} fill="none" stroke={stroke} stroke-width={1.25} stroke-linejoin="round" />
      </svg>
    </Tip>
  );
}

const FACTOR_LABELS: Record<string, string> = {
  income:
    "Gp one GE slot earns per hour here, log-scaled to a 2m/hr ceiling. You are allocating eight slots, not unlimited capital, so money per slot is the objective.",
  edge: "Return after tax, full marks at 3%. A risk buffer: under about half a percent, one tick of adverse movement while your offer sits wipes the trade out.",
  fill: "How much of one buy-limit cycle the market can absorb in four hours, judged on the thinner of the two sides.",
  freshness: "How recent the two prices behind the margin are, taking the older. Halves every 30 minutes.",
  stability:
    "Whether this spread is normal for this item, and how calm the price has been. A spread many times its own norm is usually one stale side, not free money.",
};

function rankTone(score: number): string {
  if (score >= 80) return "text-emerald-400";
  if (score >= 60) return "text-sky-300";
  if (score >= 35) return "text-amber-300";
  return "text-gray-500";
}

/**
 * The rank, the money behind it, and the five factors in the tooltip.
 *
 * A single opaque number is what the old score was, and the reason it went unquestioned for so
 * long while being a re-sort of margin. This one shows the reason it is not higher on the row
 * itself, so a rank that looks wrong can be argued with rather than merely distrusted.
 */
function FactorBar({ label, value, why }: { label: string; value: number; why: string }) {
  return (
    <div className="mb-2 last:mb-0">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[11px] text-gray-300">{label}</span>
        <span className="font-mono text-[11px] tabular-nums text-gray-400">
          {(value * 100).toFixed(0)}
        </span>
      </div>
      <div className="h-1.5 rounded-full bg-white/[0.08] mt-1 overflow-hidden">
        <div
          className={`h-full rounded-full ${
            value >= 0.75 ? "bg-emerald-400/80" : value >= 0.4 ? "bg-sky-400/70" : "bg-amber-400/70"
          }`}
          style={{ width: `${Math.max(value * 100, 2)}%` }}
        />
      </div>
      <p className="text-[10px] text-gray-500 leading-snug mt-0.5">{why}</p>
    </div>
  );
}

/**
 * The rank, the money behind it, and the five factors as a hover panel.
 *
 * This used to pack all of it into a native `title` string with escaped newlines, which the
 * browser renders as flat grey text after a one-second delay and then hides again mid-read. The
 * whole point of showing the factors is that a rank you disagree with should be arguable, and an
 * argument you cannot finish reading is not much of one.
 */
function RankCell({ item }: { item: MarketItem }) {
  const flip = item.flip;
  if (!flip) return <span className="text-gray-700">-</span>;

  const panel = (
    <>
      <div className="flex items-baseline justify-between mb-2.5 pb-2 border-b border-white/10">
        <span className={`font-mono text-2xl font-semibold ${rankTone(flip.score)}`}>
          {flip.score.toFixed(0)}
        </span>
        <span className="font-mono text-xs text-gray-300">
          {flip.gpPerHour > 0 ? `${formatGp(Math.round(flip.gpPerHour))} / hr` : "no income"}
        </span>
      </div>

      <FactorBar label="Income" value={flip.income} why={FACTOR_LABELS.income} />
      <FactorBar label="Edge" value={flip.edge} why={FACTOR_LABELS.edge} />
      <FactorBar label="Fill" value={flip.fill} why={FACTOR_LABELS.fill} />
      <FactorBar label="Freshness" value={flip.freshness} why={FACTOR_LABELS.freshness} />
      <FactorBar label="Stability" value={flip.stability} why={FACTOR_LABELS.stability} />

      <div className="mt-2.5 pt-2 border-t border-white/10 text-[10.5px] text-gray-400 leading-relaxed">
        One cycle is{" "}
        <span className="font-mono text-gray-200">
          {Math.round(flip.expectedUnits).toLocaleString()}
        </span>{" "}
        units over 4 hours,{" "}
        <span className="font-mono text-gray-200">
          {formatGp(Math.round(flip.cycleCapital))}
        </span>{" "}
        of capital in and{" "}
        <span
          className={`font-mono ${flip.cycleProfit >= 0 ? "text-emerald-400" : "text-rose-400"}`}
        >
          {formatGp(Math.round(flip.cycleProfit))}
        </span>{" "}
        out after tax.
      </div>
      <p className="mt-1.5 text-[10px] text-gray-600 leading-snug">
        The five are multiplied, weighted, so a zero anywhere is disqualifying rather than averaged
        away.
        {flip.weakest && (
          <span className="text-amber-500/80"> Held back most by {flip.weakest}.</span>
        )}
      </p>
    </>
  );

  return (
    <Tip title="Flip rank" content={panel} width={300}>
      <div>
        <div className={`text-[15px] font-semibold tabular-nums ${rankTone(flip.score)}`}>
          {flip.score.toFixed(0)}
        </div>
        <div className="text-[10px] text-gray-500 tabular-nums">
          {flip.gpPerHour > 0 ? `${formatGp(Math.round(flip.gpPerHour))}/hr` : "no income"}
        </div>
        {flip.weakest && (
          <div className="text-[9px] text-amber-500/70 leading-tight">held back by {flip.weakest}</div>
        )}
      </div>
    </Tip>
  );
}

function iconUrl(icon: string): string {
  if (!icon) return "";
  return `https://oldschool.runescape.wiki/images/${encodeURIComponent(icon.replace(/ /g, "_"))}`;
}

function SortIcon({ active, dir }: { active: boolean; dir: 1 | -1 }) {
  if (!active) return <span className="inline-block w-3 text-gray-700">↕</span>;
  return <span className="inline-block w-3 text-violet-400">{dir === 1 ? "↑" : "↓"}</span>;
}

function FilterIcon({ active }: { active: boolean }) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      className={`w-3 h-3 ${active ? "text-violet-400" : "text-gray-600"}`}
      aria-hidden="true"
    >
      <path d="M2 3h12l-4.5 5.5V13l-3 1.5V8.5L2 3z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
    </svg>
  );
}

interface FilterDraft {
  key: SortKey;
  op: FilterOp;
  value: string;
  value2: string;
}

function FilterPopover({
  draft,
  onChange,
  onApply,
  onClear,
  onClose,
}: {
  draft: FilterDraft;
  onChange: (next: FilterDraft) => void;
  onApply: () => void;
  onClear: () => void;
  onClose: () => void;
}) {
  return (
    <>
      <div className="fixed inset-0 z-40" onClick={onClose} />
      <div
        className="absolute right-0 top-full mt-1 z-50 w-64 rounded-lg popover p-3 text-left normal-case font-normal"
        onClick={(e) => e.stopPropagation()}
      >
        <select
          value={draft.op}
          onChange={(e) => onChange({ ...draft, op: (e.target as HTMLSelectElement).value as FilterOp })}
          className="w-full bg-white/5 border border-white/10 rounded-md px-2 py-1.5 text-xs text-gray-200 mb-2"
        >
          {(Object.keys(OP_LABELS) as FilterOp[]).map((op) => (
            <option key={op} value={op}>
              {OP_LABELS[op]}
            </option>
          ))}
        </select>
        <div className="flex items-center gap-1.5 mb-2">
          <input
            type="text"
            inputMode="decimal"
            placeholder={PERCENT_KEYS[draft.key] ? "e.g. 5 for 5%" : "Value"}
            value={draft.value}
            onInput={(e) => onChange({ ...draft, value: (e.target as HTMLInputElement).value })}
            className="w-full bg-white/5 border border-white/10 rounded-md px-2 py-1.5 text-xs text-gray-200"
          />
          {draft.op === "between" && (
            <>
              <span className="text-gray-600 text-xs">–</span>
              <input
                type="text"
                inputMode="decimal"
                placeholder="Value"
                value={draft.value2}
                onInput={(e) => onChange({ ...draft, value2: (e.target as HTMLInputElement).value })}
                className="w-full bg-white/5 border border-white/10 rounded-md px-2 py-1.5 text-xs text-gray-200"
              />
            </>
          )}
        </div>
        <div className="flex items-center justify-between">
          <button onClick={onClear} className="text-xs text-gray-500 hover:text-gray-300">
            Clear
          </button>
          <Button size="sm" onClick={onApply}>
            Apply
          </Button>
        </div>
      </div>
    </>
  );
}

export function MarketTable({
  items,
  watched,
  setWatched,
  blocked,
  setBlocked,
  onSelectItem,
  hasActiveFilters,
  onClearFilters,
}: {
  items: MarketItem[];
  watched: Record<number, WatchEntry>;
  setWatched: (next: Record<number, WatchEntry>) => void;
  blocked: Record<number, BlockEntry>;
  setBlocked: (next: Record<number, BlockEntry>) => void;
  onSelectItem: (item: MarketItem) => void;
  hasActiveFilters?: boolean;
  onClearFilters?: () => void;
}) {
  // Margin x volume, which is what both reference tools default to and the closest thing to a
  // single honest answer to "where should I look first". Score used to be the default and was a
  // near-duplicate of the margin column beside it.
  const [sortKey, setSortKey] = useState<SortKey>("rank");
  const [sortDir, setSortDir] = useState<1 | -1>(-1);
  const [columnFilters, setColumnFilters] = useState<Partial<Record<SortKey, ColumnFilter>>>({});
  const [openFilterKey, setOpenFilterKey] = useState<SortKey | null>(null);
  const [draft, setDraft] = useState<FilterDraft | null>(null);

  const activeFilterCount = Object.keys(columnFilters).length;

  const filtered = useMemo(() => {
    if (activeFilterCount === 0) return items;
    return items.filter((item) =>
      (Object.entries(columnFilters) as [SortKey, ColumnFilter][]).every(([key, f]) =>
        matchesFilter(columnValue(item, key), f),
      ),
    );
  }, [items, columnFilters, activeFilterCount]);

  const sorted = useMemo(() => {
    const copy = [...filtered];
    if (sortKey === "name") {
      copy.sort((a, b) => a.name.localeCompare(b.name) * sortDir);
      return copy;
    }
    // Two of the sort keys are derived rather than fields, so they cannot be read off the item.
    // -Infinity for a missing value parks it at the bottom of a descending sort, which is right
    // for money and wrong for age: an item that has never traded is the stalest thing there is,
    // so it sorts as infinitely old rather than as the freshest row on the page.
    const valueOf = (item: MarketItem): number => {
      if (sortKey === "potential_profit") return potentialProfit(item) ?? -Infinity;
      if (sortKey === "price_age") return priceAge(item) ?? Infinity;
      if (sortKey === "rank") return item.flip?.score ?? -Infinity;
      if (sortKey === "gp_per_hour") return item.flip?.gpPerHour ?? -Infinity;
      return item[sortKey] ?? -Infinity;
    };
    copy.sort((a, b) => (valueOf(a) - valueOf(b)) * sortDir);
    return copy;
  }, [filtered, sortKey, sortDir]);

  function openFilter(key: SortKey) {
    const existing = columnFilters[key];
    setDraft({
      key,
      op: existing?.op ?? "gte",
      value: existing?.value != null ? String(existing.value) : "",
      value2: existing?.value2 != null ? String(existing.value2) : "",
    });
    setOpenFilterKey(key);
  }

  function applyFilter() {
    if (!draft) return;
    const value = Number(draft.value);
    if (draft.value === "" || Number.isNaN(value)) {
      setOpenFilterKey(null);
      return;
    }
    const value2 = draft.op === "between" ? Number(draft.value2) : undefined;
    setColumnFilters((prev) => ({
      ...prev,
      [draft.key]: { op: draft.op, value, value2: Number.isNaN(value2 as number) ? undefined : value2 },
    }));
    setOpenFilterKey(null);
  }

  function clearFilter(key: SortKey) {
    setColumnFilters((prev) => {
      const next = { ...prev };
      delete next[key];
      return next;
    });
    setOpenFilterKey(null);
  }

  function toggleSort(key: SortKey) {
    if (key === sortKey) {
      setSortDir((d) => (d === 1 ? -1 : 1));
    } else {
      setSortKey(key);
      setSortDir(ASC_FIRST[key] ? 1 : -1);
    }
  }

  const sortLabel = sortKey === "name" ? "Item" : (columns.find((c) => c.key === sortKey)?.label ?? "Updated");
  const sortDirLabel =
    sortKey === "name"
      ? sortDir === 1
        ? "A → Z"
        : "Z → A"
      : sortKey === "price_age"
        ? sortDir === 1
          ? "freshest → stalest"
          : "stalest → freshest"
        : sortDir === 1
          ? "low → high"
          : "high → low";

  if (items.length === 0) {
    return (
      <div className="glass rounded-xl">
        <EmptyState
          icon="🔍"
          title="No items match these filters"
          hint="Try widening the price range, lowering min liquidity, or clearing filters."
        />
        {hasActiveFilters && onClearFilters && (
          <div className="flex justify-center pb-6">
            <Button variant="secondary" size="sm" onClick={onClearFilters}>
              Clear filters
            </Button>
          </div>
        )}
      </div>
    );
  }

  if (sorted.length === 0) {
    return (
      <div className="glass rounded-xl">
        <EmptyState
          icon="🔍"
          title="No items match these column filters"
          hint="Try loosening or clearing the column filter rules below the header."
        />
        <div className="flex justify-center pb-6">
          <Button variant="secondary" size="sm" onClick={() => setColumnFilters({})}>
            Clear column filters
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="glass rounded-xl overflow-hidden">
      <div className="flex items-center justify-between px-4 py-2 text-xs text-gray-500 border-b border-white/5">
        <span>
          Sorted by <span className="text-gray-300 font-medium">{sortLabel}</span> ({sortDirLabel})
          {activeFilterCount > 0 && (
            <>
              {" · "}
              <span className="text-violet-400 font-medium">
                {activeFilterCount} column {activeFilterCount === 1 ? "filter" : "filters"}
              </span>
              {" "}
              <button
                onClick={() => setColumnFilters({})}
                className="text-gray-500 hover:text-gray-300 underline underline-offset-2"
              >
                clear
              </button>
            </>
          )}
        </span>
        <span className="text-gray-600">Click a header to sort · use ▽ to filter</span>
      </div>
      <div className="overflow-auto max-h-[70vh] 2xl:max-h-[78vh]">
        <table className="w-full text-sm 2xl:text-base text-left border-collapse">
          <thead className="sticky top-0 bg-[#0f1015]/95 backdrop-blur z-10">
            <tr className="border-b border-white/10 text-gray-400">
              <th className="px-3 py-2.5 font-medium w-8"></th>
              <th className="px-3 py-2.5 font-medium w-8"></th>
              <th
                className="px-3 py-2.5 font-medium cursor-pointer select-none hover:text-white transition-colors"
                onClick={() => toggleSort("name")}
              >
                <span className="inline-flex items-center gap-1">
                  Item <SortIcon active={sortKey === "name"} dir={sortDir} />
                </span>
              </th>
              {columns.map((c) => (
                <th
                  key={c.key}
                  className={`relative px-3 py-2.5 font-medium select-none hover:text-white transition-colors ${
                    c.align === "right" ? "text-right" : ""
                  }`}
                >
                  <span className="inline-flex items-center gap-1.5">
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        openFilterKey === c.key ? setOpenFilterKey(null) : openFilter(c.key);
                      }}
                      title={`Filter ${c.label}`}
                      className="p-0.5 hover:bg-white/10 rounded"
                    >
                      <FilterIcon active={!!columnFilters[c.key]} />
                    </button>
                    {c.title ? (
                      <Tip
                        title={c.label}
                        width={290}
                        content={
                          <p className="text-[11.5px] leading-relaxed text-gray-300">{c.title}</p>
                        }
                      >
                        <span className="cursor-pointer" onClick={() => toggleSort(c.key)}>
                          {c.label} <SortIcon active={sortKey === c.key} dir={sortDir} />
                        </span>
                      </Tip>
                    ) : (
                      <span className="cursor-pointer" onClick={() => toggleSort(c.key)}>
                        {c.label} <SortIcon active={sortKey === c.key} dir={sortDir} />
                      </span>
                    )}
                    {c.explain && <InfoTip id={c.explain} />}
                  </span>
                  {openFilterKey === c.key && draft && (
                    <FilterPopover
                      draft={draft}
                      onChange={setDraft}
                      onApply={applyFilter}
                      onClear={() => clearFilter(c.key)}
                      onClose={() => setOpenFilterKey(null)}
                    />
                  )}
                </th>
              ))}
              <th
                className="px-3 py-2.5 font-medium select-none"
                title="Price over the last day, from this install's own history. Shape only: the numbers are in the columns to the left."
              >
                Trend
              </th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((item, idx) => {
              const positive = (item.net_margin ?? 0) >= 0;
              const isWatched = !!watched[item.id];
              const isBlocked = !!blocked[item.id];
              const potProfit = potentialProfit(item);
              const mxv = item.margin_x_volume;
              return (
                <tr
                  key={item.id}
                  className={`border-b border-white/5 hover:bg-white/[0.06] price-flash transition-colors ${
                    idx % 2 === 1 ? "bg-white/[0.015]" : ""
                  }`}
                >
                  <td className="px-3 py-2">
                    <button
                      onClick={() => setWatched(toggleWatch(watched, item.id))}
                      className={`text-base leading-none transition-colors ${
                        isWatched ? "text-amber-400" : "text-gray-600 hover:text-gray-300"
                      }`}
                      title={isWatched ? "Remove from watchlist" : "Add to watchlist"}
                    >
                      ★
                    </button>
                  </td>
                  <td className="px-3 py-2">
                    <button
                      onClick={() => {
                        setBlocked(toggleBlock(blocked, item));
                        showToast(
                          isBlocked
                            ? `${item.name} unblocked`
                            : `${item.name} blocked, won't appear in Active flipping`,
                          isBlocked ? "neutral" : "danger",
                        );
                      }}
                      className={`inline-flex items-center justify-center w-5 h-5 transition-colors ${
                        isBlocked ? "text-rose-400" : "text-gray-600 hover:text-gray-300"
                      }`}
                      title={isBlocked ? "Remove from blocklist" : "Never recommend this item"}
                    >
                      <BlockIcon className="w-4 h-4" />
                    </button>
                  </td>
                  {/* The volatility marker sits OUTSIDE the name button: an interactive
                      tooltip trigger nested inside a <button> is invalid markup, and clicking
                      it would open the item modal instead of explaining the badge. */}
                  <td className="px-3 py-2">
                    <div className="flex items-center gap-1">
                      <button
                        onClick={() => onSelectItem(item)}
                        className="flex items-center gap-2 whitespace-nowrap text-gray-100 hover:text-white group text-left"
                      >
                        {item.icon && (
                          <img
                            src={iconUrl(item.icon)}
                            alt=""
                            className="w-5 h-5 object-contain shrink-0"
                          />
                        )}
                        <span className="group-hover:underline">{item.name}</span>
                        {item.members === 1 && <Badge tone="info">P2P</Badge>}
                        {item.volatility_pct != null && (
                          <Badge tone={volatilityTone(item.volatility_pct)}>
                            {(item.volatility_pct * 100).toFixed(0)}% vol
                          </Badge>
                        )}
                      </button>
                      {item.volatility_pct != null && <InfoTip id="volatility" />}
                    </div>
                  </td>
                  <td className="px-3 py-2 font-mono text-right">
                    <RankCell item={item} />
                  </td>
                  <td className="px-3 py-2 font-mono text-rose-300 text-right">
                    {formatGp(item.low)}
                  </td>
                  <td className="px-3 py-2 font-mono text-emerald-300 text-right">
                    {formatGp(item.high)}
                  </td>
                  <td className="px-3 py-2 font-mono text-right">
                    <div className={positive ? "text-emerald-400" : "text-rose-400"}>
                      {formatGp(item.net_margin)}
                    </div>
                    <div
                      className={`text-[10px] ${(item.roi_pct ?? 0) >= 0 ? "text-emerald-400/60" : "text-rose-400/60"}`}
                    >
                      {formatPct(item.roi_pct)}
                    </div>
                  </td>
                  <td className="px-3 py-2 font-mono text-right">
                    <div className="text-gray-300">
                      {item.daily_volume != null ? compactCount(item.daily_volume) : "-"}
                    </div>
                    <div
                      className="text-[10px] text-gray-600"
                      title="Fillable per hour: the thinner side of the last hour of trade, so a burst of buying does not overstate how easily you get out."
                    >
                      {Math.round(item.liquidity).toLocaleString()}/hr
                    </div>
                  </td>
                  <td
                    className={`px-3 py-2 font-mono text-right ${
                      mxv == null ? "text-gray-600" : mxv > 0 ? "text-sky-300" : "text-rose-400"
                    }`}
                  >
                    {mxv != null ? formatGp(mxv) : "-"}
                  </td>
                  <td className="px-3 py-2 font-mono text-right">
                    <div
                      className={
                        potProfit == null
                          ? "text-gray-600"
                          : potProfit > 0
                            ? "text-emerald-400"
                            : "text-rose-400"
                      }
                    >
                      {potProfit != null && potProfit > 0 ? formatGp(potProfit) : "-"}
                    </div>
                    <div className="text-[10px] text-gray-600">
                      {item.buy_limit != null ? `${item.buy_limit.toLocaleString()} limit` : "no limit"}
                    </div>
                  </td>
                  <td className="px-3 py-2 font-mono text-right whitespace-nowrap">
                    <AgeCell item={item} />
                  </td>
                  <td className="px-3 py-2">
                    <Sparkline points={item.spark} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
