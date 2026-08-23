import { useEffect, useState } from "preact/hooks";
import type { ComponentChildren } from "preact";
import {
  fetchPortfolio,
  fetchItemOfTheHour,
  fetchTrackRecord,
  type MarketItem,
  type PortfolioResponse,
  type HourlyPick,
  type TrackRecordSummary,
  type PriceAlert,
} from "../api";
import { formatGp, formatGpFull } from "../format";
import { buildSlotViews, countNeedsAction } from "../geSlots";
import { loadFills } from "../fills";
import { type WatchEntry } from "../watchlist";
import { useCurrentSlot } from "../useCurrentSlot";

// Direct request: "Is there a possibility of making like a side bar with all the important data
// and stats, things to take a look at" -- followed immediately by "I want it to be hidden, I only
// want to see it when I click expand somewhere." So this is a slide-in drawer, not a permanent
// column: a slim pull-tab sits fixed to the right edge of the viewport on every tab (app chrome,
// rendered from App.tsx, present on every tab including Overnight) and clicking it slides the
// full panel in over the page. Always starts closed -- no persisted "stay open" state, since the
// whole point is that it's out of the way until asked for. Every section self-fetches on the same
// cadence the page that owns the full version already uses (Portfolio: 20s, Track Record: 60s)
// rather than lifting state into App.tsx -- same self-contained-per-component pattern the rest of
// this app already follows (see TrackRecord.tsx's own realizationRatio fetch).

function iconUrl(icon: string | null): string {
  if (!icon) return "";
  return `https://oldschool.runescape.wiki/images/${encodeURIComponent(icon.replace(/ /g, "_"))}`;
}

function Row({
  label,
  value,
  tone,
  onClick,
}: {
  label: string;
  value: string;
  tone?: "success" | "danger" | "warning";
  onClick?: () => void;
}) {
  const toneClass =
    tone === "success"
      ? "text-emerald-400"
      : tone === "danger"
        ? "text-rose-400"
        : tone === "warning"
          ? "text-amber-400"
          : "text-gray-200";
  const Tag = onClick ? "button" : "div";
  return (
    <Tag
      onClick={onClick}
      className={`flex items-center justify-between w-full text-left ${onClick ? "hover:text-white cursor-pointer" : ""}`}
    >
      <span className="text-xs text-gray-500">{label}</span>
      <span className={`text-xs font-mono ${toneClass}`}>{value}</span>
    </Tag>
  );
}

function Section({ title, children }: { title: string; children: ComponentChildren }) {
  return (
    <div className="py-3 border-b border-white/10 last:border-b-0 space-y-1.5">
      <div className="text-[10px] uppercase tracking-wider text-gray-500 font-medium mb-1.5">
        {title}
      </div>
      {children}
    </div>
  );
}

