import { useEffect, useState } from "preact/hooks";
import { fetchSubstitutionFlags, type SubstitutionFlag, type MarketItem } from "../api";
import { formatGp } from "../format";
import { Badge } from "./ui";

// DESIGN.md §10 item 2 / §14.18: cross-item correlation / substitution flags -- raw/cooked,
// ore/bar, herb/potion pairs that normally move together. When a leader has moved but its
// follower hasn't caught up proportionally, that lag is a classic merchanting signal.
function iconUrl(icon: string): string {
  if (!icon) return "";
  return `https://oldschool.runescape.wiki/images/${encodeURIComponent(icon.replace(/ /g, "_"))}`;
}

function pct(v: number): string {
  return `${v >= 0 ? "+" : ""}${(v * 100).toFixed(1)}%`;
}

export function SubstitutionFlags({
  items,
  onSelectItem,
}: {
  items: MarketItem[];
  onSelectItem: (item: MarketItem) => void;
}) {
  const [flags, setFlags] = useState<SubstitutionFlag[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchSubstitutionFlags()
      .then((res) => !cancelled && setFlags(res.flags))
      .catch((err) => !cancelled && setError(err instanceof Error ? err.message : "Failed to load"))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, []);

  function open(itemId: number) {
    const item = items.find((i) => i.id === itemId);
    if (item) onSelectItem(item);
  }

  if (loading || error || flags.length === 0) return null; // quiet by design -- no forced empty state for a secondary signal

  return (
    <div className="glass rounded-xl p-4 mb-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-medium text-gray-200">Substitute lag flags</h3>
        <span className="text-xs text-gray-500">24h · leader moved, follower hasn't caught up</span>
      </div>
      <div className="flex flex-col gap-1.5">
        {flags.map((f) => (
          <div
            key={`${f.leader.itemId}-${f.follower.itemId}`}
            className="flex items-center justify-between gap-3 py-1.5 px-2 rounded-lg hover:bg-white/5"
          >
            <div className="flex items-center gap-4 min-w-0">
              <Badge tone="neutral">{f.category}</Badge>
              <button
                onClick={() => open(f.leader.itemId)}
                className="flex items-center gap-1.5 hover:underline"
              >
                {f.leader.icon && (
                  <img src={iconUrl(f.leader.icon)} alt="" className="w-4 h-4 object-contain" />
                )}
                <span className="text-sm text-gray-200">{f.leader.name}</span>
                <span
                  className={`text-xs font-mono ${f.leader.changePct >= 0 ? "text-emerald-400" : "text-rose-400"}`}
                >
                  {pct(f.leader.changePct)}
                </span>
              </button>
              <span className="text-gray-600">→</span>
              <button
                onClick={() => open(f.follower.itemId)}
                className="flex items-center gap-1.5 hover:underline"
              >
                {f.follower.icon && (
                  <img src={iconUrl(f.follower.icon)} alt="" className="w-4 h-4 object-contain" />
                )}
                <span className="text-sm text-gray-200">{f.follower.name}</span>
                <span
                  className={`text-xs font-mono ${f.follower.changePct >= 0 ? "text-emerald-400" : "text-rose-400"}`}
                >
                  {pct(f.follower.changePct)}
                </span>
              </button>
            </div>
            <span className="text-xs text-gray-500 font-mono shrink-0">
              {formatGp(f.follower.to)}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
