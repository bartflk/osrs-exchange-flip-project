import { getDailyRollup, getEarliestHistoryTs, pruneHistoryBefore } from "./db.js";
import { upsertPriceDaily, getLastRolledDay, type PriceDailyRow } from "./warehouse.js";

// DESIGN.md §11.2 Fix 2 / §11.1: roll completed days of price_history into the DuckDB warehouse's
// price_daily table, then prune raw ticks older than the retention window. This is the "real
// change" half of Fix 2 (schema split by cadence) -- SQLite's price_history stays the live,
// full-resolution table for recent data; DuckDB holds the durable long-term OHLC-style record at
// a fraction of the row count once a day is fully rolled up.
const RAW_RETENTION_DAYS = 3; // keep this many days of raw 60s ticks in SQLite regardless of
// rollup status -- generous margin over the job's own daily cadence, and matches Fix 1's original
// reasoning that recent high/low deserves full resolution, not just a daily OHLC summary.

function utcDayStartTs(date: Date): number {
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()) / 1000;
}

export async function runDailyRollup(): Promise<{
  daysRolled: number;
  rowsWritten: number;
  rowsPruned: number;
}> {
  const todayStartTs = utcDayStartTs(new Date());

  const lastRolledDay = await getLastRolledDay();
  let fromTs: number;
  if (lastRolledDay) {
    fromTs = Math.floor(new Date(`${lastRolledDay}T00:00:00Z`).getTime() / 1000) + 86400;
  } else {
    const earliest = getEarliestHistoryTs();
    if (earliest == null) return { daysRolled: 0, rowsWritten: 0, rowsPruned: 0 }; // no data yet
    fromTs = utcDayStartTs(new Date(earliest * 1000));
  }

  let rowsWritten = 0;
  let daysRolled = 0;
  if (fromTs < todayStartTs) {
    const rows = getDailyRollup(fromTs, todayStartTs);
    if (rows.length > 0) {
      await upsertPriceDaily(rows as PriceDailyRow[]);
      rowsWritten = rows.length;
      daysRolled = new Set(rows.map((r) => r.day)).size;
    } else {
      // No price_history rows in this range (e.g. a gap) -- still worth marking progress so the
      // next run doesn't rescan the same empty range indefinitely. Write a zero-sample marker for
      // one item-less day isn't meaningful, so instead just let the next run's earliest-ts lookup
      // naturally advance once real data resumes; nothing to do here.
    }
  }

  // Retention: only ever prune what's strictly older than the retention window, independent of
  // whether today's rollup found anything -- safe because any day that old was covered by some
  // past run of this same job (or never had data to begin with).
  const retentionCutoffTs = todayStartTs - RAW_RETENTION_DAYS * 86400;
  const rowsPruned = pruneHistoryBefore(retentionCutoffTs);

  return { daysRolled, rowsWritten, rowsPruned };
}
