import { useEffect, useState } from "preact/hooks";
import { fetchPickPerformance, type PickGroupStats, type PickPerformance } from "../api";
import { formatGp, formatPct } from "../format";

// Did the app's picks make you money?
//
// TrackRecord directly above grades the app's calls against where the market went. That is the
// app marking its own homework: a call can be "right" about the price and still lose you money
// once you pay the spread, wait for fills and pay the tax. This panel grades the calls against
// your actual trades instead, and puts the ones you took on the app's advice next to the ones you
// took on your own.
//
// The comparison is the point. A return figure on followed trades means little alone, because
// there is nothing to measure it against. Your own independent trades are the natural baseline:
// same account, same period, same you.

// Below this many distinct items the followed side is a handful of positions, and one good or bad
// trade can swing the whole comparison. The figures are still shown, with a warning, because a
// thin sample honestly labelled is more useful than a blank panel.
const THIN_SAMPLE_ITEMS = 20;

// Returns closer than this are called level. Both groups are averages over dozens of trades with
// wide spreads between them, and treating a few hundredths of a percent as a win for either side
// would be reading a verdict into noise.
const LEVEL_BAND = 0.001; // 0.1 percentage points

function verdict(followed: PickGroupStats, independent: PickGroupStats): string {
  if (followed.roi == null || independent.roi == null) {
    return "Not enough closed trades on both sides yet to compare.";
  }
  const diff = followed.roi - independent.roi;
  if (Math.abs(diff) < LEVEL_BAND) {
    return "Trades that followed a pick returned about the same per gp as your own.";
  }
  return diff > 0
    ? "Trades that followed a pick returned more per gp than your own."
    : "Your own trades returned more per gp than the ones that followed a pick.";
}

function roiTone(roi: number | null): string {
  if (roi == null) return "text-gray-400";
  return roi >= 0 ? "text-emerald-400" : "text-rose-400";
}

/** One side of the headline comparison. */
function Side({ label, g }: { label: string; g: PickGroupStats }) {
  return (
    <div className="flex-1 min-w-[10rem]">
      <div className="text-[10px] uppercase tracking-wider text-gray-500">{label}</div>
      <div className={`font-mono text-2xl tabular-nums ${roiTone(g.roi)}`}>{formatPct(g.roi)}</div>
      <div className="text-[11px] text-gray-500">
        {formatGp(g.profit)} on {formatGp(g.cost)} across {g.items} item{g.items === 1 ? "" : "s"}
      </div>
      {g.capitalWinRate != null && (
        <div
          className="text-[11px] text-gray-600"
          title="Share of the capital that ended up in profitable trades. Weighted by gp rather than counted, because the GE splits one offer into many partial fills and a count would mostly measure how the order happened to be split."
        >
          {formatPct(g.capitalWinRate)} of capital came back in profit
        </div>
      )}
    </div>
  );
}

function StrategyRow({ label, g }: { label: string; g: PickGroupStats }) {
  if (g.lots === 0) return null;
  return (
    <div className="flex items-center gap-3 text-[11px]">
      <span className="text-gray-400 w-24">{label}</span>
      <span className={`font-mono w-16 ${roiTone(g.roi)}`}>{formatPct(g.roi)}</span>
      <span className="text-gray-500">
        {formatGp(g.profit)} on {formatGp(g.cost)}, {g.items} item{g.items === 1 ? "" : "s"}
      </span>
    </div>
  );
}

