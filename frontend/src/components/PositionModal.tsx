import { useEffect, useState } from "preact/hooks";
import {
  fetchSlotProfile,
  fetchTimeseries,
  fetchForecast,
  type ForecastPoint,
  type Lookback,
  type MarketItem,
  type SlotProfileResponse,
  type TimeseriesPoint,
} from "../api";
import { formatGp, formatGpFull, formatPct } from "../format";
import { geTax, priceAtFill } from "../fillPricing";
import { formatWait, msUntilSlot, slotToLocalLabel } from "../timeSlots";
import { STATUS_STYLE, type OvernightPlan, type SlotView } from "../geSlots";
import { SlotShapeChart } from "./SlotShapeChart";
import { PriceChart } from "./PriceChart";
import { Button } from "./ui";

const REAL_CHART_LOOKBACKS: { key: Lookback; label: string }[] = [
  { key: "24h", label: "1d" },
  { key: "7d", label: "7d" },
  { key: "30d", label: "30d" },
];

// The detail view for a POSITION, as distinct from the item.
//
// Clicking a slot used to open the generic item modal, which answers "what is this item" -- a
// perfectly good question, and not the one you have while looking at your own offer. That question
// is: will this fill, what happens if it does, what is it costing me to wait, and what should I do
// about it. All of those are properties of the offer, not of the item, and none of them appeared
// anywhere in the item view.
//
// The item view is still one click away, because "what is this thing" is the follow-up.

function Figure({
  label,
  value,
  sub,
  tone = "text-gray-100",
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: string;
}) {
  return (
    <div className="px-3 py-2 min-w-0">
      <div className="text-[10px] uppercase tracking-wider text-gray-500 truncate">{label}</div>
      <div className={`font-mono text-lg font-semibold tabular-nums leading-tight truncate ${tone}`}>
        {value}
      </div>
      {sub && <div className="text-[10px] text-gray-600 truncate">{sub}</div>}
    </div>
  );
}

function iconUrl(icon: string | null | undefined): string {
  if (!icon) return "";
  return `https://oldschool.runescape.wiki/images/${encodeURIComponent(icon.replace(/ /g, "_"))}`;
}

