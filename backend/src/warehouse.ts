import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";
import { existsSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const warehousePath = path.join(__dirname, "..", "warehouse.duckdb");
const walPath = `${warehousePath}.wal`;

// DESIGN.md §11.1: DuckDB as a second, analytics-only embedded database alongside the existing
// node:sqlite (db.ts) -- no server process, embeds directly in-process, built for the OLAP-style
// aggregate/scan queries "quant calculations" actually are. node:sqlite stays the system of record
// for live/operational state (latest_snapshot, price_history, bank imports, recommendation
// snapshots); this file is purely for historical rollups and future analytical tables that don't
// need row-level transactional writes every poll cycle.
let connectionPromise: Promise<DuckDBConnection> | null = null;

async function initSchema(conn: DuckDBConnection): Promise<void> {
  // Daily OHLC-style rollup of price_history -- the concrete first use of the warehouse, and
  // the "real change" half of §11.2's Fix 2 (schema-split by cadence): raw 60s ticks stay in
  // SQLite's price_history for a short retention window, this table is the durable long-term
  // record once a day is fully rolled up, at a fraction of the row count.
  await conn.run(`
    CREATE TABLE IF NOT EXISTS price_daily (
      item_id INTEGER,
      day DATE,
      open_high INTEGER,
      close_high INTEGER,
      min_high INTEGER,
      max_high INTEGER,
      open_low INTEGER,
      close_low INTEGER,
      min_low INTEGER,
      max_low INTEGER,
      avg_volume DOUBLE,
      sample_count INTEGER,
      PRIMARY KEY (item_id, day)
    )
  `);

  // DESIGN.md §6.4 / §11.3 item 2: official patch notes (populated by news.ts's RSS poller) and,
  // eventually, historical-analog reasoning -- a compact events table Claude can be handed
  // directly in-context, no vector DB needed at this scale (§11.1). `tags` stays unpopulated for
  // now (Claude's item-linking job, §9, blocked on Anthropic API billing as of this pass).
  await conn.run(`CREATE SEQUENCE IF NOT EXISTS events_id_seq`);
  await conn.run(`
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY DEFAULT nextval('events_id_seq'),
      event_date DATE,
      title TEXT,
      summary TEXT,
      source TEXT,
      tags TEXT
    )
  `);
  await conn.run(`ALTER TABLE events ADD COLUMN IF NOT EXISTS link TEXT`);

  // DESIGN.md §11.3 item 3: Reddit/Discord mention velocity, once the Python sidecar (§11.3.1)
  // is collecting. Schema only for now -- nothing populates it yet, no collector exists.
  await conn.run(`
    CREATE TABLE IF NOT EXISTS attention_metrics (
      item_id INTEGER,
      day DATE,
      source TEXT,
      mention_count INTEGER,
      PRIMARY KEY (item_id, day, source)
    )
  `);
}

async function openWarehouse(): Promise<DuckDBConnection> {
  const instance = await DuckDBInstance.create(warehousePath);
  const conn = await instance.connect();
  await initSchema(conn);
  return conn;
}

// Self-healing: this warehouse is a purely derived analytical cache (price rollups regenerate
// from SQLite's price_history, news re-fetches from the RSS feed) -- nothing in it is a source
// of truth. A WAL replay failure (seen live under this dev environment's shared, frequently
// hot-reloading server -- root cause not fully pinned down, but not worth chasing further given
// the data is disposable) should never take down every route that touches the warehouse. If
// opening fails, delete both files and try once more against a guaranteed-fresh database instead
// of surfacing a 500 to every caller until someone notices and manually intervenes.
async function createConnection(): Promise<DuckDBConnection> {
  try {
    return await openWarehouse();
  } catch (err) {
    console.error(
      "[warehouse] failed to open, rebuilding from scratch (disposable analytical cache):",
      err,
    );
    if (existsSync(warehousePath)) rmSync(warehousePath, { force: true });
    if (existsSync(walPath)) rmSync(walPath, { force: true });
    return await openWarehouse();
  }
}

export function getWarehouseConnection(): Promise<DuckDBConnection> {
  if (!connectionPromise) connectionPromise = createConnection();
  return connectionPromise;
}

// DESIGN.md §14.9: WAL replay has failed after a rapid hot-reload restart under tsx watch, most
// likely because the previous process's WAL never got checkpointed before it died. Explicitly
// checkpointing and closing on shutdown gives DuckDB a clean exit point instead of relying on the
// OS to flush an open file handle in time.
export async function closeWarehouse(): Promise<void> {
  if (!connectionPromise) return;
  try {
    const conn = await connectionPromise;
    await conn.run("CHECKPOINT");
    conn.disconnectSync();
  } catch {
    // best-effort -- if the connection was already broken there's nothing to clean up
  }
}

export interface PriceDailyRow {
  item_id: number;
  day: string; // YYYY-MM-DD
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

export async function upsertPriceDaily(rows: PriceDailyRow[]): Promise<void> {
  if (rows.length === 0) return;
  const conn = await getWarehouseConnection();
  const stmt = await conn.prepare(`
    INSERT INTO price_daily
      (item_id, day, open_high, close_high, min_high, max_high, open_low, close_low, min_low, max_low, avg_volume, sample_count)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (item_id, day) DO UPDATE SET
      open_high = excluded.open_high, close_high = excluded.close_high,
      min_high = excluded.min_high, max_high = excluded.max_high,
      open_low = excluded.open_low, close_low = excluded.close_low,
      min_low = excluded.min_low, max_low = excluded.max_low,
      avg_volume = excluded.avg_volume, sample_count = excluded.sample_count
  `);
  await conn.run("BEGIN TRANSACTION");
  try {
    for (const r of rows) {
      stmt.bind([
        r.item_id,
        r.day,
        r.open_high,
        r.close_high,
        r.min_high,
        r.max_high,
        r.open_low,
        r.close_low,
        r.min_low,
        r.max_low,
        r.avg_volume,
        r.sample_count,
      ]);
      await stmt.run();
    }
    await conn.run("COMMIT");
  } catch (err) {
    await conn.run("ROLLBACK");
    throw err;
  }
}

// The rollup job's resume point: the most recent day already written, so each run only needs
// to process what's new since last time rather than rescanning all of price_history.
export async function getLastRolledDay(): Promise<string | null> {
  const conn = await getWarehouseConnection();
  const reader = await conn.runAndReadAll(`SELECT MAX(day) AS d FROM price_daily`);
  const row = reader.getRowObjectsJson()[0] as { d: string | null } | undefined;
  return row?.d ?? null;
}

export interface EventRow {
  event_date: string; // YYYY-MM-DD
  title: string;
  summary: string;
  source: string;
  link: string | null;
  tags: string | null;
}

// DESIGN.md §14.37: DEAD CODE -- do not use, and do not import from here. Events now live in
// SQLite (db.ts). Kept only briefly for reference; two bugs made this version unsafe:
//   1. This warehouse is a disposable, self-rebuilding cache (createConnection() deletes and
//      recreates it on WAL replay failure). Fine for price rollups and official news (Jagex's
//      RSS is an archive), fatal for Reddit -- its top-of-day feed is a rolling window, so a
//      rebuild silently and permanently lost every Reddit post ever fetched.
//   2. The "already seen" set below hardcodes `source = 'official'`, so any other source was
//      deduped against the wrong rows and re-inserted on every single poll.
// The SQLite replacement enforces dedup with a UNIQUE(source, title, event_date) constraint,
// which cannot drift from the query that reads it.
export async function insertNewEventsDEPRECATED(rows: EventRow[]): Promise<number> {
  if (rows.length === 0) return 0;
  const conn = await getWarehouseConnection();
  const existing = await conn.runAndReadAll(
    `SELECT title, CAST(event_date AS VARCHAR) AS event_date FROM events WHERE source = ?`,
    ["official"],
  );
  const seen = new Set(
    (existing.getRowObjectsJson() as { title: string; event_date: string }[]).map(
      (r) => `${r.title} ${r.event_date}`,
    ),
  );

  const stmt = await conn.prepare(`
    INSERT INTO events (event_date, title, summary, source, link, tags)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  let inserted = 0;
  for (const r of rows) {
    if (seen.has(`${r.title} ${r.event_date}`)) continue;
    stmt.bind([r.event_date, r.title, r.summary, r.source, r.link, r.tags]);
    await stmt.run();
    inserted++;
  }
  return inserted;
}

export interface EventRecord {
  id: number;
  event_date: string;
  title: string;
  summary: string;
  source: string;
  link: string | null;
  tags: string | null;
}

// DESIGN.md §14.37: DEAD CODE -- see insertNewEventsDEPRECATED above. Use db.ts's getRecentEvents.
export async function getRecentEventsDEPRECATED(limit: number): Promise<EventRecord[]> {
  const conn = await getWarehouseConnection();
  const reader = await conn.runAndReadAll(
    `SELECT id, CAST(event_date AS VARCHAR) AS event_date, title, summary, source, link, tags
     FROM events ORDER BY event_date DESC, id DESC LIMIT ?`,
    [limit],
  );
  return reader.getRowObjectsJson() as unknown as EventRecord[];
}

export interface DailyPriceAsOf {
  item_id: number;
  close_high: number | null;
}

// DESIGN.md §10 item 9 / §14.17: trend leaderboards' 7d/30d windows -- price_history (SQLite)
// only retains RAW_RETENTION_DAYS (3) of raw ticks, so anything beyond that has to come from
// this warehouse's daily rollup instead. Most recent day at or before `cutoffDay` per item (not
// necessarily the exact day -- an item might not have traded that specific date), so a thinly
// traded item still gets a fair "closest available" comparison point rather than being dropped.
export async function getPriceDailyAsOf(cutoffDay: string): Promise<DailyPriceAsOf[]> {
  const conn = await getWarehouseConnection();
  const reader = await conn.runAndReadAll(
    `
    WITH ranked AS (
      SELECT item_id, close_high,
             ROW_NUMBER() OVER (PARTITION BY item_id ORDER BY day DESC) AS rn
      FROM price_daily
      WHERE day <= ?
    )
    SELECT item_id, close_high FROM ranked WHERE rn = 1
  `,
    [cutoffDay],
  );
  return reader.getRowObjectsJson() as unknown as DailyPriceAsOf[];
}

// DESIGN.md §10 item 25 (technicalIndicators.ts): the one place classic TA indicators (SMA, EMA,
// MACD, RSI, Bollinger, ATR, trend slope) source their daily series from -- price_daily is the
// only table that retains history indefinitely (raw price_history is pruned to a few days,
// §11.2 Fix 2), so anything needing more than a handful of days has to come from here.
export async function getPriceDailyForItem(itemId: number, days: number): Promise<PriceDailyRow[]> {
  const conn = await getWarehouseConnection();
  const reader = await conn.runAndReadAll(
    `
    SELECT item_id, CAST(day AS VARCHAR) AS day, open_high, close_high, min_high, max_high,
           open_low, close_low, min_low, max_low, avg_volume, sample_count
    FROM price_daily
    WHERE item_id = ?
    ORDER BY day DESC
    LIMIT ?
  `,
    [itemId, days],
  );
  const rows = reader.getRowObjectsJson() as unknown as PriceDailyRow[];
  return rows.reverse(); // oldest first -- every indicator below expects chronological order
}

export interface WarehouseStatus {
  priceDailyRows: number;
  priceDailyItems: number;
  eventsRows: number;
  attentionRows: number;
  lastRolledDay: string | null;
}

export async function getWarehouseStatus(): Promise<WarehouseStatus> {
  const conn = await getWarehouseConnection();
  // Sequential, not Promise.all -- issuing overlapping queries on one DuckDB connection isn't a
  // safe pattern (a single connection handles one active statement at a time), and this endpoint
  // is polled often enough (every /api/status call) that it's worth not risking it.
  const priceDaily = await conn.runAndReadAll(
    `SELECT COUNT(*) AS c, COUNT(DISTINCT item_id) AS items FROM price_daily`,
  );
  const events = await conn.runAndReadAll(`SELECT COUNT(*) AS c FROM events`);
  const attention = await conn.runAndReadAll(`SELECT COUNT(*) AS c FROM attention_metrics`);
  const pd = priceDaily.getRowObjectsJson()[0] as { c: number; items: number };
  const ev = events.getRowObjectsJson()[0] as { c: number };
  const am = attention.getRowObjectsJson()[0] as { c: number };
  return {
    priceDailyRows: Number(pd.c),
    priceDailyItems: Number(pd.items),
    eventsRows: Number(ev.c),
    attentionRows: Number(am.c),
    lastRolledDay: await getLastRolledDay(),
  };
}
