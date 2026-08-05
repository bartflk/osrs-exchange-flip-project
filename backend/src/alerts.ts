import { db } from "./db.js";

// DESIGN.md §11.3 item 5: widen the existing Watchlist alert mechanism to the WHOLE catalogue,
// not just pinned items -- flag any item whose price moves sharply within a short window.
// Validated by a real hobbyist's "day 1" results with basically this exact idea (a Python
// script polling for crashes) -- see DESIGN.md §14.3. Kept deliberately simple: in-memory
// rolling buffer, no ML, no new DB table (matches the app's existing "rule-based, explainable"
// philosophy already used in the Actions tab's sell suggestions).

const WINDOW_MS = 10 * 60 * 1000; // look back 10 minutes for the % change
const MIN_WINDOW_MS = 5 * 60 * 1000; // don't evaluate until the buffer actually spans this long --
// otherwise right after a server restart the "window" is only 1-2 poll cycles wide, and normal
// single-tick noise on thin items reads as a 30%+ move. Found live: without this, cold start
// fired half a dozen bogus alerts in the first two minutes of the fixed version running.
const COOLDOWN_MS = 30 * 60 * 1000; // don't re-fire the same item+direction more than once per 30min
const CRASH_PCT = -0.1; // -10% within the window
const SPIKE_PCT = 0.15; // +15% within the window
const MIN_PRICE = 1000; // skip cheap items -- a few-gp tick swings %, but means nothing
// Live testing found MIN_LIQUIDITY=5 on a one-sided (summed) volume check let thinly-traded
// cosmetics through -- e.g. "Topaz ring" reading as a -51% "crash" off a single stale tick.
// Match signals.ts's own liquidity pattern instead: require the SMALLER of buy/sell 1h volume
// to clear the bar (not the sum), same reasoning it already documents -- a one-sided burst
// shouldn't count as real liquidity. Also require the low price to corroborate the high price's
// move in the same direction, so one outlier side of the spread can't trigger alone.
const MIN_LIQUIDITY = 20; // matches the Market tab's own default min-liquidity filter
const CORROBORATION_FRACTION = 0.5; // low must move at least half as much as high, same direction
// A genuine GE move essentially never exceeds this in a 5-40 minute window (SPIKE_PCT/CRASH_PCT
// are 15%/-10%) -- anything past it is a stale/glitched tick acting as the % change denominator,
// not a real signal. Found live: "Armadyl brew(3)" and other thin items fired "spiked 1,896,767%"
// alerts because the OLDEST sample in the window happened to be a near-zero price glitch (the
// MIN_PRICE floor below only ever checked the LATEST price, not the baseline it's compared against).
const MAX_SANE_PCT = 3.0; // ±300%

interface Sample {
  ts: number;
  high: number;
  low: number;
}

const buffers = new Map<number, Sample[]>();
const lastFired = new Map<string, number>(); // key: `${itemId}:${direction}` -> ts (seconds)

export type AlertDirection = "crash" | "spike";
export type AlertKind = "price" | "volume";
// DESIGN.md §12.1 item 6 / §4.3: tiered, named severity instead of a bare percentage -- matches
// Runeberg Terminal's "High Profit" (>=380k gp est.) vs "Solid Profit" framing. "major" is a
// materially bigger move than what already cleared the base alert threshold, not just "any alert."
export type AlertSeverity = "notable" | "major";

export interface AlertEvent {
  id: string;
  itemId: number;
  name: string;
  icon: string;
  kind: AlertKind;
  direction: AlertDirection;
  severity: AlertSeverity;
  changePct: number;
  fromPrice: number;
  toPrice: number;
  windowMinutes: number;
  triggeredAt: number;
  // volume-kind only: how many standard deviations above the item's own trailing baseline
  zScore?: number;
}

// A price move is "major" if either the absolute gp swing or the % move is well past the base
// threshold -- either signal alone is enough (a huge % move on a cheap item, or a huge gp move on
// an expensive item with a modest %, both deserve the louder label).
const MAJOR_GP_MOVE = 500_000;
const MAJOR_PCT_MOVE = 0.25;
function priceSeverity(changePct: number, fromPrice: number, toPrice: number): AlertSeverity {
  const gpMove = Math.abs(toPrice - fromPrice);
  return gpMove >= MAJOR_GP_MOVE || Math.abs(changePct) >= MAJOR_PCT_MOVE ? "major" : "notable";
}
const MAJOR_Z_SCORE = 5;
function volumeSeverity(zScore: number): AlertSeverity {
  return zScore >= MAJOR_Z_SCORE ? "major" : "notable";
}

