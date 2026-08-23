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

-- DESIGN.md §14.37: events (official patch notes + Reddit posts) live HERE, not in the DuckDB
-- warehouse where they originally sat. The warehouse is explicitly a disposable, self-rebuilding
-- analytical cache (warehouse.ts deletes and recreates it on any WAL replay failure) on the
-- premise that everything in it re-derives from a source -- true for price rollups, and true for
-- official news (Jagex's RSS is an archive that always carries the last ~15 items), but NOT true
-- for Reddit: top/.rss?t=day is a rolling window, so once a day rolls over those posts are gone
-- from the feed forever. A wiped warehouse silently and permanently lost them. Events are a
-- source of truth once fetched, so they belong in the durable operational DB.
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_date TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT,
  source TEXT NOT NULL,
  link TEXT,
  tags TEXT,
  UNIQUE (source, title, event_date)
);
CREATE INDEX IF NOT EXISTS idx_events_date ON events(event_date DESC);

-- Small durable key/value store for things that were previously in-memory and therefore lost on
-- every "tsx watch" restart: external-poll timestamps (so a restart doesn't immediately re-hit a
-- rate-limited third party) and cached LLM output (so a restart doesn't force a regeneration).
CREATE TABLE IF NOT EXISTS kv_cache (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- DESIGN.md §14.40: the real trade ledger -- what YOU actually bought and sold, as opposed to
-- recommendation_snapshots (what the app predicted) or the old offers.ts/fills.ts (hand-typed
-- localStorage, capped at 50, no item ids). Every Flipping-Copilot-style screen -- Portfolio,
-- Session, Flips, Visualize flip, Missed flips -- is a view over this one table.
--
-- Source of truth, never a cache: same lesson as events in §14.37. A fill observed once can never
-- be re-derived, because the GE slot that produced it gets reused the moment the offer clears.
CREATE TABLE IF NOT EXISTS ge_transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_hash TEXT NOT NULL,
  item_id INTEGER NOT NULL,
  type TEXT NOT NULL,             -- buy | sell
  quantity INTEGER NOT NULL,      -- units filled by THIS transaction, not the offer total
  price INTEGER NOT NULL,         -- gp per unit actually paid/received for this fill
  spent INTEGER NOT NULL,         -- gp moved by this fill (quantity * price, stored for audit)
  slot INTEGER,                   -- GE box 0-7, null for backfilled history that predates capture
  occurred_at INTEGER NOT NULL,   -- unix seconds
  source TEXT NOT NULL,           -- slot-diff | flipping-utilities | plugin
  -- Dedup is a table constraint rather than a read-then-filter query, for the exact reason given
  -- in §14.37: a hardcoded WHERE clause silently drifted from the writer and let duplicates in.
  -- A slot can only produce one distinct fill per (item, price, cumulative qty) at one instant.
  UNIQUE (account_hash, item_id, type, occurred_at, price, quantity, slot)
);
CREATE INDEX IF NOT EXISTS idx_ge_tx_time ON ge_transactions(occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_ge_tx_item ON ge_transactions(item_id, occurred_at);

-- DESIGN.md §14.44: per-item, per-half-hour-of-day price profile, so "what's the best thing to
-- buy right now" can be answered by time of day across the whole market rather than one item at
-- a time. 48 slots per item (00:00, 00:30, ... 23:30), all times UTC.
--
-- Stored rather than computed on demand because building it costs one Wiki API request per item:
-- fine as a slow background refresh, impossible per page load.
--
-- NOTE (§14.45): this does NOT accumulate history. upsertSlotProfiles() overwrites each row, so
-- every refresh replaces the profile with a fresh 7.6-day window rather than extending it. An
-- earlier version of this comment claimed otherwise; growing the window past the API's 365-point
-- cap would need an append-only observations table, which is not built.
CREATE TABLE IF NOT EXISTS item_slot_profile (
  item_id INTEGER NOT NULL,
  slot INTEGER NOT NULL,          -- 0-47, half-hour index into the UTC day
  buy_deviation REAL,             -- median % deviation of insta-buy price from that day's mean
  buy_price REAL,                 -- median ABSOLUTE gp you pay in this slot (see §14.45)
  sell_price REAL,                -- median ABSOLUTE gp you receive in this slot
  sell_deviation REAL,            -- same for insta-sell
  volume INTEGER NOT NULL,        -- mean units traded in this slot
  days INTEGER NOT NULL,          -- distinct days contributing
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (item_id, slot)
);
CREATE INDEX IF NOT EXISTS idx_slot_profile_slot ON item_slot_profile(slot);

-- DESIGN.md §14.51: the per-DAY readings behind each slot, kept because the aggregate above
-- cannot answer the question the ranking actually asks.
--
-- "Buy at slot S, sell at slot T" is a PAIRED trade: it lives or dies on (sell_d - buy_d) within
-- the same day. median(sell) - median(buy) is not that, and on a trending item the two medians
-- land on different days, so the week's drift gets counted as time-of-day edge. Measured live:
-- Dexterous prayer scroll fell 19% across the sample week and the aggregate reported a 1.62m/unit
-- edge where the median day actually delivered 109k -- and three of eight picks were loss-making.
CREATE TABLE IF NOT EXISTS item_slot_daily (
  item_id INTEGER NOT NULL,
  slot INTEGER NOT NULL,      -- 0-47, half-hour index into the UTC day
  day TEXT NOT NULL,          -- YYYY-MM-DD (UTC)
  low INTEGER,                -- insta-buy price observed in that slot on that day
  high INTEGER,               -- insta-sell price
  PRIMARY KEY (item_id, slot, day)
);
CREATE INDEX IF NOT EXISTS idx_slot_daily_item ON item_slot_daily(item_id, slot);

-- Last-seen state per GE slot. Only exists so the next poll can diff against it: a rising
-- quantitySold on the same offer IS a fill, deterministically, no inference. Genuinely
-- disposable -- losing it costs at most one poll cycle of granularity.
CREATE TABLE IF NOT EXISTS ge_slot_state (
  account_hash TEXT NOT NULL,
  slot INTEGER NOT NULL,
  item_id INTEGER NOT NULL,
  type TEXT NOT NULL,
  price INTEGER NOT NULL,
  total_quantity INTEGER NOT NULL,
  quantity_sold INTEGER NOT NULL,
  spent INTEGER NOT NULL,
  state TEXT NOT NULL,
  observed_at INTEGER NOT NULL,
  PRIMARY KEY (account_hash, slot)
);
`);

// Migrations for columns added after a table shipped. CREATE TABLE IF NOT EXISTS silently does
// nothing on an existing table, so new columns have to be added explicitly or every existing
// install keeps the old shape and fails at runtime rather than at startup.
for (const [table, column, type] of [
  ["item_slot_profile", "buy_price", "REAL"],
  ["item_slot_profile", "sell_price", "REAL"],
  // DESIGN.md §10 item 57: which item(s) an event mentions, JSON array of item ids (e.g.
  // "[4151,11840]"), NULL until the linking pass has looked at it -- distinct from `tags`, which
  // is reserved for §11.3 item 1's separate (still unbuilt) exposure-category classification.
  ["events", "linked_item_ids", "TEXT"],
  // Which feature produced a recommendation. Without it the Overnight page's picks would pool
  // into the same win rate as Buy Signals' 4-hour calls and neither number would describe
  // anything: they are different strategies over different horizons. Existing rows predate the
  // column and are backfilled to 'signals' below, which is what they all were.
  ["recommendation_snapshots", "strategy", "TEXT"],
  // Overnight picks name the slot they were taken for and the slot they plan to sell into, so a
  // resolved outcome can be traced back to the exact timing claim rather than just the item.
  ["recommendation_snapshots", "buy_slot", "INTEGER"],
  ["recommendation_snapshots", "sell_slot", "INTEGER"],
] as const) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as unknown as { name: string }[];
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }
}

// Every recommendation logged before the `strategy` column existed came from Buy Signals -- the
// Overnight page never wrote to this table at all. Backfilling them as 'signals' rather than
// leaving NULL keeps "WHERE strategy = 'signals'" honest instead of silently dropping 715 rows
// of real history from the track record the moment it starts filtering.
db.exec(`UPDATE recommendation_snapshots SET strategy = 'signals' WHERE strategy IS NULL`);

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

export interface HistoryTick {
  ts: number;
  high: number | null;
  low: number | null;
}

// Most recent N ticks for one item, oldest-first -- used by forecast.ts to build a
// period-over-period return distribution (needs chronological order, not the DESC a UI table
// would want).
const recentHistoryStmt = db.prepare(`
  SELECT ts, high, low FROM price_history WHERE item_id = ? ORDER BY ts DESC LIMIT ?
`);

export function getRecentHistoryForItem(itemId: number, limit: number): HistoryTick[] {
  const rows = recentHistoryStmt.all(itemId, limit) as unknown as HistoryTick[];
  return rows.reverse();
}

// DESIGN.md §14.37: events storage, moved here from the disposable DuckDB warehouse (see the
// `events` table comment in the schema above for why). Dedup is enforced by the table's UNIQUE
// constraint via INSERT OR IGNORE rather than a read-then-filter pass -- the previous
// implementation hardcoded `WHERE source = 'official'` when building its "already seen" set, so
// Reddit posts were compared against official-news titles only and re-inserted on every poll.
export interface EventRow {
  event_date: string;
  title: string;
  summary: string;
  source: string;
  link: string | null;
  tags: string | null;
}

export interface EventRecord extends EventRow {
  id: number;
}

const insertEventStmt = db.prepare(`
  INSERT OR IGNORE INTO events (event_date, title, summary, source, link, tags)
  VALUES (?, ?, ?, ?, ?, ?)
`);

export function insertNewEvents(rows: EventRow[]): number {
  let inserted = 0;
  for (const r of rows) {
    const result = insertEventStmt.run(r.event_date, r.title, r.summary, r.source, r.link, r.tags);
    inserted += Number(result.changes);
  }
  return inserted;
}

const recentEventsStmt = db.prepare(`
  SELECT id, event_date, title, summary, source, link, tags
  FROM events ORDER BY event_date DESC, id DESC LIMIT ?
`);

export function getRecentEvents(limit: number): EventRecord[] {
  return recentEventsStmt.all(limit) as unknown as EventRecord[];
}

// DESIGN.md §10 item 57: item-linking for already-collected events (Reddit posts have been live
// since §14.35, but nothing tags which item(s) a post is actually about). Most-recent-first so a
// slow/interrupted linking pass covers what's currently relevant before it works backward through
// the archive.
const eventsNeedingLinkingStmt = db.prepare(`
  SELECT id, event_date, title, summary, source, link, tags
  FROM events WHERE linked_item_ids IS NULL
  ORDER BY event_date DESC, id DESC LIMIT ?
`);

export function getEventsNeedingLinking(limit: number): EventRecord[] {
  return eventsNeedingLinkingStmt.all(limit) as unknown as EventRecord[];
}

const setEventLinkedItemsStmt = db.prepare(
  `UPDATE events SET linked_item_ids = ? WHERE id = ?`,
);

// itemIds=[] (not null) is a real, valid result -- "this event mentions no specific item" -- and
// is stored as "[]" so the event doesn't get re-queued by getEventsNeedingLinking() forever.
export function setEventLinkedItems(eventId: number, itemIds: number[]): void {
  setEventLinkedItemsStmt.run(JSON.stringify(itemIds), eventId);
}

// Plain LIKE rather than SQLite's json1 functions (json_each) -- avoids depending on node:sqlite's
// bundled build having JSON1 compiled in, unconfirmed and untested elsewhere in this codebase.
// event volume is small (low hundreds of rows), so filtering the LIKE-matched candidates in JS
// with a real JSON.parse (rather than trusting the substring match alone, which could
// false-positive on id 15 matching stored id 115) is cheap and exact.
const eventsWithLinksStmt = db.prepare(`
  SELECT id, event_date, title, summary, source, link, tags, linked_item_ids
  FROM events
  WHERE linked_item_ids IS NOT NULL AND linked_item_ids LIKE '%' || ? || '%'
  ORDER BY event_date DESC, id DESC
`);

export function getEventsForItem(itemId: number, limit: number): EventRecord[] {
  const candidates = eventsWithLinksStmt.all(String(itemId)) as unknown as (EventRecord & {
    linked_item_ids: string;
  })[];
  const matches = candidates.filter((r) => {
    try {
      const ids = JSON.parse(r.linked_item_ids) as number[];
      return Array.isArray(ids) && ids.includes(itemId);
    } catch {
      return false;
    }
  });
  return matches.slice(0, limit);
}

// Durable key/value cache -- survives `tsx watch` restarts, unlike the in-memory Maps these
// replace. Used for external-poll throttling and cached LLM output.
const kvGetStmt = db.prepare(`SELECT value, updated_at FROM kv_cache WHERE key = ?`);
const kvSetStmt = db.prepare(`
  INSERT INTO kv_cache (key, value, updated_at) VALUES (?, ?, ?)
  ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
`);

export function kvGet(key: string): { value: string; updatedAt: number } | null {
  const row = kvGetStmt.get(key) as { value: string; updated_at: number } | undefined;
  return row ? { value: row.value, updatedAt: row.updated_at } : null;
}

export function kvSet(key: string, value: string): void {
  kvSetStmt.run(key, value, Date.now());
}

// Convenience wrapper: returns the parsed value only if it was written within `maxAgeMs`.
export function kvGetFresh<T>(key: string, maxAgeMs: number): T | null {
  const row = kvGet(key);
  if (!row || Date.now() - row.updatedAt > maxAgeMs) return null;
  try {
    return JSON.parse(row.value) as T;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// GE trade ledger (DESIGN.md §14.40)
// ---------------------------------------------------------------------------

export interface GeTransaction {
  id: number;
  account_hash: string;
  item_id: number;
  type: "buy" | "sell";
  quantity: number;
  price: number;
  spent: number;
  slot: number | null;
  occurred_at: number;
  source: string;
}

export type NewGeTransaction = Omit<GeTransaction, "id">;

const insertTxStmt = db.prepare(`
  INSERT OR IGNORE INTO ge_transactions
    (account_hash, item_id, type, quantity, price, spent, slot, occurred_at, source)
  VALUES (@account_hash, @item_id, @type, @quantity, @price, @spent, @slot, @occurred_at, @source)
`);

// Returns how many rows were genuinely new. INSERT OR IGNORE against the UNIQUE constraint means
// re-importing the same history file, or re-reading an unchanged slot, is a no-op rather than a
// duplicate -- the caller doesn't have to know what it already stored.
export function insertGeTransactions(rows: NewGeTransaction[]): number {
  if (!rows.length) return 0;
  let inserted = 0;
  // node:sqlite's DatabaseSync has no better-sqlite3-style .transaction() helper -- explicit
  // BEGIN/COMMIT, matching upsertItems above.
  db.exec("BEGIN");
  try {
    for (const r of rows) {
      inserted += Number(insertTxStmt.run(r as unknown as Record<string, never>).changes);
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  return inserted;
}

const txSinceStmt = db.prepare(`
  SELECT t.*, i.name, i.icon
  FROM ge_transactions t LEFT JOIN items i ON i.id = t.item_id
  WHERE t.occurred_at >= ? ORDER BY t.occurred_at DESC, t.id DESC LIMIT ?
`);

export function getGeTransactions(sinceUnix: number, limit = 500) {
  return txSinceStmt.all(sinceUnix, limit) as unknown as (GeTransaction & {
    name: string | null;
    icon: string | null;
  })[];
}

const txForItemStmt = db.prepare(`
  SELECT * FROM ge_transactions WHERE item_id = ? ORDER BY occurred_at ASC
`);

export function getGeTransactionsForItem(itemId: number): GeTransaction[] {
  return txForItemStmt.all(itemId) as unknown as GeTransaction[];
}

const allTxStmt = db.prepare(`SELECT * FROM ge_transactions ORDER BY occurred_at ASC`);

export function getAllGeTransactions(): GeTransaction[] {
  return allTxStmt.all() as unknown as GeTransaction[];
}

export interface GeSlotState {
  account_hash: string;
  slot: number;
  item_id: number;
  type: "buy" | "sell";
  price: number;
  total_quantity: number;
  quantity_sold: number;
  spent: number;
  state: string;
  observed_at: number;
}

const getSlotStatesStmt = db.prepare(`SELECT * FROM ge_slot_state`);
const upsertSlotStateStmt = db.prepare(`
  INSERT INTO ge_slot_state
    (account_hash, slot, item_id, type, price, total_quantity, quantity_sold, spent, state, observed_at)
  VALUES (@account_hash, @slot, @item_id, @type, @price, @total_quantity, @quantity_sold, @spent, @state, @observed_at)
  ON CONFLICT(account_hash, slot) DO UPDATE SET
    item_id=excluded.item_id, type=excluded.type, price=excluded.price,
    total_quantity=excluded.total_quantity, quantity_sold=excluded.quantity_sold,
    spent=excluded.spent, state=excluded.state, observed_at=excluded.observed_at
`);

export function getGeSlotStates(): GeSlotState[] {
  return getSlotStatesStmt.all() as unknown as GeSlotState[];
}

export function upsertGeSlotStates(rows: GeSlotState[]): void {
  if (!rows.length) return;
  db.exec("BEGIN");
  try {
    for (const r of rows) upsertSlotStateStmt.run(r as unknown as Record<string, never>);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Per-half-hour slot profiles (DESIGN.md §14.44)
// ---------------------------------------------------------------------------

export interface SlotProfileRow {
  item_id: number;
  slot: number;
  buy_deviation: number | null;
  sell_deviation: number | null;
  /** Median absolute gp paid/received in this slot -- the basis for real after-tax profit. */
  buy_price: number | null;
  sell_price: number | null;
  volume: number;
  days: number;
  updated_at: number;
}

const upsertSlotProfileStmt = db.prepare(`
  INSERT INTO item_slot_profile
    (item_id, slot, buy_deviation, sell_deviation, buy_price, sell_price, volume, days, updated_at)
  VALUES (@item_id, @slot, @buy_deviation, @sell_deviation, @buy_price, @sell_price, @volume, @days, @updated_at)
  ON CONFLICT(item_id, slot) DO UPDATE SET
    buy_deviation=excluded.buy_deviation, sell_deviation=excluded.sell_deviation,
    buy_price=excluded.buy_price, sell_price=excluded.sell_price,
    volume=excluded.volume, days=excluded.days, updated_at=excluded.updated_at
`);

export function upsertSlotProfiles(rows: SlotProfileRow[]): void {
  if (!rows.length) return;
  db.exec("BEGIN");
  try {
    for (const r of rows) upsertSlotProfileStmt.run(r as unknown as Record<string, never>);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

const insertSlotDailyStmt = db.prepare(`
  INSERT INTO item_slot_daily (item_id, slot, day, low, high)
  VALUES (@item_id, @slot, @day, @low, @high)
  ON CONFLICT(item_id, slot, day) DO UPDATE SET low=excluded.low, high=excluded.high
`);
const deleteSlotDailyStmt = db.prepare(`DELETE FROM item_slot_daily WHERE item_id = ?`);

export interface SlotDailyRow {
  item_id: number;
  slot: number;
  day: string;
  low: number | null;
  high: number | null;
}

export function replaceSlotDaily(itemId: number, rows: SlotDailyRow[]): void {
  db.exec("BEGIN");
  try {
    // Replaced wholesale rather than merged: each refresh re-fetches the same rolling 7.6-day
    // window, so days that have aged out should disappear rather than linger.
    deleteSlotDailyStmt.run(itemId);
    for (const r of rows) insertSlotDailyStmt.run(r as unknown as Record<string, never>);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

// Every day where BOTH the buy slot and the sell slot have a reading. The inner join is the whole
// point -- a day present at only one of the two slots cannot price a round trip.
const pairedDaysStmt = db.prepare(`
  SELECT b.day, b.low AS buy, s.high AS sell
  FROM item_slot_daily b
  JOIN item_slot_daily s ON s.item_id = b.item_id AND s.day = b.day
  WHERE b.item_id = ? AND b.slot = ? AND s.slot = ?
    AND b.low IS NOT NULL AND s.high IS NOT NULL
`);

export function getPairedDays(
  itemId: number,
  buySlot: number,
  sellSlot: number,
): { day: string; buy: number; sell: number }[] {
  return pairedDaysStmt.all(itemId, buySlot, sellSlot) as unknown as {
    day: string;
    buy: number;
    sell: number;
  }[];
}

// Every measured day's low at one slot -- the input to "would this bid actually have filled?".
const slotDailyLowsStmt = db.prepare(
  `SELECT low FROM item_slot_daily WHERE item_id = ? AND slot = ? AND low IS NOT NULL`,
);

const slotDailyHighsStmt = db.prepare(
  `SELECT high FROM item_slot_daily WHERE item_id = ? AND slot = ? AND high IS NOT NULL`,
);

export function getSlotDailyHighs(itemId: number, slot: number): number[] {
  const rows = slotDailyHighsStmt.all(itemId, slot) as unknown as { high: number }[];
  return rows.map((r) => r.high);
}

export function getSlotDailyLows(itemId: number, slot: number): number[] {
  const rows = slotDailyLowsStmt.all(itemId, slot) as unknown as { low: number }[];
  return rows.map((r) => r.low);
}

const profiledItemsStmt = db.prepare(
  `SELECT item_id, MAX(updated_at) AS updated_at FROM item_slot_profile GROUP BY item_id`,
);

export function getProfiledItems(): { item_id: number; updated_at: number }[] {
  return profiledItemsStmt.all() as unknown as { item_id: number; updated_at: number }[];
}

// Items the ranking can ACTUALLY use: a fresh profile AND per-day rows to pair against.
// Both halves are load-bearing and they are stored in different tables, so "has a profile" and
// "can produce a pick" are not the same set. Measured before this existed: 556 items had
// profiles, the header reported 556, and only 434 could ever produce a pick.
const rankableItemCountStmt = db.prepare(`
  SELECT COUNT(*) AS c FROM (
    SELECT p.item_id
    FROM item_slot_profile p
    WHERE p.updated_at > ?
      AND EXISTS (SELECT 1 FROM item_slot_daily d WHERE d.item_id = p.item_id)
    GROUP BY p.item_id
  )
`);

export function countRankableItems(freshSince: number): number {
  const row = rankableItemCountStmt.get(freshSince) as unknown as { c: number };
  return row?.c ?? 0;
}

// Items holding a profile with no per-day rows behind it. These are silently unrankable:
// getPairedDays() returns nothing for them, bestPickForItem() returns null, and no log or UI
// signal says so. They arise when an item was profiled before item_slot_daily existed (or a
// write half-failed) and has since dropped out of the refresh candidate list, so it is never
// revisited -- it just sits there looking fresh until the 14-day prune. Fed back into the
// refresh job's candidate set so they self-heal instead of quietly shrinking the ranking pool.
const unbackedProfileItemsStmt = db.prepare(`
  SELECT DISTINCT p.item_id
  FROM item_slot_profile p
  WHERE NOT EXISTS (SELECT 1 FROM item_slot_daily d WHERE d.item_id = p.item_id)
`);

export function getUnbackedProfileItems(): number[] {
  const rows = unbackedProfileItemsStmt.all() as unknown as { item_id: number }[];
  return rows.map((r) => r.item_id);
}

// The whole slot profile for one item, used to find where its best sell slot is.
const profileForItemStmt = db.prepare(
  `SELECT * FROM item_slot_profile WHERE item_id = ? ORDER BY slot ASC`,
);

export function getSlotProfile(itemId: number): SlotProfileRow[] {
  return profileForItemStmt.all(itemId) as unknown as SlotProfileRow[];
}

// Every profiled item's row for one slot, joined to live prices -- the input to the
// "best item to buy right now" ranking.
const itemsAtSlotStmt = db.prepare(`
  SELECT p.item_id, p.slot, p.buy_deviation, p.sell_deviation, p.buy_price, p.sell_price,
         p.volume, p.days, p.updated_at,
         i.name, i.icon, i.buy_limit,
         s.high, s.low
  FROM item_slot_profile p
  JOIN items i ON i.id = p.item_id
  LEFT JOIN latest_snapshot s ON s.item_id = p.item_id
  -- §14.45: a stale profile was ranked exactly like a fresh one. Items that drop out of the
  -- top-liquidity refresh list never update, so 109 of them were being recommended on 9-day-old
  -- patterns paired with today's prices. Freshness is now a condition of being ranked at all.
  WHERE p.slot = ? AND p.buy_deviation IS NOT NULL AND p.updated_at >= ?
`);

export interface ItemAtSlot {
  item_id: number;
  slot: number;
  buy_deviation: number;
  sell_deviation: number | null;
  buy_price: number | null;
  sell_price: number | null;
  volume: number;
  days: number;
  updated_at: number;
  name: string;
  icon: string | null;
  buy_limit: number | null;
  high: number | null;
  low: number | null;
}

export function getItemsAtSlot(slot: number, freshSince: number): ItemAtSlot[] {
  return itemsAtSlotStmt.all(slot, freshSince) as unknown as ItemAtSlot[];
}

// Drop profiles stale beyond any usefulness, so the table doesn't grow forever with items that
// fell out of the refresh list and will never be updated again.
const pruneProfilesStmt = db.prepare(`DELETE FROM item_slot_profile WHERE updated_at < ?`);

export function pruneStaleSlotProfiles(olderThan: number): number {
  return Number(pruneProfilesStmt.run(olderThan).changes);
}

// Candidates for profiling: the most liquid items, since a time-of-day pattern on something
// that trades twice a day is noise, and each item costs one API request to profile.
const liquidItemsStmt = db.prepare(`
  SELECT s.item_id
  FROM latest_snapshot s JOIN items i ON i.id = s.item_id
  WHERE s.high IS NOT NULL AND s.low IS NOT NULL
  ORDER BY MIN(COALESCE(s.vol_high_1h, 0), COALESCE(s.vol_low_1h, 0)) DESC
  LIMIT ?
`);

export function getMostLiquidItemIds(limit: number): number[] {
  const rows = liquidItemsStmt.all(limit) as unknown as { item_id: number }[];
  return rows.map((r) => r.item_id);
}

// A second candidate track, ranked by price instead of unit volume. `getMostLiquidItemIds` alone
// systematically excludes expensive PvM gear (Noxious halberd, Scythe, etc.) -- their unit
// volume (tens/hr) never competes with cheap staples (runes, food, potions -- thousands/hr), even
// though a handful of trades on a 30m+ item moves far more real gp than a thousand rune trades.
// Still requires *some* real trading (both sides >= minVolume/hr) so a genuinely dead collectible
// doesn't get profiled on noise.
const highValueItemsStmt = db.prepare(`
  SELECT s.item_id
  FROM latest_snapshot s JOIN items i ON i.id = s.item_id
  WHERE s.high IS NOT NULL AND s.low IS NOT NULL
    AND MIN(COALESCE(s.vol_high_1h, 0), COALESCE(s.vol_low_1h, 0)) >= ?
  ORDER BY s.high DESC
  LIMIT ?
`);

export function getHighValueItemIds(limit: number, minVolume: number): number[] {
  const rows = highValueItemsStmt.all(minVolume, limit) as unknown as { item_id: number }[];
  return rows.map((r) => r.item_id);
}
