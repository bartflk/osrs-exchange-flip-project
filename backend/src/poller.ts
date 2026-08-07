import { fetchMapping, fetchLatest, fetchWindow } from "./wiki.js";
import { upsertItems, upsertSnapshots } from "./db.js";
import { recordSampleAndCheck, checkVolumeAnomalies } from "./alerts.js";
import { refreshVolatility } from "./volatility.js";
import { logRecommendationSnapshots, resolveRecommendationSnapshots } from "./scorekeeping.js";
import { runDailyRollup } from "./rollup.js";
import { fetchOfficialNews } from "./news.js";
import { fetchRedditPosts } from "./redditFeed.js";
import { insertNewEvents, kvGet, kvSet } from "./db.js";

// DESIGN.md §14.22: the frontend's own "next refresh" countdown (§14.21) was a guess based on
// its own independent fetch cycle, not the real thing -- the backend polls the Wiki API on its
// own fixed 60s cycle that starts at server boot, with no fixed relationship to when any given
// browser tab happens to be open. Tracking the actual next-scheduled-poll timestamp here lets
// /api/status expose ground truth instead, so the frontend can show a countdown that's actually
// synced to the real API cycle rather than reflecting its own polling schedule.
let lastPricePollAt: number | null = null;
let nextPricePollAt: number | null = null;

export function getPricePollTiming(): {
  lastPricePollAt: number | null;
  nextPricePollAt: number | null;
} {
  return { lastPricePollAt, nextPricePollAt };
}

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

// DESIGN.md §8.1/§14.12: volatility score -- a batch aggregate over 24h of price_history,
// same cadence reasoning as the volume anomaly check below (doesn't need 60s resolution).
function runVolatilityRefresh() {
  try {
    const count = refreshVolatility();
    console.log(`[volatility] refreshed for ${count} items`);
  } catch (err) {
    console.error("[volatility] error", err);
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

// DESIGN.md §14.37: `tsx watch` restarts the backend on every source edit, and each restart
// re-runs the boot poll for every source. That's free against Jagex/the Wiki, but Reddit
// aggressively rate-limits (and then 403s) a client that reconnects repeatedly -- during one
// development session this alone was enough to get blocked for hours, which silently broke
// ingestion. Persisting the last-poll timestamp (kv_cache, survives restarts) and skipping the
// fetch if it's still fresh makes restarts free and caps real Reddit traffic at one request per
// subreddit per interval, no matter how often the process reloads.
async function shouldPoll(key: string, minIntervalMs: number): Promise<boolean> {
  const last = kvGet(key);
  if (last && Date.now() - Number(last.value) < minIntervalMs) return false;
  kvSet(key, String(Date.now()));
  return true;
}

// DESIGN.md §6.4: official OSRS news RSS -- updates release weekly (Wednesdays ~11:30 UTC), so a
// daily poll picks up new ones same-day.
async function runNewsPoll() {
  if (!(await shouldPoll("lastPoll:officialNews", 12 * 60 * 60 * 1000))) return;
  try {
    const items = await fetchOfficialNews();
    const inserted = insertNewEvents(
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

// DESIGN.md §14.35: Reddit via public RSS (no OAuth/PRAW needed) -- top-of-day posts from
// r/2007scape and r/runescape, same events table as official news, tagged `source: "reddit"`.
// Polled hourly (community discussion moves faster than weekly patch notes, but top-of-day
// rankings don't change meaningfully minute to minute).
async function runRedditPoll() {
  if (!(await shouldPoll("lastPoll:reddit", 55 * 60 * 1000))) return;
  try {
    const posts = await fetchRedditPosts();
    const inserted = insertNewEvents(
      posts.map((post) => ({
        event_date: new Date(post.updated).toISOString().slice(0, 10),
        title: post.title,
        summary: `Posted by ${post.author} in r/${post.subreddit}`,
        source: "reddit",
        link: post.link || null,
        tags: `r/${post.subreddit}`,
      })),
    );
    if (inserted) console.log(`[reddit] ${inserted} new post(s)`);
  } catch (err) {
    console.error("[reddit] error", err);
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

  // prices: poll every 60s -- lastPricePollAt/nextPricePollAt are set right before each fire so
  // /api/status always reflects the real schedule, not an assumption about it.
  const PRICE_POLL_MS = 60 * 1000;
  function firePricePoll() {
    lastPricePollAt = Date.now();
    nextPricePollAt = lastPricePollAt + PRICE_POLL_MS;
    pollPrices().catch((err) => console.error("[poller] prices error", err));
  }
  firePricePoll();
  setInterval(firePricePoll, PRICE_POLL_MS);

  // volume anomaly detection: a heavier aggregate query over 24h of price_history, doesn't
  // need 60s resolution -- runs every 10 minutes instead (DESIGN.md §11.3 item 6).
  runVolumeAnomalyCheck();
  setInterval(runVolumeAnomalyCheck, 10 * 60 * 1000);

  // volatility score: same cadence/reasoning as the volume anomaly check above.
  runVolatilityRefresh();
  setInterval(runVolatilityRefresh, 10 * 60 * 1000);

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

  // reddit: community discussion moves faster than patch notes -- hourly.
  runRedditPoll();
  setInterval(runRedditPoll, 60 * 60 * 1000);
}
