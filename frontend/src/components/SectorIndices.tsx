import { useEffect, useState } from "preact/hooks";
import { fetchSectors, type SectorIndex, type TrendWindow } from "../api";
import { Chip } from "./ui";

// DESIGN.md §10 item 20 / §14.33: curated item-group indices (raid uniques, Barrows, Herblore
// supplies, etc.) averaged into a single % change per sector, for spotting sector-wide moves
// (e.g. "raid drops are all up this week") a single-item view would miss.
const WINDOWS: { key: TrendWindow; label: string }[] = [
  { key: "1h", label: "1h" },
  { key: "4h", label: "4h" },
  { key: "12h", label: "12h" },
  { key: "24h", label: "24h" },
  { key: "7d", label: "7d" },
  { key: "30d", label: "30d" },
];

function Bar({ sector }: { sector: SectorIndex }) {
  if (sector.avgChangePct == null) {
    return (
      <div className="flex items-center justify-between gap-2 py-1.5 px-2 text-xs">
        <span className="text-gray-400">{sector.label}</span>
        <span className="text-gray-600">not enough data</span>
      </div>
    );
  }
  const pct = sector.avgChangePct * 100;
  const positive = pct >= 0;
  const widthPct = Math.min(100, Math.abs(pct) * 8); // visual scale, not to-precision
  return (
    <div className="py-1.5 px-2">
      <div className="flex items-center justify-between gap-2 text-xs mb-1">
        <span className="text-gray-200">{sector.label}</span>
        <span className={`font-mono ${positive ? "text-emerald-400" : "text-rose-400"}`}>
          {positive ? "+" : ""}
          {pct.toFixed(1)}%
        </span>
      </div>
      <div className="h-1.5 rounded-full bg-white/5 overflow-hidden">
        <div
          className={`h-full ${positive ? "bg-emerald-500/60" : "bg-rose-500/60"}`}
          style={{ width: `${widthPct}%` }}
        />
      </div>
      <div className="text-[10px] text-gray-600 mt-0.5">
        {sector.itemCount}/{sector.totalItems} items with data this window
      </div>
    </div>
  );
}

export function SectorIndices() {
  const [timeWindow, setTimeWindow] = useState<TrendWindow>("24h");
  const [sectors, setSectors] = useState<SectorIndex[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetchSectors(timeWindow)
      .then((res) => !cancelled && setSectors(res.sectors))
      .catch((err) => !cancelled && setError(err instanceof Error ? err.message : "Failed to load"))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [timeWindow]);

  return (
    <div className="glass rounded-xl p-4 mb-4">
      <div className="flex items-center justify-between mb-2 flex-wrap gap-2">
        <div>
          <h3 className="text-sm font-medium text-gray-200">Sector indices</h3>
          <p className="text-xs text-gray-500">
            Curated item baskets, averaged, small, stable-price groups so one item's move doesn't
            dominate. See DESIGN.md §10 item 20.
          </p>
        </div>
        <div className="flex items-center gap-1.5">
          {WINDOWS.map((w) => (
            <Chip key={w.key} active={timeWindow === w.key} onClick={() => setTimeWindow(w.key)}>
              {w.label}
            </Chip>
          ))}
        </div>
      </div>

      {loading && <p className="text-xs text-gray-500 py-2">Loading…</p>}
      {error && <p className="text-xs text-rose-400 py-2">{error}</p>}
      {!loading && !error && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4">
          {sectors.map((s) => (
            <Bar key={s.key} sector={s} />
          ))}
        </div>
      )}
    </div>
  );
}
