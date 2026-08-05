import { useState } from "preact/hooks";
import type { MarketItem, PriceAlert } from "../api";
import { formatGp, formatAgo } from "../format";

function iconUrl(icon: string): string {
  if (!icon) return "";
  return `https://oldschool.runescape.wiki/images/${encodeURIComponent(icon.replace(/ /g, "_"))}`;
}

// DESIGN.md §11.3 item 5: market-wide crash/spike alerts, not just Watchlist-pinned items.
// A compact ticker strip rather than a full page -- these are frequent-ish and meant to be
// glanceable, not a dedicated destination.
export function MarketAlerts({
  alerts,
  items,
  onSelectItem,
}: {
  alerts: PriceAlert[];
  items: MarketItem[];
  onSelectItem: (item: MarketItem) => void;
}) {
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState(false);

  const visible = alerts.filter((a) => !dismissed.has(a.id));
  if (visible.length === 0) return null;

  const shown = expanded ? visible : visible.slice(0, 5);

  function dismiss(id: string) {
    setDismissed((prev) => new Set(prev).add(id));
  }

  function openAlert(alert: PriceAlert) {
    const item = items.find((i) => i.id === alert.itemId);
    if (item) onSelectItem(item);
  }

  return (
    <div className="bg-white/[0.03] border-b border-white/10 px-6 2xl:px-10 py-2 flex items-center gap-2 flex-wrap">
      <span className="text-[10px] uppercase tracking-wide text-gray-500 shrink-0">
        Market alerts
      </span>
      {shown.map((a) => (
        <button
          key={a.id}
          onClick={() => openAlert(a)}
          title={
            a.kind === "volume"
              ? "Unusual volume vs. this item's own 24h baseline — possible bot activity"
              : undefined
          }
          className={`group flex items-center gap-1.5 pl-1.5 pr-1 py-0.5 rounded-full text-xs border transition-colors ${
            a.severity === "major" ? "ring-1 ring-white/30" : ""
          } ${
            a.kind === "volume"
              ? "bg-amber-500/10 border-amber-500/30 text-amber-300 hover:bg-amber-500/20"
              : a.direction === "crash"
                ? "bg-rose-500/10 border-rose-500/30 text-rose-300 hover:bg-rose-500/20"
                : "bg-emerald-500/10 border-emerald-500/30 text-emerald-300 hover:bg-emerald-500/20"
          }`}
        >
          {a.icon && <img src={iconUrl(a.icon)} alt="" className="w-3.5 h-3.5 object-contain" />}
          {a.severity === "major" && (
            <span className="text-[9px] font-bold uppercase tracking-wide text-white/80">
              Major
            </span>
          )}
          <span className="font-medium">{a.name}</span>
          {a.kind === "volume" ? (
            <span className="font-mono">
              ⚠ VOL {a.zScore != null ? `z=${a.zScore.toFixed(1)}` : ""}
            </span>
          ) : (
            <span className="font-mono">
              {a.direction === "crash" ? "▼" : "▲"} {(a.changePct * 100).toFixed(1)}%
            </span>
          )}
          <span className="text-gray-500">
            {a.kind === "volume"
              ? `${a.fromPrice.toLocaleString()}→${a.toPrice.toLocaleString()} vol/1h vs 24h avg`
              : `${formatGp(a.fromPrice)}→${formatGp(a.toPrice)} · ${a.windowMinutes}m`}{" "}
            · {formatAgo(a.triggeredAt)}
          </span>
          <span
            onClick={(e) => {
              e.stopPropagation();
              dismiss(a.id);
            }}
            className="opacity-0 group-hover:opacity-100 text-gray-500 hover:text-white ml-1"
          >
            ✕
          </span>
        </button>
      ))}
      {visible.length > shown.length && (
        <button
          onClick={() => setExpanded(true)}
          className="text-xs text-gray-500 hover:text-gray-300"
        >
          +{visible.length - shown.length} more
        </button>
      )}
      {expanded && visible.length > 5 && (
        <button
          onClick={() => setExpanded(false)}
          className="text-xs text-gray-500 hover:text-gray-300"
        >
          Show less
        </button>
      )}
    </div>
  );
}
