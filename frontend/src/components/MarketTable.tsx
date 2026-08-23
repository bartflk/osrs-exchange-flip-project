import { useMemo, useState } from "preact/hooks";
import type { MarketItem } from "../api";
import { formatGp, formatPct, formatAgo } from "../format";
import { type WatchEntry, toggleWatch } from "../watchlist";
import { type BlockEntry, toggleBlock } from "../blocklist";
import { Badge, Button, EmptyState } from "./ui";
import { InfoTip } from "./InfoTip";
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
  | "score"
  | "low"
  | "high"
  | "net_margin"
  | "tax"
  | "roi_pct"
  | "liquidity"
  | "buy_limit"
  | "potential_profit"
  | "updated_at";

// Sort keys whose "natural" first click is ascending (A-Z, soonest-first) rather than the
// descending "biggest number first" every gp/pct/score column defaults to.
const ASC_FIRST: Partial<Record<SortKey, true>> = { name: true };

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

function columnValue(item: MarketItem, key: SortKey): number | null {
  if (key === "name" || key === "updated_at") return null; // not filterable, no funnel on those headers
  const raw = key === "potential_profit" ? potentialProfit(item) : item[key];
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

const columns: {
  key: SortKey;
  label: string;
  align?: "right";
  title?: string;
  explain?: ExplanationId;
}[] = [
  { key: "low", label: "Buy", align: "right", title: "Most recent price someone bought at" },
  { key: "high", label: "Sell", align: "right", title: "Most recent price someone sold at" },
  { key: "net_margin", label: "Margin", align: "right", explain: "netMargin" },
  { key: "tax", label: "Tax", align: "right", explain: "geTax" },
  { key: "roi_pct", label: "ROI", align: "right", explain: "roi" },
  { key: "liquidity", label: "Liquidity/hr", align: "right", explain: "liquidity" },
  { key: "buy_limit", label: "Limit", align: "right", title: "GE buy limit per 4-hour window" },
  { key: "potential_profit", label: "Pot. profit", align: "right", explain: "potentialProfit" },
  { key: "score", label: "Score", align: "right", explain: "score" },
];

// DESIGN.md §14.12: tiered volatility badge, coefficient of variation of the high price over a
// trailing 24h (volatility.ts). Thresholds are a starting judgment call, not derived from a
// backtest -- revisit once real usage shows whether they're well-calibrated.
function volatilityTone(pct: number): "success" | "warning" | "danger" {
  if (pct < 0.05) return "success";
  if (pct < 0.15) return "warning";
  return "danger";
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
        className="absolute right-0 top-full mt-1 z-50 w-64 rounded-lg border border-white/10 bg-[#14151c] shadow-xl p-3 text-left normal-case font-normal"
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
  const [sortKey, setSortKey] = useState<SortKey>("score");
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
    copy.sort((a, b) => {
      const av =
        sortKey === "potential_profit"
          ? (potentialProfit(a) ?? -Infinity)
          : (a[sortKey] ?? -Infinity);
      const bv =
        sortKey === "potential_profit"
          ? (potentialProfit(b) ?? -Infinity)
          : (b[sortKey] ?? -Infinity);
      return (av - bv) * sortDir;
    });
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
      : sortKey === "updated_at"
        ? sortDir === 1
          ? "oldest → newest"
          : "newest → oldest"
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
                  title={c.title}
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
                    <span className="cursor-pointer" onClick={() => toggleSort(c.key)}>
                      {c.label} <SortIcon active={sortKey === c.key} dir={sortDir} />
                    </span>
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
                className="px-3 py-2.5 font-medium cursor-pointer select-none hover:text-white transition-colors"
                onClick={() => toggleSort("updated_at")}
              >
                <span className="inline-flex items-center gap-1">
                  Updated <SortIcon active={sortKey === "updated_at"} dir={sortDir} />
                </span>
              </th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((item, idx) => {
              const positive = (item.net_margin ?? 0) >= 0;
              const isWatched = !!watched[item.id];
              const isBlocked = !!blocked[item.id];
              const potProfit = potentialProfit(item);
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
                            : `${item.name} blocked, won't appear in Buy Signals`,
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
                  <td className="px-3 py-2 font-mono text-rose-300 text-right">
                    {formatGp(item.low)}
                  </td>
                  <td className="px-3 py-2 font-mono text-emerald-300 text-right">
                    {formatGp(item.high)}
                  </td>
                  <td
                    className={`px-3 py-2 font-mono text-right ${positive ? "text-emerald-400" : "text-rose-400"}`}
                  >
                    {formatGp(item.net_margin)}
                  </td>
                  <td className="px-3 py-2 font-mono text-gray-500 text-right">
                    {item.tax ? `-${formatGp(item.tax)}` : "Free"}
                  </td>
                  <td
                    className={`px-3 py-2 font-mono text-right ${(item.roi_pct ?? 0) >= 0 ? "text-emerald-400" : "text-rose-400"}`}
                  >
                    {formatPct(item.roi_pct)}
                  </td>
                  <td className="px-3 py-2 font-mono text-gray-300 text-right">
                    {Math.round(item.liquidity).toLocaleString()}
                  </td>
                  <td className="px-3 py-2 font-mono text-gray-400 text-right">
                    {item.buy_limit != null ? item.buy_limit.toLocaleString() : "-"}
                  </td>
                  <td
                    className={`px-3 py-2 font-mono text-right ${potProfit == null ? "text-gray-600" : potProfit > 0 ? "text-emerald-400" : "text-rose-400"}`}
                  >
                    {potProfit != null && potProfit > 0 ? formatGp(potProfit) : "-"}
                  </td>
                  <td
                    className={`px-3 py-2 font-mono text-right ${positive ? "text-emerald-400" : "text-rose-400"}`}
                  >
                    {formatGp(item.score)}
                  </td>
                  <td className="px-3 py-2 text-gray-500 text-xs whitespace-nowrap">
                    {formatAgo(item.updated_at)}
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
