import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbPath = path.join(__dirname, "..", "data.sqlite");

export const db = new DatabaseSync(dbPath);
db.exec("PRAGMA journal_mode = WAL;");
// Price snapshots can reference items the mapping poll hasn't caught up on yet
// (new items, or price poll racing the daily mapping refresh) -- don't hard-fail on that.
db.exec("PRAGMA foreign_keys = OFF;");

db.exec(`
CREATE TABLE IF NOT EXISTS items (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  examine TEXT,
  members INTEGER,
  lowalch INTEGER,
  highalch INTEGER,
  buy_limit INTEGER,
  value INTEGER,
  icon TEXT
);

CREATE TABLE IF NOT EXISTS latest_snapshot (
  item_id INTEGER PRIMARY KEY,
  high INTEGER,
  high_time INTEGER,
  low INTEGER,
  low_time INTEGER,
  avg_high_5m INTEGER,
  avg_low_5m INTEGER,
  vol_high_5m INTEGER,
  vol_low_5m INTEGER,
  avg_high_1h INTEGER,
  avg_low_1h INTEGER,
  vol_high_1h INTEGER,
  vol_low_1h INTEGER,
  updated_at INTEGER,
  FOREIGN KEY (item_id) REFERENCES items(id)
);

CREATE TABLE IF NOT EXISTS price_history (
  item_id INTEGER,
  ts INTEGER,
  high INTEGER,
  low INTEGER,
  avg_high_5m INTEGER,
  avg_low_5m INTEGER,
  vol_high_5m INTEGER,
  vol_low_5m INTEGER
);
CREATE INDEX IF NOT EXISTS idx_price_history_item_ts ON price_history(item_id, ts);

CREATE TABLE IF NOT EXISTS bank_imports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  imported_at INTEGER NOT NULL,
  total_value INTEGER NOT NULL,
  item_count INTEGER NOT NULL,
  entries_json TEXT NOT NULL,
  result_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_bank_imports_imported_at ON bank_imports(imported_at);

-- DESIGN.md §10 item 1 / §11.3 item 8: recommendation scorekeeping. Logs a snapshot of the
-- top Buy Signal items periodically, then checks back after a fixed horizon to see whether the
-- flip would actually have been profitable -- the app's own track record, not just a live score.
CREATE TABLE IF NOT EXISTS recommendation_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  icon TEXT,
  taken_at INTEGER NOT NULL,
  rank INTEGER NOT NULL,
  score REAL NOT NULL,
  buy_price INTEGER NOT NULL,
  sell_price INTEGER NOT NULL,
  net_margin INTEGER NOT NULL,
  roi_pct REAL NOT NULL,
  resolve_at INTEGER NOT NULL,
  resolved_at INTEGER,
  resolved_high INTEGER,
  resolved_low INTEGER,
  realized_net_margin INTEGER,
  realized_roi_pct REAL,
  outcome TEXT
);
CREATE INDEX IF NOT EXISTS idx_recommendation_snapshots_pending ON recommendation_snapshots(resolved_at, resolve_at);
CREATE INDEX IF NOT EXISTS idx_recommendation_snapshots_item ON recommendation_snapshots(item_id, resolved_at);
`);

const upsertItemStmt = db.prepare(`
  INSERT INTO items (id, name, examine, members, lowalch, highalch, buy_limit, value, icon)
  VALUES (@id, @name, @examine, @members, @lowalch, @highalch, @buy_limit, @value, @icon)
  ON CONFLICT(id) DO UPDATE SET
    name=excluded.name, examine=excluded.examine, members=excluded.members,
    lowalch=excluded.lowalch, highalch=excluded.highalch, buy_limit=excluded.buy_limit,
    value=excluded.value, icon=excluded.icon
`);

