import { fetchMapping, fetchLatest, fetchWindow } from "./wiki.js";
import { upsertItems, upsertSnapshots } from "./db.js";
import { recordSampleAndCheck, checkVolumeAnomalies } from "./alerts.js";
import { logRecommendationSnapshots, resolveRecommendationSnapshots } from "./scorekeeping.js";
import { runDailyRollup } from "./rollup.js";
import { fetchOfficialNews } from "./news.js";
import { insertNewEvents } from "./warehouse.js";

export async function pollMapping() {
  const mapping = await fetchMapping();
  upsertItems(
    mapping.map((m) => ({
      id: m.id,
      name: m.name,
      examine: m.examine ?? null,
      members: m.members ? 1 : 0,
      lowalch: m.lowalch ?? null,
      highalch: m.highalch ?? null,
      buy_limit: m.limit ?? null,
      value: m.value ?? 0,
      icon: m.icon ?? "",
    })),
  );
  console.log(`[poller] mapping refreshed: ${mapping.length} items`);
}

export async function pollPrices() {
  const [latest, win5m, win1h] = await Promise.all([
    fetchLatest(),
    fetchWindow("5m"),
    fetchWindow("1h"),
  ]);

  const now = Math.floor(Date.now() / 1000);
  const ids = new Set([...Object.keys(latest), ...Object.keys(win5m), ...Object.keys(win1h)]);

  const rows = [...ids].map((idStr) => {
    const id = Number(idStr);
    const l = latest[idStr];
    const w5 = win5m[idStr];
    const w1 = win1h[idStr];
    return {
      item_id: id,
      high: l?.high ?? null,
      high_time: l?.highTime ?? null,
      low: l?.low ?? null,
      low_time: l?.lowTime ?? null,
      avg_high_5m: w5?.avgHighPrice ?? null,
      avg_low_5m: w5?.avgLowPrice ?? null,
      vol_high_5m: w5?.highPriceVolume ?? 0,
      vol_low_5m: w5?.lowPriceVolume ?? 0,
      avg_high_1h: w1?.avgHighPrice ?? null,
      avg_low_1h: w1?.avgLowPrice ?? null,
      vol_high_1h: w1?.highPriceVolume ?? 0,
      vol_low_1h: w1?.lowPriceVolume ?? 0,
      updated_at: now,
    };
  });

  const written = upsertSnapshots(rows);

  const fired = rows
    .map((r) =>
      recordSampleAndCheck(r.item_id, r.updated_at, r.high, r.low, r.vol_high_1h, r.vol_low_1h),
    )
    .filter((e): e is NonNullable<typeof e> => e != null);
  for (const e of fired) {
    console.log(
      `[alerts] ${e.direction.toUpperCase()} ${e.name}: ${(e.changePct * 100).toFixed(1)}% over ${e.windowMinutes}m`,
    );
  }

  console.log(
    `[poller] prices refreshed: ${rows.length} items, ${written} price_history rows written (${
      rows.length - written
    } deduped)${fired.length ? `, ${fired.length} alert(s) fired` : ""} @ ${new Date().toISOString()}`,
  );
}

function runVolumeAnomalyCheck() {
  try {
    const fired = checkVolumeAnomalies();
    for (const e of fired) {
      console.log(
        `[alerts] VOLUME ${e.name}: z=${e.zScore?.toFixed(1)} (${e.fromPrice} -> ${e.toPrice} vs 24h baseline)`,
      );
    }
  } catch (err) {
    console.error("[alerts] volume anomaly check error", err);
  }
}

// DESIGN.md §10 item 1 / §11.3 item 8: recommendation scorekeeping -- log the current Buy Signals
// top-N periodically, then resolve them 4h later against actual prices to build a real track record.
function runScorekeeping() {
  try {
    const logged = logRecommendationSnapshots();
    const resolved = resolveRecommendationSnapshots();
    if (logged || resolved) {
      console.log(`[scorekeeping] logged ${logged}, resolved ${resolved}`);
    }
  } catch (err) {
    console.error("[scorekeeping] error", err);
  }
}

// DESIGN.md §11.1/§11.2 Fix 2: roll completed days of price_history into the DuckDB warehouse,
// then prune raw ticks past the retention window. Doesn't need to run more than once a day --
// completed days don't change -- but is safe to run more often since it's idempotent and resumes
// from the warehouse's own last-rolled-day marker.
async function runRollup() {
  try {
    const { daysRolled, rowsWritten, rowsPruned } = await runDailyRollup();
    if (daysRolled || rowsPruned) {
      console.log(
        `[rollup] ${daysRolled} day(s) rolled (${rowsWritten} item-day rows), ${rowsPruned} raw ticks pruned`,
      );
    }
  } catch (err) {
    console.error("[rollup] error", err);
  }
}

// DESIGN.md §6.4: official OSRS news RSS -- updates release weekly (Wednesdays ~11:30 UTC), so a
// daily poll picks up new ones same-day. Only the official-news source is wired up so far; Reddit
// is gated on Reddit's app approval, and LLM item-linking isn't built yet.
async function runNewsPoll() {
  try {
    const items = await fetchOfficialNews();
    const inserted = await insertNewEvents(
      items.map((item) => ({
        event_date: new Date(item.pubDate).toISOString().slice(0, 10),
        title: item.title,
        summary: item.description,
        source: "official",
        link: item.link || null,
        tags: item.category || null,
      })),
    );
    if (inserted) console.log(`[news] ${inserted} new official news item(s)`);
  } catch (err) {
    console.error("[news] error", err);
  }
}

export function startPolling() {
  // mapping changes rarely -- once at boot, then once a day
  pollMapping().catch((err) => console.error("[poller] mapping error", err));
  setInterval(
    () => {
      pollMapping().catch((err) => console.error("[poller] mapping error", err));
    },
    24 * 60 * 60 * 1000,
  );

  // prices: poll every 60s
  pollPrices().catch((err) => console.error("[poller] prices error", err));
  setInterval(() => {
    pollPrices().catch((err) => console.error("[poller] prices error", err));
  }, 60 * 1000);

  // volume anomaly detection: a heavier aggregate query over 24h of price_history, doesn't
  // need 60s resolution -- runs every 10 minutes instead (DESIGN.md §11.3 item 6).
  runVolumeAnomalyCheck();
  setInterval(runVolumeAnomalyCheck, 10 * 60 * 1000);

  // recommendation scorekeeping: log + resolve on a 30-minute cadence -- doesn't need to be
  // any tighter than that given the 4h resolution horizon (DESIGN.md §10 item 1).
  runScorekeeping();
  setInterval(runScorekeeping, 30 * 60 * 1000);

  // warehouse rollup: only completed (UTC) days ever get processed, so once an hour is already
  // far more often than needed -- cheap to run though, and means the warehouse fills in promptly
  // once the app has been running long enough to have a first full day of history.
  runRollup();
  setInterval(runRollup, 60 * 60 * 1000);

  // official news: changes rarely -- once at boot, then once a day, same cadence as the mapping poll.
  runNewsPoll();
  setInterval(runNewsPoll, 24 * 60 * 60 * 1000);
}