export function Sidebar({
  items,
  onSelectItem,
  alerts,
  watched,
}: {
  items: MarketItem[];
  onSelectItem: (item: MarketItem) => void;
  alerts: PriceAlert[];
  watched: Record<number, WatchEntry>;
}) {
  const [open, setOpen] = useState(false);

  // Esc closes it -- standard drawer/overlay behavior, and the only keyboard affordance a modal
  // like this needs.
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  const [portfolio, setPortfolio] = useState<PortfolioResponse | null>(null);
  useEffect(() => {
    let cancelled = false;
    function load() {
      fetchPortfolio()
        .then((p) => !cancelled && setPortfolio(p))
        .catch(() => {});
    }
    load();
    const id = setInterval(load, 20_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  const liveSlot = useCurrentSlot();
  const bankroll = Number(localStorage.getItem("bankroll")) || 10_000_000;
  const [topPick, setTopPick] = useState<HourlyPick | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetchItemOfTheHour(liveSlot, bankroll)
      .then((d) => !cancelled && setTopPick(d.picks[0] ?? null))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [liveSlot, bankroll]);

  const [trackSummary, setTrackSummary] = useState<TrackRecordSummary | null>(null);
  useEffect(() => {
    let cancelled = false;
    function load() {
      fetchTrackRecord()
        .then((res) => !cancelled && setTrackSummary(res.summary))
        .catch(() => {});
    }
    load();
    const id = setInterval(load, 60_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  // Fills are local-only (fills.ts) so a plain poll is enough to notice a change made elsewhere
  // in the same tab (e.g. GeOffersPanel's "mark filled" action) -- no event bus exists for this.
  const [fillsTick, setFillsTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setFillsTick((t) => t + 1), 5_000);
    return () => clearInterval(id);
  }, []);
  const fills = loadFills();
  const todayStart = new Date().setHours(0, 0, 0, 0) / 1000;
  const fillsToday = fills.filter((f) => f.filledAt >= todayStart);
  const fillsTodayValue = fillsToday.reduce((sum, f) => sum + f.price * f.qty, 0);
  const lastFill = fills[0];
  void fillsTick;

  const slotViews = buildSlotViews(portfolio?.slots ?? [], [], items);
  const needsAction = countNeedsAction(slotViews);
  const slotsUsed = portfolio?.totals.slotsUsed ?? portfolio?.slots.length ?? 0;

  const watchTriggerCount = Object.values(watched).filter((w) => {
    if (w.alertAbove == null && w.alertBelow == null) return false;
    const item = items.find((i) => i.id === w.itemId);
    if (!item) return false;
    if (w.alertAbove != null && (item.high ?? 0) >= w.alertAbove) return true;
    if (w.alertBelow != null && (item.low ?? Infinity) <= w.alertBelow) return true;
    return false;
  }).length;
  const totalAlerts = alerts.length + watchTriggerCount;

  function openTopPick() {
    if (!topPick) return;
    const match = items.find((i) => i.id === topPick.itemId);
    if (match) onSelectItem(match);
  }

  return (
    <>
      {/* Pull-tab: fixed to the right edge on every tab, always visible. Doubles as a status
          light -- amber when something on the GE board needs action, rose when there's an active
          alert, so there's a reason to notice it even before you've clicked it once. */}
      <button
        onClick={() => setOpen(true)}
        title="Show at-a-glance stats"
        className={`fixed right-0 top-1/2 -translate-y-1/2 z-30 flex flex-col items-center gap-1.5 py-3 px-1.5 rounded-l-xl border border-r-0 backdrop-blur-md transition-all ${
          open ? "translate-x-full opacity-0 pointer-events-none" : "translate-x-0 opacity-100"
        } ${
          totalAlerts > 0
            ? "bg-rose-500/15 border-rose-500/30"
            : needsAction > 0
              ? "bg-amber-500/15 border-amber-500/30"
              : "bg-white/[0.06] border-white/10 hover:bg-white/10"
        }`}
      >
        <span className="text-gray-400 text-xs" style={{ writingMode: "vertical-rl" }}>
          At a glance
        </span>
        {(needsAction > 0 || totalAlerts > 0) && (
          <span
            className={`w-5 h-5 flex items-center justify-center rounded-full text-[10px] font-semibold ${
              totalAlerts > 0 ? "bg-rose-500/25 text-rose-300" : "bg-amber-500/25 text-amber-300"
            }`}
          >
            {totalAlerts > 0 ? totalAlerts : needsAction}
          </span>
        )}
      </button>

      {/* Backdrop -- click to close, same as any overlay in this app (item detail modal, settings
          modal). Fades in/out with the panel rather than popping. */}
      <div
        onClick={() => setOpen(false)}
        className={`fixed inset-0 z-30 bg-black/40 backdrop-blur-[1px] transition-opacity duration-300 ${
          open ? "opacity-100" : "opacity-0 pointer-events-none"
        }`}
      />

      <aside
        className={`fixed right-0 top-0 z-40 h-full w-80 max-w-[85vw] transition-transform duration-300 ease-out ${
          open ? "translate-x-0" : "translate-x-full"
        }`}
      >
        <div className="h-full bg-[#111319]/95 backdrop-blur-xl border-l border-white/10 shadow-2xl shadow-black/50 p-4 overflow-y-auto">
          <div className="flex items-center justify-between mb-1">
            <span className="text-sm font-semibold text-gray-100">At a glance</span>
            <button
              onClick={() => setOpen(false)}
              title="Close"
              className="w-7 h-7 flex items-center justify-center rounded-lg text-gray-500 hover:text-white hover:bg-white/5"
            >
              ✕
            </button>
          </div>

          <Section title="Grand Exchange">
          <Row
            label="Slots in use"
            value={`${slotsUsed}/8`}
            tone={slotsUsed >= 8 ? "warning" : undefined}
          />
          <Row
            label="Needs action"
            value={String(needsAction)}
            tone={needsAction > 0 ? "warning" : undefined}
          />
          {(portfolio?.totals.cashInBuyOffers ?? 0) > 0 && (
            <Row label="Committed gp" value={formatGp(portfolio!.totals.cashInBuyOffers)} />
          )}
        </Section>

        <Section title="Top pick right now">
          {topPick ? (
            <button
              onClick={openTopPick}
              className="block w-full text-left rounded-lg hover:bg-white/5 -mx-1 px-1 py-0.5"
            >
              <div className="flex items-center gap-1.5">
                {topPick.icon && (
                  <img src={iconUrl(topPick.icon)} alt="" className="w-4 h-4 object-contain shrink-0" />
                )}
                <span className="text-xs text-gray-100 font-medium truncate">{topPick.name}</span>
              </div>
              <div className="flex items-center justify-between mt-1">
                <span className="text-[11px] text-gray-500">
                  Buy {topPick.buyPrice != null ? formatGpFull(topPick.buyPrice) : "-"}
                </span>
                <span className="text-[11px] font-mono text-emerald-400">
                  {topPick.timingEdgePct != null ? `${(topPick.timingEdgePct * 100).toFixed(1)}%` : "-"}
                </span>
              </div>
            </button>
          ) : (
            <div className="text-xs text-gray-600">No timing edge this slot</div>
          )}
        </Section>

        <Section title="Recently filled">
          <Row label="Today" value={`${fillsToday.length} · ${formatGp(fillsTodayValue)}`} />
          {lastFill ? (
            <div className="text-[11px] text-gray-500 truncate">
              last: <span className={lastFill.type === "buy" ? "text-rose-400" : "text-emerald-400"}>{lastFill.type}</span>{" "}
              {lastFill.itemName}
            </div>
          ) : (
            <div className="text-[11px] text-gray-600">Nothing filled yet</div>
          )}
        </Section>

        <Section title="Track record">
          <Row
            label="Win rate"
            value={trackSummary?.winRate != null ? `${(trackSummary.winRate * 100).toFixed(0)}%` : "-"}
          />
          <Row
            label="Realization"
            value={
              trackSummary?.realizationRatio != null
                ? `${(trackSummary.realizationRatio * 100).toFixed(0)}%`
                : `${trackSummary?.resolvedCount ?? 0}/20`
            }
          />
        </Section>

          <Section title="Alerts">
            <Row
              label="Active"
              value={String(totalAlerts)}
              tone={totalAlerts > 0 ? "danger" : undefined}
            />
          </Section>
        </div>
      </aside>
    </>
  );
}