export function upsertItems(
  items: {
    id: number;
    name: string;
    examine: string | null;
    members: number;
    lowalch: number | null;
    highalch: number | null;
    buy_limit: number | null;
    value: number;
    icon: string;
  }[],
) {
  db.exec("BEGIN");
  try {
    for (const item of items) upsertItemStmt.run(item);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

const upsertSnapshotStmt = db.prepare(`
  INSERT INTO latest_snapshot (item_id, high, high_time, low, low_time, avg_high_5m, avg_low_5m,
    vol_high_5m, vol_low_5m, avg_high_1h, avg_low_1h, vol_high_1h, vol_low_1h, updated_at)
  VALUES (@item_id, @high, @high_time, @low, @low_time, @avg_high_5m, @avg_low_5m,
    @vol_high_5m, @vol_low_5m, @avg_high_1h, @avg_low_1h, @vol_high_1h, @vol_low_1h, @updated_at)
  ON CONFLICT(item_id) DO UPDATE SET
    high=excluded.high, high_time=excluded.high_time, low=excluded.low, low_time=excluded.low_time,
    avg_high_5m=excluded.avg_high_5m, avg_low_5m=excluded.avg_low_5m,
    vol_high_5m=excluded.vol_high_5m, vol_low_5m=excluded.vol_low_5m,
    avg_high_1h=excluded.avg_high_1h, avg_low_1h=excluded.avg_low_1h,
    vol_high_1h=excluded.vol_high_1h, vol_low_1h=excluded.vol_low_1h,
    updated_at=excluded.updated_at
`);

const insertHistoryStmt = db.prepare(`
  INSERT INTO price_history (item_id, ts, high, low, avg_high_5m, avg_low_5m, vol_high_5m, vol_low_5m)
  VALUES (@item_id, @updated_at, @high, @low, @avg_high_5m, @avg_low_5m, @vol_high_5m, @vol_low_5m)
`);

// DESIGN.md §11.2: the poller runs every 60s but the /5m and /1h windows this data comes from
// only actually change server-side every 5/60 minutes, so writing a price_history row on every
// poll was ~2.4B rows/year of mostly-exact duplicates. Dedupe against the last-seen values per
// item (in-memory, seeded from the DB once at startup) and only insert when something changed.
// `high`/`low` are excluded from the comparison deliberately -- those genuinely refresh from
// /latest most polls and are what the 6h/24h chart range needs at full 60s resolution.
interface HistoryComparable {
  avg_high_5m: number | null;
  avg_low_5m: number | null;
  vol_high_5m: number;
  vol_low_5m: number;
}
const lastHistoryValues = new Map<number, HistoryComparable>();

function seedLastHistoryValues() {
  const rows = db
    .prepare(
      `
    SELECT ph.item_id, ph.avg_high_5m, ph.avg_low_5m, ph.vol_high_5m, ph.vol_low_5m
    FROM price_history ph
    JOIN (SELECT item_id, MAX(ts) AS max_ts FROM price_history GROUP BY item_id) latest
      ON ph.item_id = latest.item_id AND ph.ts = latest.max_ts
  `,
    )
    .all() as unknown as (HistoryComparable & { item_id: number })[];
  for (const r of rows) {
    lastHistoryValues.set(r.item_id, {
      avg_high_5m: r.avg_high_5m,
      avg_low_5m: r.avg_low_5m,
      vol_high_5m: r.vol_high_5m,
      vol_low_5m: r.vol_low_5m,
    });
  }
  console.log(`[db] seeded price_history dedupe cache: ${rows.length} items`);
}
seedLastHistoryValues();

function historyUnchanged(itemId: number, next: HistoryComparable): boolean {
  const prev = lastHistoryValues.get(itemId);
  return (
    !!prev &&
    prev.avg_high_5m === next.avg_high_5m &&
    prev.avg_low_5m === next.avg_low_5m &&
    prev.vol_high_5m === next.vol_high_5m &&
    prev.vol_low_5m === next.vol_low_5m
  );
}

export function upsertSnapshots(
  rows: {
    item_id: number;
    high: number | null;
    high_time: number | null;
    low: number | null;
    low_time: number | null;
    avg_high_5m: number | null;
    avg_low_5m: number | null;
    vol_high_5m: number;
    vol_low_5m: number;
    avg_high_1h: number | null;
    avg_low_1h: number | null;
    vol_high_1h: number;
    vol_low_1h: number;
    updated_at: number;
  }[],
) {
  let written = 0;
  db.exec("BEGIN");
  try {
    for (const row of rows) {
      upsertSnapshotStmt.run(row);

      const comparable: HistoryComparable = {
        avg_high_5m: row.avg_high_5m,
        avg_low_5m: row.avg_low_5m,
        vol_high_5m: row.vol_high_5m,
        vol_low_5m: row.vol_low_5m,
      };
      if (historyUnchanged(row.item_id, comparable)) continue;

      insertHistoryStmt.run({
        item_id: row.item_id,
        updated_at: row.updated_at,
        high: row.high,
        low: row.low,
        avg_high_5m: row.avg_high_5m,
        avg_low_5m: row.avg_low_5m,
        vol_high_5m: row.vol_high_5m,
        vol_low_5m: row.vol_low_5m,
      });
      lastHistoryValues.set(row.item_id, comparable);
      written++;
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  return written;
}

// DESIGN.md §11.2 Fix 2 / §11.1: daily rollup source query for the DuckDB warehouse
// (backend/src/rollup.ts). Only ever asked for [fromTs, toTs) -- the caller resumes from the
// warehouse's own last-rolled-day marker, so this never rescans the whole table.
export interface DailyRollupRow {
  item_id: number;
  day: string;
  open_high: number | null;
  close_high: number | null;
  min_high: number | null;
  max_high: number | null;
  open_low: number | null;
  close_low: number | null;
  min_low: number | null;
  max_low: number | null;
  avg_volume: number | null;
  sample_count: number;
}

const dailyRollupStmt = db.prepare(`
  WITH ranked AS (
    SELECT item_id,
           date(ts, 'unixepoch') AS day,
           ts, high, low, vol_high_5m, vol_low_5m,
           ROW_NUMBER() OVER (PARTITION BY item_id, date(ts, 'unixepoch') ORDER BY ts ASC) AS rn_asc,
           ROW_NUMBER() OVER (PARTITION BY item_id, date(ts, 'unixepoch') ORDER BY ts DESC) AS rn_desc
    FROM price_history
    WHERE ts >= ? AND ts < ?
  )
  SELECT item_id, day,
         MAX(CASE WHEN rn_asc = 1 THEN high END) AS open_high,
         MAX(CASE WHEN rn_desc = 1 THEN high END) AS close_high,
         MIN(high) AS min_high, MAX(high) AS max_high,
         MAX(CASE WHEN rn_asc = 1 THEN low END) AS open_low,
         MAX(CASE WHEN rn_desc = 1 THEN low END) AS close_low,
         MIN(low) AS min_low, MAX(low) AS max_low,
         AVG(vol_high_5m + vol_low_5m) AS avg_volume,
         COUNT(*) AS sample_count
  FROM ranked
  GROUP BY item_id, day
  ORDER BY item_id, day
`);

export function getDailyRollup(fromTs: number, toTs: number): DailyRollupRow[] {
  return dailyRollupStmt.all(fromTs, toTs) as unknown as DailyRollupRow[];
}

export function getEarliestHistoryTs(): number | null {
  const row = db.prepare(`SELECT MIN(ts) AS t FROM price_history`).get() as { t: number | null };
  return row.t;
}

// Retention: once a day's ticks are safely rolled into the DuckDB warehouse, the raw
// price_history rows don't need to stay in SQLite forever -- this is the actual storage win
// §11.2 was chasing, now that there's a durable long-term home for the aggregates. Only ever
// called with a cutoff at least RAW_RETENTION_DAYS old (see rollup.ts), so this never deletes a
// day that hasn't been rolled up yet.
export function pruneHistoryBefore(cutoffTs: number): number {
  const result = db.prepare(`DELETE FROM price_history WHERE ts < ?`).run(cutoffTs);
  return Number(result.changes);
}
