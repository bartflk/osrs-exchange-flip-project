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
`);

const upsertItemStmt = db.prepare(`
  INSERT INTO items (id, name, examine, members, lowalch, highalch, buy_limit, value, icon)
  VALUES (@id, @name, @examine, @members, @lowalch, @highalch, @buy_limit, @value, @icon)
  ON CONFLICT(id) DO UPDATE SET
    name=excluded.name, examine=excluded.examine, members=excluded.members,
    lowalch=excluded.lowalch, highalch=excluded.highalch, buy_limit=excluded.buy_limit,
    value=excluded.value, icon=excluded.icon
`);

export function upsertItems(items: {
  id: number; name: string; examine: string | null; members: number;
  lowalch: number | null; highalch: number | null; buy_limit: number | null;
  value: number; icon: string;
}[]) {
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

export function upsertSnapshots(rows: {
  item_id: number; high: number | null; high_time: number | null; low: number | null; low_time: number | null;
  avg_high_5m: number | null; avg_low_5m: number | null; vol_high_5m: number; vol_low_5m: number;
  avg_high_1h: number | null; avg_low_1h: number | null; vol_high_1h: number; vol_low_1h: number;
  updated_at: number;
}[]) {
  db.exec("BEGIN");
  try {
    for (const row of rows) {
      upsertSnapshotStmt.run(row);
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
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}