const MAX_ALERTS = 100;
const recentAlerts: AlertEvent[] = [];

const nameLookupStmt = db.prepare(`SELECT name, icon FROM items WHERE id = ?`);

export function recordSampleAndCheck(
  itemId: number,
  tsSeconds: number,
  high: number | null,
  low: number | null,
  volHigh1h: number,
  volLow1h: number,
): AlertEvent | null {
  const minVol = Math.min(volHigh1h, volLow1h);
  if (high == null || low == null || high < MIN_PRICE || minVol < MIN_LIQUIDITY) return null;

  const tsMs = tsSeconds * 1000;
  let buf = buffers.get(itemId);
  if (!buf) {
    buf = [];
    buffers.set(itemId, buf);
  }
  buf.push({ ts: tsMs, high, low });
  // evict anything older than the window
  while (buf.length > 1 && buf[0].ts < tsMs - WINDOW_MS) buf.shift();

  if (buf.length < 2) return null;
  const oldest = buf[0];
  if (tsMs - oldest.ts < MIN_WINDOW_MS) return null;
  if (oldest.high < MIN_PRICE) return null; // the baseline itself must also clear the price floor
  const changePct = (high - oldest.high) / oldest.high;
  const lowChangePct = oldest.low > 0 ? (low - oldest.low) / oldest.low : 0;
  if (Math.abs(changePct) > MAX_SANE_PCT) return null; // stale/glitched tick, not a real move

  let direction: AlertDirection | null = null;
  if (changePct <= CRASH_PCT) direction = "crash";
  else if (changePct >= SPIKE_PCT) direction = "spike";
  if (!direction) return null;

  // Corroboration: the low (sell) side must have moved the same direction by at least half as
  // much, so a single stale/outlier tick on one side of the spread can't trigger alone.
  const corroborated =
    direction === "crash"
      ? lowChangePct <= CRASH_PCT * CORROBORATION_FRACTION
      : lowChangePct >= SPIKE_PCT * CORROBORATION_FRACTION;
  if (!corroborated) return null;

  const key = `${itemId}:${direction}`;
  const lastFiredAt = lastFired.get(key) ?? 0;
  if (tsMs - lastFiredAt < COOLDOWN_MS) return null;
  lastFired.set(key, tsMs);

  const item = nameLookupStmt.get(itemId) as { name: string; icon: string } | undefined;
  const event: AlertEvent = {
    id: `${itemId}-${direction}-${tsSeconds}`,
    itemId,
    name: item?.name ?? `Item ${itemId}`,
    icon: item?.icon ?? "",
    kind: "price",
    direction,
    severity: priceSeverity(changePct, oldest.high, high),
    changePct,
    fromPrice: oldest.high,
    toPrice: high,
    windowMinutes: Math.round((tsMs - oldest.ts) / 60000),
    triggeredAt: tsSeconds,
  };

  recentAlerts.unshift(event);
  if (recentAlerts.length > MAX_ALERTS) recentAlerts.length = MAX_ALERTS;
  return event;
}

// DESIGN.md §11.3 item 6: manipulation/bot-activity detection via volume anomalies, distinct
// from the price-move alerts above. Hypothesis (matches the general pattern discussed re: bot
// farming activity, e.g. the "Vorkath bots are back" style reports -- see DESIGN.md §14.3):
// bot-farmed items show sustained, unusually large trade volume WITHOUT the price move a real
// human supply/demand shift would cause. Deterministic z-score against the item's own trailing
// baseline, computed from price_history -- no ML, same philosophy as the crash/spike detector.
const BASELINE_LOOKBACK_SECONDS = 24 * 60 * 60; // 24h trailing baseline
const MIN_BASELINE_SAMPLES = 20; // don't judge an item off a handful of history points
// Live testing found MIN_BASELINE_SAMPLES alone wasn't enough -- on a freshly-running app (only
// hours of price_history accumulated, not a real 24h), 20 samples can all land in the same
// half-hour, producing a near-zero mean/stddev off a sparse slice, so any normal reading right
// after reads as a 15+ sigma "anomaly". Same class of bug as MIN_WINDOW_MS above for the price
// alert -- require the baseline to actually SPAN a meaningful real time range, not just have a
// sample count, before trusting its mean/stddev at all.
// 6 hours still wasn't enough in practice: even after the app had genuinely been running that
// long, dozens of items fired "anomalies" simultaneously with implausible z-scores (10-19 sigma)
// -- the shared root cause is that the baseline period straddles this pass's price_history
// dedup fix, so most of the "history" is either flat-duplicate rows (pre-fix) or is otherwise
// too thin/early to have seen real variance yet, understating stddev and overstating every
// z-score. There's no shortcut here: this signal genuinely needs several days of continuously-
// collected, already-deduped history before its baseline means anything -- exactly the "no
// signal should be trusted before historical validation" principle the V6 doc itself argued for
// (DESIGN.md §11, §14.3). Set high enough that it correctly produces nothing right now rather
// than noise; revisit once the app has actually run that long.
const MIN_BASELINE_SPAN_SECONDS = 3 * 24 * 60 * 60; // baseline must cover at least 3 real days
const VOLUME_Z_THRESHOLD = 3; // current volume must be 3+ std devs above its own 24h mean
const MAX_PRICE_DRIFT = 0.05; // and price must have stayed within +-5% -- otherwise the price-move
// alert above already covers it; this signal is specifically for "volume up, price flat"
const VOLUME_COOLDOWN_MS = 60 * 60 * 1000; // re-check hourly at most per item

