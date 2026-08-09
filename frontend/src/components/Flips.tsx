import { useEffect, useMemo, useState } from "preact/hooks";
import {
  fetchFlips,
  fetchFlipsForItem,
  fetchMissedFlips,
  fetchTransactions,
  fetchTimeseries,
  type Flip,
  type GeTransaction,
  type MarketItem,
  type TimeseriesPoint,
} from "../api";
import { formatGp, formatGpFull, formatPct } from "../format";
import { PriceChart, type ChartTrade } from "./PriceChart";
import { Chip, EmptyState } from "./ui";

function iconUrl(icon: string | null | undefined): string {
  if (!icon) return "";
  return `https://oldschool.runescape.wiki/images/${encodeURIComponent(icon.replace(/ /g, "_"))}`;
}

function fmtTime(unix: number | null): string {
  if (!unix) return "—";
  return new Date(unix * 1000).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function Money({ value, invert = false }: { value: number; invert?: boolean }) {
  const positive = invert ? value < 0 : value > 0;
  const negative = invert ? value > 0 : value < 0;
  return (
    <span
      className={`font-mono ${positive ? "text-emerald-400" : negative ? "text-rose-400" : "text-gray-400"}`}
    >
      {formatGp(value)}
    </span>
  );
}

function StatusBadge({ status }: { status: Flip["status"] }) {
  const tone =
    status === "FINISHED"
      ? "bg-gray-500/15 text-gray-400 border-gray-500/30"
      : status === "SELLING"
        ? "bg-emerald-500/15 text-emerald-400 border-emerald-500/30"
        : "bg-sky-500/15 text-sky-400 border-sky-500/30";
  return (
    <span className={`text-[10px] font-semibold uppercase px-1.5 py-0.5 rounded border ${tone}`}>
      {status}
    </span>
  );
}

// DESIGN.md §14.40: the "what have I actually been doing" views, all reading the same ledger:
// completed flips, the raw transaction stream, one flip drawn on its price chart, and the flips
// the ledger can't fully account for. Grouped under one tab as sub-views rather than four
// top-level tabs -- the nav already carries seven.
type SubView = "flips" | "transactions" | "visualize" | "missed";

export function Flips({
  items,
  onSelectItem,
}: {
  items: MarketItem[];
  onSelectItem: (item: MarketItem) => void;
}) {
  const [view, setView] = useState<SubView>("flips");
  const [flips, setFlips] = useState<Flip[]>([]);
  const [captureStartedAt, setCaptureStartedAt] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedItemId, setSelectedItemId] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchFlips()
      .then((r) => {
        if (cancelled) return;
        setFlips(r.flips);
        setCaptureStartedAt(r.captureStartedAt);
      })
      .catch((e) => !cancelled && setError(e instanceof Error ? e.message : "failed"))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, []);

  function visualize(itemId: number) {
    setSelectedItemId(itemId);
    setView("visualize");
  }

  return (
    <div>
      <div className="flex items-center gap-2 mb-4 flex-wrap">
        <Chip active={view === "flips"} onClick={() => setView("flips")}>
          Flips
        </Chip>
        <Chip active={view === "transactions"} onClick={() => setView("transactions")}>
          Transactions
        </Chip>
        <Chip active={view === "visualize"} onClick={() => setView("visualize")}>
          Visualize flip
        </Chip>
        <Chip active={view === "missed"} onClick={() => setView("missed")}>
          Missed flips
        </Chip>
        {captureStartedAt && (
          <span className="ml-auto text-[11px] text-gray-500">
            Live capture since {new Date(captureStartedAt * 1000).toLocaleString()}
          </span>
        )}
      </div>

      {error && <div className="glass rounded-xl p-4 mb-4 text-sm text-rose-400">{error}</div>}

      {view === "flips" && (
        <FlipsTable flips={flips} loading={loading} onVisualize={visualize} />
      )}
      {view === "transactions" && <TransactionsTable />}
      {view === "visualize" && (
        <VisualizeFlip
          itemId={selectedItemId}
          flips={flips}
          items={items}
          onPickItem={setSelectedItemId}
          onSelectItem={onSelectItem}
        />
      )}
      {view === "missed" && <MissedFlips onVisualize={visualize} />}
    </div>
  );
}