export function PositionModal({
  view,
  liveSlot,
  plan,
  market,
  fillTarget,
  onClose,
  onOpenItem,
}: {
  view: SlotView;
  liveSlot: number;
  plan?: OvernightPlan;
  market?: MarketItem;
  fillTarget: number;
  onClose: () => void;
  onOpenItem?: () => void;
}) {
  const slot = view.slot;
  const itemId = slot?.itemId ?? view.suggestion?.item.id ?? null;
  const buySlot = plan?.buySlot ?? liveSlot;
  const sellSlot = plan?.sellSlot ?? liveSlot;

  const [data, setData] = useState<SlotProfileResponse | null>(null);
  useEffect(() => {
    if (itemId == null) return;
    let cancelled = false;
    setData(null);
    fetchSlotProfile(itemId, buySlot, sellSlot)
      .then((d) => !cancelled && setData(d))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [itemId, buySlot, sellSlot]);

  // Direct request: "I would like to have a real chart of the item as well to compare." The
  // panel above (SlotShapeChart) is a MODEL, medians across several days, not any single day's
  // real prints. This is the actual observed price series, the same PriceChart used in the item
  // detail modal, so the two can be compared side by side rather than only trusting the model.
  const [realLookback, setRealLookback] = useState<Lookback>("7d");
  const [realPoints, setRealPoints] = useState<TimeseriesPoint[]>([]);
  useEffect(() => {
    if (itemId == null) return;
    let cancelled = false;
    setRealPoints([]);
    fetchTimeseries(itemId, realLookback)
      .then((res) => !cancelled && setRealPoints(res.points))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [itemId, realLookback]);

  // Direct request: "on the chart below I want the prediction bands." Same IQR forecast
  // (forecast.ts) already shown in the item detail modal, appended to the real series -- not
  // tied to realLookback since a forecast always projects ~24h forward from now, independent of
  // which historical window is currently selected.
  const [forecast, setForecast] = useState<ForecastPoint[]>([]);
  useEffect(() => {
    if (itemId == null) return;
    let cancelled = false;
    fetchForecast(itemId)
      .then((res) => !cancelled && setForecast(res.points))
      .catch(() => !cancelled && setForecast([]));
    return () => {
      cancelled = true;
    };
  }, [itemId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const style = STATUS_STYLE[view.status];
  const price = view.price ?? 0;
  const qty = slot?.totalQuantity ?? view.suggestion?.qty ?? 0;
  const filled = slot?.quantitySold ?? 0;
  const pct = qty > 0 ? (filled / qty) * 100 : 0;
  const committed = price * qty;

  // Odds this exact price fills, at this time of day, from the stored daily readings.
  const legDays = slot?.type === "sell" ? (data?.sellDays ?? []) : (data?.buyDays ?? []);
  const fillRate = legDays.length
    ? (slot?.type === "sell"
        ? legDays.filter((v) => v >= price).length
        : legDays.filter((v) => v <= price).length) / legDays.length
    : null;

  const pricing = data ? priceAtFill(data.paired, fillTarget) : null;

  // What this position clears if it fills and you sell at the planned ask. Uses the plan when
  // there is one; otherwise the fill-target ask off the same sample.
  const askRef = plan?.sellPrice ?? pricing?.ask ?? null;
  const perUnit =
    slot?.type === "buy" && askRef != null ? askRef - geTax(Math.round(askRef)) - price : null;

  return (
    <div
      className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-start justify-center p-4 overflow-y-auto"
      onClick={onClose}
    >
      <div
        className="panel rounded-2xl w-full max-w-3xl my-8 p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3 mb-4">
          <div className="flex items-center gap-2.5 min-w-0">
            {(slot?.icon || view.suggestion?.item.icon) && (
              <img
                src={iconUrl(slot?.icon ?? view.suggestion?.item.icon)}
                alt=""
                className="w-7 h-7 object-contain shrink-0"
              />
            )}
            <div className="min-w-0">
              <div className="text-lg font-semibold text-gray-100 truncate">{view.headline}</div>
              <div className="text-[11px] text-gray-500">
                Slot {view.index} · {slot ? slot.type : "suggested buy"}
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <span
              className={`px-2 py-0.5 rounded border text-[10px] font-semibold uppercase tracking-wider ${style.pill}`}
            >
              {style.label}
            </span>
            <button onClick={onClose} className="text-gray-500 hover:text-white text-lg leading-none">
              ✕
            </button>
          </div>
        </div>

        {/* What you did, and how far it has got. */}
        <div className="panel-inset rounded-xl grid grid-cols-2 sm:grid-cols-4 divide-x divide-white/[0.06] mb-3">
          <Figure
            label={slot?.type === "sell" ? "Your ask" : "Your bid"}
            value={formatGpFull(price)}
            sub={`${qty.toLocaleString()} units`}
          />
          <Figure
            label="Filled"
            value={`${filled.toLocaleString()}/${qty.toLocaleString()}`}
            sub={`${pct.toFixed(0)}%`}
            tone={pct >= 100 ? "text-emerald-400" : pct > 0 ? "text-amber-300" : "text-gray-400"}
          />
          <Figure label="Committed" value={formatGp(committed)} sub="at your price" />
          <Figure
            label="Fills"
            value={fillRate == null ? "—" : `${Math.round(fillRate * 100)}%`}
            sub={`of ${legDays.length} days at this hour`}
            tone={
              fillRate == null
                ? "text-gray-500"
                : fillRate >= 0.7
                  ? "text-emerald-400"
                  : fillRate >= 0.4
                    ? "text-amber-400"
                    : "text-rose-400"
            }
          />
        </div>

        <div className="h-1.5 bg-white/[0.07] rounded-full overflow-hidden mb-3">
          <div
            className={`h-full ${slot?.type === "sell" ? "bg-emerald-400/70" : "bg-rose-400/70"}`}
            style={{ width: `${Math.min(100, pct)}%` }}
          />
        </div>

        {/* The verdict, in the same words the tile uses -- they must not be able to disagree. */}
        <p className={`text-sm leading-snug mb-1 ${style.tone}`}>{view.detail}</p>
        {view.suggestedPrice != null && (
          <p className="font-mono text-base font-semibold text-amber-200 tabular-nums mb-3">
            → {formatGpFull(view.suggestedPrice)}
          </p>
        )}

        {/* The plan, when there is one. */}
        {plan?.sellSlot != null && (
          <div className="panel-inset rounded-xl grid grid-cols-2 sm:grid-cols-4 divide-x divide-white/[0.06] my-3">
            <Figure
              label="Sell at"
              value={slotToLocalLabel(plan.sellSlot)}
              sub={`in ${formatWait(msUntilSlot(plan.sellSlot))}`}
              tone="text-sky-300"
            />
            <Figure
              label="Planned ask"
              value={plan.sellPrice != null ? formatGpFull(plan.sellPrice) : "—"}
            />
            <Figure
              label="Clears / unit"
              value={perUnit != null ? `${perUnit >= 0 ? "+" : ""}${formatGp(perUnit)}` : "—"}
              sub="after tax"
              tone={(perUnit ?? 0) >= 0 ? "text-emerald-400" : "text-rose-400"}
            />
            <Figure
              label="If it all fills"
              value={perUnit != null ? `${perUnit >= 0 ? "+" : ""}${formatGp(perUnit * qty)}` : "—"}
              sub={`${qty.toLocaleString()} units`}
              tone={(perUnit ?? 0) >= 0 ? "text-emerald-400" : "text-rose-400"}
            />
          </div>
        )}

        {/* The shape, at a readable size rather than a 54px sparkline. Labeled "model" and drawn
            with dashed lines, same convention PriceChart already uses for its own IQR forecast
            band, since this is a median across several days, not any single day's real prints. */}
        {data ? (
          <div className="panel-inset rounded-xl p-3 mb-3">
            <div className="flex items-center justify-between gap-2 mb-1">
              <div className="text-[10px] uppercase tracking-wider text-gray-500">
                Typical day · your price ruled
              </div>
              <span
                className="text-[9px] uppercase tracking-wider text-sky-400/80"
                title="Median buy/sell per half-hour slot across the stored sample, not a live price"
              >
                Model, median of {data.pairedDays || data.spanDays || "the"} days
              </span>
            </div>
            <div className="[&_svg]:!h-[150px]">
              <SlotShapeChart
                data={data}
                buySlot={buySlot}
                sellSlot={sellSlot}
                floor={slot?.type === "sell" ? (pricing?.bid ?? null) : price}
                ceiling={slot?.type === "sell" ? price : (plan?.sellPrice ?? pricing?.ask ?? null)}
              />
            </div>
          </div>
        ) : (
          <div className="h-[180px] rounded-xl bg-white/[0.03] animate-pulse mb-3" />
        )}

        {/* The real chart, so the model above can be checked against actual prints instead of
            just trusted. Same PriceChart used everywhere else in the app, not a second
            implementation. */}
        {itemId != null && (
          <div className="panel-inset rounded-xl p-3 mb-3">
            <div className="flex items-center justify-between gap-2 mb-2 flex-wrap">
              <div className="text-[10px] uppercase tracking-wider text-gray-500">
                Real price history
              </div>
              <div className="flex items-center gap-1">
                <span
                  className="text-[9px] uppercase tracking-wider text-emerald-400/80 mr-1"
                  title="Actual observed prices, not a model"
                >
                  Real, not a model
                </span>
                {REAL_CHART_LOOKBACKS.map((lb) => (
                  <button
                    key={lb.key}
                    onClick={() => setRealLookback(lb.key)}
                    className={`px-2 py-0.5 rounded-md text-[10px] transition-colors ${
                      realLookback === lb.key
                        ? "bg-white/10 text-white"
                        : "text-gray-500 hover:text-gray-300"
                    }`}
                  >
                    {lb.label}
                  </button>
                ))}
              </div>
            </div>
            {realPoints.length > 0 ? (
              <PriceChart points={realPoints} forecast={forecast} />
            ) : (
              <div className="h-[180px] rounded-xl bg-white/[0.03] animate-pulse" />
            )}
          </div>
        )}

        {/* Live market context -- the thing your price is being judged against. */}
        {market && (
          <div className="panel-inset rounded-xl grid grid-cols-2 sm:grid-cols-4 divide-x divide-white/[0.06] mb-3">
            <Figure label="Market buy" value={formatGp(market.low)} tone="text-rose-300" />
            <Figure label="Market sell" value={formatGp(market.high)} tone="text-emerald-300" />
            <Figure
              label="Margin now"
              value={formatGp(market.net_margin)}
              tone={(market.net_margin ?? 0) >= 0 ? "text-emerald-400" : "text-rose-400"}
            />
            <Figure label="ROI now" value={formatPct(market.roi_pct)} />
          </div>
        )}

        {onOpenItem && (
          <div className="flex justify-end">
            <Button onClick={onOpenItem}>Full item details →</Button>
          </div>
        )}
      </div>
    </div>
  );
}