export function PickPerformancePanel() {
  const [data, setData] = useState<PickPerformance | null>(null);
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetchPickPerformance()
      .then((d) => !cancelled && setData(d))
      .catch(() => !cancelled && setFailed(true));
    return () => {
      cancelled = true;
    };
  }, []);

  // Additive, like the rest of this tab: a failure here must not take the signals view with it.
  if (failed || !data) return null;

  const { followed, independent, execution } = data;
  // Nothing to say until at least one trade on each side has closed.
  if (followed.lots === 0 && independent.lots === 0) return null;

  const thin = followed.items < THIN_SAMPLE_ITEMS;
  const capture =
    execution.predictedRoi != null && execution.realizedRoi != null && execution.predictedRoi > 0
      ? execution.realizedRoi / execution.predictedRoi
      : null;

  return (
    <div className="panel rounded-xl p-4 mt-4">
      <div className="flex items-center gap-2 mb-3 flex-wrap">
        <h3 className="text-sm font-medium text-gray-200">Did the picks make you money?</h3>
        <span className="text-[10px] text-gray-600">your real trades, closed round trips only</span>
      </div>

      <div className="flex gap-6 flex-wrap">
        <Side label="Followed a pick" g={followed} />
        <Side label="On your own" g={independent} />
      </div>

      <p className="text-xs text-gray-300 mt-3">{verdict(followed, independent)}</p>

      {/* Said on the face of the panel rather than tucked into a tooltip, because it is the
          single easiest thing to get wrong when reading the numbers above. */}
      <p className="text-[11px] text-gray-500 mt-1 max-w-2xl">
        You chose which picks to act on, so this shows how the picks you took performed, not whether
        the app caused the result.
        {thin && (
          <span className="text-amber-400/80">
            {" "}
            Only {followed.items} item{followed.items === 1 ? "" : "s"} followed so far, so read
            this as a lean rather than a verdict.
          </span>
        )}
      </p>

      <button
        onClick={() => setOpen((v) => !v)}
        className="text-[11px] text-violet-400 hover:text-violet-300 mt-3"
      >
        {open ? "Hide the breakdown" : "Show the breakdown"}
      </button>

      {open && (
        <div className="mt-3 pt-3 border-t border-white/[0.06] flex flex-col gap-4">
          {/* How much of the promised edge reached your bank. The most actionable number here: a
              good pick badly executed and a bad pick look identical in the headline. */}
          {execution.lots > 0 && (
            <div>
              <div className="text-[10px] uppercase tracking-wider text-gray-500 mb-1">
                What the picks promised, and what you got
              </div>
              <div className="text-xs text-gray-300">
                The app predicted{" "}
                <span className="font-mono">{formatPct(execution.predictedRoi)}</span> on the picks
                you took. You realised{" "}
                <span className={`font-mono ${roiTone(execution.realizedRoi)}`}>
                  {formatPct(execution.realizedRoi)}
                </span>
                {capture != null && capture > 0 && <>, about {Math.round(capture * 100)}% of it</>}
                {capture != null && capture <= 0 && <>, none of it</>}.
              </div>
              {execution.excludedGlitches > 0 && (
                <div className="text-[10px] text-gray-600 mt-0.5">
                  {execution.excludedGlitches} pick
                  {execution.excludedGlitches === 1 ? "" : "s"} left out of the prediction for
                  claiming an impossible return.
                </div>
              )}
            </div>
          )}

          <div>
            <div className="text-[10px] uppercase tracking-wider text-gray-500 mb-1">
              By the kind of pick you followed
            </div>
            <div className="flex flex-col gap-0.5">
              <StrategyRow label="Active flipping" g={data.byStrategy.signals} />
              <StrategyRow label="Overnight" g={data.byStrategy.overnight} />
            </div>
          </div>

          {data.followedItems.length > 0 && (
            <div>
              <div className="text-[10px] uppercase tracking-wider text-gray-500 mb-1">
                The picks you followed, largest first
              </div>
              <div className="overflow-x-auto">
                <table className="text-[11px] w-full max-w-xl">
                  <tbody>
                    {data.followedItems.map((i) => (
                      <tr key={i.itemId} className="border-b border-white/[0.04] last:border-0">
                        <td className="py-1 pr-3 text-gray-300">{i.name}</td>
                        <td className="py-1 pr-3 font-mono text-gray-500 text-right">
                          {formatGp(i.cost)}
                        </td>
                        <td className={`py-1 pr-3 font-mono text-right ${roiTone(i.profit)}`}>
                          {formatGp(i.profit)}
                        </td>
                        <td className={`py-1 font-mono text-right ${roiTone(i.roi)}`}>
                          {formatPct(i.roi)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* What is NOT in the numbers, stated plainly. Open positions have no result yet, and
              sales with no recorded buy have no known cost; counting the latter as free profit is
              how the ledger's own flip totals come out orders of magnitude too high. */}
          <p className="text-[10px] text-gray-600 max-w-2xl">
            Only closed round trips are compared. {formatGp(data.excluded.openCost)} is still held
            and has no result yet.{" "}
            {data.excluded.unmatchedSellUnits > 0 && (
              <>
                {data.excluded.unmatchedSellUnits.toLocaleString()} units were sold with no recorded
                buy, from before capture started, and are left out rather than counted as free
                profit.
              </>
            )}
          </p>
        </div>
      )}
    </div>
  );
}