function FlipsTable({
  flips,
  loading,
  onVisualize,
}: {
  flips: Flip[];
  loading: boolean;
  onVisualize: (itemId: number) => void;
}) {
  if (loading) return <div className="glass rounded-xl p-6 text-center text-sm text-gray-500">Loading flips…</div>;
  if (!flips.length) {
    return (
      <EmptyState
        title="No flips recorded yet"
        hint="Flips appear as the ledger records buys and sells from your GE slots."
      />
    );
  }
  return (
    <div className="glass rounded-xl p-4 overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-[11px] uppercase tracking-wide text-gray-500 text-left">
            <th className="pb-2 pr-3 font-medium">First buy</th>
            <th className="pb-2 pr-3 font-medium">Last sell</th>
            <th className="pb-2 pr-3 font-medium">Item</th>
            <th className="pb-2 pr-3 font-medium">Status</th>
            <th className="pb-2 pr-3 font-medium text-right">Bought</th>
            <th className="pb-2 pr-3 font-medium text-right">Sold</th>
            <th className="pb-2 pr-3 font-medium text-right">Avg buy</th>
            <th className="pb-2 pr-3 font-medium text-right">Avg sell</th>
            <th className="pb-2 pr-3 font-medium text-right">Tax</th>
            <th className="pb-2 pr-3 font-medium text-right">Profit</th>
            <th className="pb-2 font-medium text-right">ROI</th>
          </tr>
        </thead>
        <tbody>
          {flips.map((f, i) => (
            <tr
              key={`${f.itemId}-${i}`}
              onClick={() => onVisualize(f.itemId)}
              className="border-t border-white/5 hover:bg-white/5 cursor-pointer"
            >
              <td className="py-2 pr-3 text-gray-500 text-xs whitespace-nowrap">{fmtTime(f.firstBuyTime)}</td>
              <td className="py-2 pr-3 text-gray-500 text-xs whitespace-nowrap">{fmtTime(f.lastSellTime)}</td>
              <td className="py-2 pr-3">
                <div className="flex items-center gap-2">
                  {f.icon && <img src={iconUrl(f.icon)} alt="" className="w-4 h-4 object-contain" />}
                  <span className="text-gray-200 whitespace-nowrap">{f.name}</span>
                </div>
              </td>
              <td className="py-2 pr-3">
                <StatusBadge status={f.status} />
              </td>
              <td className="py-2 pr-3 text-right font-mono text-gray-400">{f.bought.toLocaleString()}</td>
              <td className="py-2 pr-3 text-right font-mono text-gray-400">{f.sold.toLocaleString()}</td>
              <td className="py-2 pr-3 text-right font-mono text-gray-300">
                {f.avgBuyPrice ? formatGpFull(f.avgBuyPrice) : "—"}
              </td>
              <td className="py-2 pr-3 text-right font-mono text-gray-300">
                {f.avgSellPrice ? formatGpFull(f.avgSellPrice) : "—"}
              </td>
              <td className="py-2 pr-3 text-right font-mono text-gray-500">{formatGp(f.tax)}</td>
              <td className="py-2 pr-3 text-right">
                {/* Cost basis of 0 means the buy predates capture: profit here is meaningless,
                    not spectacular. Shown as "n/a" rather than a huge green number. */}
                {f.sold > f.bought ? (
                  <span className="text-amber-400/70 text-xs">n/a</span>
                ) : (
                  <Money value={f.profit} />
                )}
              </td>
              <td className="py-2 text-right font-mono text-gray-400">
                {f.sold > f.bought || f.roiPct == null ? "—" : formatPct(f.roiPct)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function TransactionsTable() {
  const [txs, setTxs] = useState<GeTransaction[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    fetchTransactions()
      .then((r) => !cancelled && setTxs(r.transactions))
      .catch(() => {})
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, []);

  if (loading) return <div className="glass rounded-xl p-6 text-center text-sm text-gray-500">Loading…</div>;
  if (!txs.length) return <EmptyState title="No transactions yet" />;

  return (
    <div className="glass rounded-xl p-4 overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-[11px] uppercase tracking-wide text-gray-500 text-left">
            <th className="pb-2 pr-3 font-medium">Time</th>
            <th className="pb-2 pr-3 font-medium">Type</th>
            <th className="pb-2 pr-3 font-medium">Item</th>
            <th className="pb-2 pr-3 font-medium text-right">Quantity</th>
            <th className="pb-2 pr-3 font-medium text-right">Price</th>
            <th className="pb-2 pr-3 font-medium text-right">Value</th>
            <th className="pb-2 pr-3 font-medium text-right">Slot</th>
            <th className="pb-2 font-medium">Source</th>
          </tr>
        </thead>
        <tbody>
          {txs.map((t) => (
            <tr key={t.id} className="border-t border-white/5">
              <td className="py-2 pr-3 text-gray-500 text-xs whitespace-nowrap">{fmtTime(t.occurred_at)}</td>
              <td className="py-2 pr-3">
                <span
                  className={`text-[10px] font-semibold uppercase px-1.5 py-0.5 rounded border ${
                    t.type === "buy"
                      ? "bg-rose-500/15 text-rose-400 border-rose-500/30"
                      : "bg-emerald-500/15 text-emerald-400 border-emerald-500/30"
                  }`}
                >
                  {t.type}
                </span>
              </td>
              <td className="py-2 pr-3">
                <div className="flex items-center gap-2">
                  {t.icon && <img src={iconUrl(t.icon)} alt="" className="w-4 h-4 object-contain" />}
                  <span className="text-gray-200">{t.name ?? `Item ${t.item_id}`}</span>
                </div>
              </td>
              <td className="py-2 pr-3 text-right font-mono text-gray-300">{t.quantity.toLocaleString()}</td>
              <td className="py-2 pr-3 text-right font-mono text-gray-400">{formatGpFull(t.price)}</td>
              <td className="py-2 pr-3 text-right font-mono text-gray-300">{formatGp(t.spent)}</td>
              <td className="py-2 pr-3 text-right font-mono text-gray-600">{t.slot ?? "—"}</td>
              <td className="py-2 text-[11px] text-gray-600">{t.source}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function VisualizeFlip({
  itemId,
  flips,
  items,
  onPickItem,
  onSelectItem,
}: {
  itemId: number | null;
  flips: Flip[];
  items: MarketItem[];
  onPickItem: (id: number) => void;
  onSelectItem: (item: MarketItem) => void;
}) {
  const [detail, setDetail] = useState<Flip[]>([]);
  const [series, setSeries] = useState<TimeseriesPoint[]>([]);
  const [loading, setLoading] = useState(false);

  // Items that actually have a flip, so the picker can't select something with nothing to draw.
  const options = useMemo(() => {
    const seen = new Map<number, { id: number; name: string; icon: string | null }>();
    for (const f of flips) if (!seen.has(f.itemId)) seen.set(f.itemId, { id: f.itemId, name: f.name, icon: f.icon });
    return [...seen.values()];
  }, [flips]);

  useEffect(() => {
    if (itemId == null) return;
    let cancelled = false;
    setLoading(true);
    // 24h matches the granularity a flip actually plays out over -- a longer lookback compresses
    // the fills into a few pixels and the B/S lines lose all meaning against the price series.
    Promise.all([fetchFlipsForItem(itemId), fetchTimeseries(itemId, "24h")])
      .then(([f, ts]) => {
        if (cancelled) return;
        setDetail(f.flips);
        setSeries(ts.points ?? []);
      })
      .catch(() => {})
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [itemId]);

  if (itemId == null) {
    return (
      <div className="glass rounded-xl p-4">
        <p className="text-sm text-gray-400 mb-3">Pick a flip to draw on its price chart.</p>
        <div className="flex flex-wrap gap-2">
          {options.map((o) => (
            <button
              key={o.id}
              onClick={() => onPickItem(o.id)}
              className="flex items-center gap-2 px-2.5 py-1.5 rounded-lg bg-white/5 hover:bg-white/10 text-sm text-gray-200"
            >
              {o.icon && <img src={iconUrl(o.icon)} alt="" className="w-4 h-4 object-contain" />}
              {o.name}
            </button>
          ))}
          {!options.length && <span className="text-xs text-gray-500">No flips to visualize yet.</span>}
        </div>
      </div>
    );
  }

  const flip = detail[0];
  const trades: ChartTrade[] = detail
    .flatMap((f) => f.transactions ?? [])
    .map((t) => ({ ts: t.occurred_at, price: t.price, type: t.type, quantity: t.quantity }));

  return (
    <div className="grid grid-cols-1 xl:grid-cols-4 gap-4">
      <div className="xl:col-span-3 glass rounded-xl p-4">
        {loading ? (
          <div className="py-16 text-center text-sm text-gray-500">Loading chart…</div>
        ) : (
          <>
            <div className="flex items-center gap-3 mb-2 text-xs text-gray-500">
              <span className="flex items-center gap-1.5">
                <span className="w-2.5 h-2.5 rounded-full bg-sky-400" /> Your buys
              </span>
              <span className="flex items-center gap-1.5">
                <span className="w-2.5 h-2.5 rounded-full bg-orange-400" /> Your sells
              </span>
              <button onClick={() => onPickItem(null as unknown as number)} className="ml-auto text-sky-400 hover:text-sky-300">
                ← pick another
              </button>
            </div>
            <PriceChart points={series} trades={trades} />
          </>
        )}
      </div>

      <div className="glass rounded-xl p-4">
        {flip ? (
          <>
            <div className="flex items-center gap-2 mb-3">
              {flip.icon && <img src={iconUrl(flip.icon)} alt="" className="w-5 h-5 object-contain" />}
              <h3 className="text-sm font-medium text-gray-200">{flip.name}</h3>
            </div>
            <div className="space-y-1.5 text-sm">
              <DetailRow label="First buy time" value={fmtTime(flip.firstBuyTime)} />
              <DetailRow label="Last sell time" value={fmtTime(flip.lastSellTime)} />
              <DetailRow label="Status" value={flip.status} />
              <DetailRow label="Bought" value={flip.bought.toLocaleString()} />
              <DetailRow label="Sold" value={flip.sold.toLocaleString()} />
              <DetailRow label="Avg. buy price" value={flip.avgBuyPrice ? formatGpFull(flip.avgBuyPrice) : "—"} />
              <DetailRow label="Avg. sell price" value={flip.avgSellPrice ? formatGpFull(flip.avgSellPrice) : "—"} />
              <DetailRow label="Tax" value={formatGp(flip.tax)} />
              <DetailRow
                label="Profit"
                value={flip.sold > flip.bought ? "n/a" : formatGp(flip.profit)}
                tone={flip.sold > flip.bought ? undefined : flip.profit >= 0 ? "good" : "bad"}
              />
              <DetailRow label="Profit ea." value={flip.sold > flip.bought ? "n/a" : formatGp(flip.profitEach)} />
              <DetailRow
                label="ROI"
                value={flip.sold > flip.bought || flip.roiPct == null ? "—" : formatPct(flip.roiPct)}
              />
            </div>
            {detail.length > 1 && (
              <p className="mt-3 pt-3 border-t border-white/10 text-[11px] text-gray-500">
                Showing the most recent of {detail.length} flips for this item; all of them are
                drawn on the chart.
              </p>
            )}
            <button
              onClick={() => {
                const match = items.find((i) => i.id === flip.itemId);
                if (match) onSelectItem(match);
              }}
              className="mt-3 text-xs text-sky-400 hover:text-sky-300"
            >
              Open item details →
            </button>
          </>
        ) : (
          <p className="text-xs text-gray-500">No flip data.</p>
        )}
      </div>
    </div>
  );
}

function DetailRow({ label, value, tone }: { label: string; value: string; tone?: "good" | "bad" }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="text-gray-500 text-xs">{label}</span>
      <span
        className={`font-mono text-sm ${
          tone === "good" ? "text-emerald-400" : tone === "bad" ? "text-rose-400" : "text-gray-200"
        }`}
      >
        {value}
      </span>
    </div>
  );
}

function MissedFlips({ onVisualize }: { onVisualize: (itemId: number) => void }) {
  const [data, setData] = useState<{ unmatchedSells: Flip[]; stalled: Flip[]; captureStartedAt: number | null } | null>(
    null,
  );
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    fetchMissedFlips()
      .then((r) => !cancelled && setData(r))
      .catch(() => {})
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, []);

  if (loading) return <div className="glass rounded-xl p-6 text-center text-sm text-gray-500">Loading…</div>;
  if (!data) return <EmptyState title="Couldn't load missed flips" />;

  return (
    <div className="space-y-4">
      <div className="glass rounded-xl p-4">
        <h3 className="text-sm font-medium text-gray-200 mb-1">Sold more than we saw bought</h3>
        <p className="text-xs text-gray-500 mb-3 leading-relaxed">
          These sold units the ledger has no purchase record for, so their cost basis is unknown and
          profit can't be calculated. Normal for anything you were already holding when tracking
          started
          {data.captureStartedAt
            ? ` (${new Date(data.captureStartedAt * 1000).toLocaleString()})`
            : ""}
          . They're excluded from all profit figures rather than counted as pure gain.
        </p>
        <MissedTable flips={data.unmatchedSells} onVisualize={onVisualize} empty="Nothing unmatched." />
      </div>

      <div className="glass rounded-xl p-4">
        <h3 className="text-sm font-medium text-gray-200 mb-1">Stalled over 24h</h3>
        <p className="text-xs text-gray-500 mb-3">
          Open more than a day — either still filling, or worth a look at your price.
        </p>
        <MissedTable flips={data.stalled} onVisualize={onVisualize} empty="Nothing stalled." />
      </div>
    </div>
  );
}

function MissedTable({
  flips,
  onVisualize,
  empty,
}: {
  flips: Flip[];
  onVisualize: (itemId: number) => void;
  empty: string;
}) {
  if (!flips.length) return <p className="text-xs text-gray-600 py-2">{empty}</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-[11px] uppercase tracking-wide text-gray-500 text-left">
            <th className="pb-2 pr-3 font-medium">First buy</th>
            <th className="pb-2 pr-3 font-medium">Item</th>
            <th className="pb-2 pr-3 font-medium">Status</th>
            <th className="pb-2 pr-3 font-medium text-right">Bought</th>
            <th className="pb-2 pr-3 font-medium text-right">Sold</th>
            <th className="pb-2 font-medium text-right">Avg sell</th>
          </tr>
        </thead>
        <tbody>
          {flips.map((f, i) => (
            <tr
              key={`${f.itemId}-${i}`}
              onClick={() => onVisualize(f.itemId)}
              className="border-t border-white/5 hover:bg-white/5 cursor-pointer"
            >
              <td className="py-2 pr-3 text-gray-500 text-xs whitespace-nowrap">{fmtTime(f.firstBuyTime)}</td>
              <td className="py-2 pr-3">
                <div className="flex items-center gap-2">
                  {f.icon && <img src={iconUrl(f.icon)} alt="" className="w-4 h-4 object-contain" />}
                  <span className="text-gray-200">{f.name}</span>
                </div>
              </td>
              <td className="py-2 pr-3">
                <StatusBadge status={f.status} />
              </td>
              <td className="py-2 pr-3 text-right font-mono text-gray-400">{f.bought.toLocaleString()}</td>
              <td className="py-2 pr-3 text-right font-mono text-gray-400">{f.sold.toLocaleString()}</td>
              <td className="py-2 text-right font-mono text-gray-300">
                {f.avgSellPrice ? formatGpFull(f.avgSellPrice) : "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
