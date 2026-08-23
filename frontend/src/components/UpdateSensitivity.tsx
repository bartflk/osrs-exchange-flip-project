import { useEffect, useMemo, useState } from "preact/hooks";
import { fetchNews, fetchUpdateSensitivity, type NewsEvent, type UpdateSensitivityResult } from "../api";
import { formatGpFull, formatPct } from "../format";
import { EmptyState } from "./ui";

// DESIGN.md §10 item 45: "rank items by how much a given patch moved their price, before/after."
// No attempt to classify which official events are real gameplay updates vs. podcasts/charity
// streams -- every official event is selectable, and a non-gameplay event just shows near-zero
// movement across the board, an honest (if unexciting) result rather than a filtered-away one.

function iconUrl(icon: string): string {
  if (!icon) return "";
  return `https://oldschool.runescape.wiki/images/${encodeURIComponent(icon.replace(/ /g, "_"))}`;
}

function Row({ e }: { e: UpdateSensitivityResult["gainers"][number] }) {
  return (
    <tr className="border-t border-white/5">
      <td className="py-1.5 pr-3">
        <div className="flex items-center gap-2">
          {e.icon && <img src={iconUrl(e.icon)} alt="" className="w-4 h-4 object-contain" />}
          <span className="text-gray-200 whitespace-nowrap">{e.name}</span>
        </div>
      </td>
      <td className="py-1.5 pr-3 text-right font-mono text-gray-400">{formatGpFull(e.beforePrice)}</td>
      <td className="py-1.5 pr-3 text-right font-mono text-gray-300">{formatGpFull(e.afterPrice)}</td>
      <td
        className={`py-1.5 text-right font-mono ${e.changePct >= 0 ? "text-emerald-400" : "text-rose-400"}`}
      >
        {formatPct(e.changePct)}
      </td>
    </tr>
  );
}

export function UpdateSensitivity() {
  const [officialEvents, setOfficialEvents] = useState<NewsEvent[]>([]);
  const [eventDate, setEventDate] = useState<string | null>(null);
  const [windowDays, setWindowDays] = useState(3);
  const [data, setData] = useState<UpdateSensitivityResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState(true);

  useEffect(() => {
    fetchNews()
      .then((res) => {
        const official = res.events.filter((e) => e.source === "official");
        setOfficialEvents(official);
        if (!eventDate && official.length > 0) setEventDate(official[0].eventDate);
      })
      .catch(() => {});
    // eslint-disable-next-line
  }, []);

  useEffect(() => {
    if (!eventDate) return;
    let cancelled = false;
    setError(null);
    setData(null);
    fetchUpdateSensitivity(eventDate, windowDays)
      .then((d) => !cancelled && setData(d))
      .catch((e) => !cancelled && setError(e instanceof Error ? e.message : "failed"));
    return () => {
      cancelled = true;
    };
  }, [eventDate, windowDays]);

  const selectedEvent = useMemo(
    () => officialEvents.find((e) => e.eventDate === eventDate),
    [officialEvents, eventDate],
  );

  return (
    <div className="glass rounded-xl p-4 mb-4">
      <div className="flex items-center justify-between gap-2 mb-3 flex-wrap">
        <h3 className="text-sm font-medium text-gray-200">
          Update sensitivity
          <span className="ml-2 text-xs text-gray-500 font-normal">
            how much a patch actually moved prices, before vs. after
          </span>
        </h3>
        <div className="flex items-center gap-2">
          <select
            value={eventDate ?? ""}
            onChange={(e) => setEventDate((e.target as HTMLSelectElement).value)}
            className="bg-white/5 border border-white/10 rounded-lg px-2 py-1 text-xs text-gray-200 max-w-[16rem]"
          >
            {officialEvents.map((e) => (
              <option key={e.id} value={e.eventDate}>
                {e.eventDate}, {e.title}
              </option>
            ))}
          </select>
          <select
            value={windowDays}
            onChange={(e) => setWindowDays(Number((e.target as HTMLSelectElement).value))}
            className="bg-white/5 border border-white/10 rounded-lg px-2 py-1 text-xs text-gray-200"
            title="How many days before/after the patch date to compare"
          >
            {[1, 2, 3, 5, 7].map((d) => (
              <option key={d} value={d}>
                ±{d}d
              </option>
            ))}
          </select>
          <button
            onClick={() => setCollapsed((c) => !c)}
            className="text-xs text-gray-500 hover:text-gray-300"
          >
            {collapsed ? "show" : "hide"}
          </button>
        </div>
      </div>

      {!collapsed && (
        <>
          {error && <p className="text-xs text-rose-400">{error}</p>}
          {!error && !data && <p className="text-xs text-gray-500">Loading…</p>}

          {data && data.itemsCompared === 0 && (
            <EmptyState
              title="Not enough price history around this date"
              hint="price_daily only retains data going forward from when the app was first run, an event older than that, or too recent to have a full window after it, won't have both sides to compare yet."
            />
          )}

          {data && data.itemsCompared > 0 && (
            <>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <div className="text-[11px] uppercase tracking-wide text-gray-500 mb-1">
                    Biggest gainers
                  </div>
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-[11px] uppercase tracking-wide text-gray-500 text-left">
                        <th className="pb-1.5 pr-3 font-medium">Item</th>
                        <th className="pb-1.5 pr-3 font-medium text-right">Before</th>
                        <th className="pb-1.5 pr-3 font-medium text-right">After</th>
                        <th className="pb-1.5 font-medium text-right">Change</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.gainers.map((e) => (
                        <Row key={e.itemId} e={e} />
                      ))}
                    </tbody>
                  </table>
                </div>
                <div>
                  <div className="text-[11px] uppercase tracking-wide text-gray-500 mb-1">
                    Biggest losers
                  </div>
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-[11px] uppercase tracking-wide text-gray-500 text-left">
                        <th className="pb-1.5 pr-3 font-medium">Item</th>
                        <th className="pb-1.5 pr-3 font-medium text-right">Before</th>
                        <th className="pb-1.5 pr-3 font-medium text-right">After</th>
                        <th className="pb-1.5 font-medium text-right">Change</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.losers.map((e) => (
                        <Row key={e.itemId} e={e} />
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
              <p className="text-[10px] text-gray-600 mt-3 leading-relaxed">
                Daily close price {data.beforeDate} vs. {data.afterDate} ({data.windowDays} days each
                side of {selectedEvent?.eventDate ?? data.eventDate}), {data.itemsCompared} items
                compared (≥1,000gp, ≥20 liquidity/hr, capped at ±300% to exclude data artifacts). No
                attempt is made to judge whether this event actually caused the move, it's a real
                measured before/after, not a claimed cause.
              </p>
            </>
          )}
        </>
      )}
    </div>
  );
}