const baselineStmt = db.prepare(`
  SELECT item_id,
         AVG(vol_high_5m + vol_low_5m) AS mean_vol,
         AVG((vol_high_5m + vol_low_5m) * (vol_high_5m + vol_low_5m)) AS mean_sq,
         AVG(high) AS avg_high,
         MIN(ts) AS earliest_ts
  FROM price_history
  WHERE ts > ?
  GROUP BY item_id
  HAVING COUNT(*) >= ?
`);
const latestVolumeStmt = db.prepare(
  `SELECT vol_high_1h, vol_low_1h, high FROM latest_snapshot WHERE item_id = ?`,
);

export function checkVolumeAnomalies(): AlertEvent[] {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const cutoff = nowSeconds - BASELINE_LOOKBACK_SECONDS;
  const rows = baselineStmt.all(cutoff, MIN_BASELINE_SAMPLES) as unknown as {
    item_id: number;
    mean_vol: number;
    mean_sq: number;
    avg_high: number | null;
    earliest_ts: number;
  }[];

  const fired: AlertEvent[] = [];

  for (const r of rows) {
    if (nowSeconds - r.earliest_ts < MIN_BASELINE_SPAN_SECONDS) continue;
    const variance = r.mean_sq - r.mean_vol * r.mean_vol;
    const stddev = Math.sqrt(Math.max(variance, 0));
    if (stddev === 0) continue; // perfectly flat volume, nothing to compare against

    const latest = latestVolumeStmt.get(r.item_id) as
      | { vol_high_1h: number; vol_low_1h: number; high: number | null }
      | undefined;
    if (!latest || latest.high == null) continue;

    const currentVol = latest.vol_high_1h + latest.vol_low_1h;
    const zScore = (currentVol - r.mean_vol) / stddev;
    if (zScore < VOLUME_Z_THRESHOLD) continue;

    // price must have stayed roughly flat over the same baseline window -- a real move belongs
    // to the price-alert above, not here.
    if (r.avg_high == null || r.avg_high === 0) continue;
    const priceDrift = Math.abs(latest.high - r.avg_high) / r.avg_high;
    if (priceDrift > MAX_PRICE_DRIFT) continue;

    const key = `${r.item_id}:volume`;
    const lastFiredAt = lastFired.get(key) ?? 0;
    if (nowSeconds * 1000 - lastFiredAt < VOLUME_COOLDOWN_MS) continue;
    lastFired.set(key, nowSeconds * 1000);

    const item = nameLookupStmt.get(r.item_id) as { name: string; icon: string } | undefined;
    const event: AlertEvent = {
      id: `${r.item_id}-volume-${nowSeconds}`,
      itemId: r.item_id,
      name: item?.name ?? `Item ${r.item_id}`,
      icon: item?.icon ?? "",
      kind: "volume",
      direction: "spike", // volume up -- reusing "spike" for the emerald/upward styling
      severity: volumeSeverity(zScore),
      changePct: r.mean_vol > 0 ? (currentVol - r.mean_vol) / r.mean_vol : 0,
      fromPrice: Math.round(r.mean_vol),
      toPrice: Math.round(currentVol),
      windowMinutes: Math.round(BASELINE_LOOKBACK_SECONDS / 60),
      triggeredAt: nowSeconds,
      zScore,
    };
    recentAlerts.unshift(event);
    fired.push(event);
  }

  if (recentAlerts.length > MAX_ALERTS) recentAlerts.length = MAX_ALERTS;
  return fired;
}

export function getRecentAlerts(): AlertEvent[] {
  return recentAlerts;
}
