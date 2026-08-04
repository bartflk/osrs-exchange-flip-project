# OSRS Flip Assistant — prototype

v0/v1 prototype per [DESIGN.md](DESIGN.md). Pulls live OSRS Grand Exchange prices from the
[Wiki Real-time Prices API](https://prices.runescape.wiki/), computes tax/limit-adjusted net
margin + liquidity scoring, and shows it in a dark glass dashboard. No Claude integration yet,
no sentiment/news tab yet (deferred — see DESIGN.md §13).

## Requirements

- Node.js 24+ (installed via `winget install OpenJS.NodeJS.LTS`) — ships a built-in `node:sqlite`
  module, so there's no native build toolchain needed for the database.

## Run it

Two processes, each in its own terminal:

```bash
cd backend
npm install   # first time only
npm run dev
```

```bash
cd frontend
npm install   # first time only
npm run dev
```

Backend listens on `http://127.0.0.1:3001` and starts polling the Wiki API immediately
(mapping once at boot + daily, prices every 60s). Frontend dev server runs on
`http://localhost:5173` and proxies `/api/*` to the backend (see `frontend/vite.config.ts`).

Give the backend a minute after first boot — the item price table only has data once the
first `/latest` + `/5m` + `/1h` poll cycle completes.

## What's implemented

- **Market tab**: full sortable table of tradeable items with net margin (tax-adjusted),
  ROI%, a liquidity-weighted score, buy limit, and live price, sourced straight from the
  Wiki API. Search + min-liquidity filter.
- **Buy Signals tab**: ranked cards of the current best actionable flips (net margin > 0,
  sorted by the Market tab's score), each with a suggested buy quantity computed from a
  user-set bankroll + max-allocation-per-item %, capped by the item's buy limit, plus
  projected profit. Bankroll/allocation persist in `localStorage`. No real account/bank
  data yet (see DESIGN.md §6.5) — allocation is manual for now.
- **Watchlist tab**: pin any item from the Market tab (star icon), set an "alert above" /
  "alert below" gp threshold per item, and get a browser Notification + in-app banner the
  first time a pinned item's price crosses it (won't re-fire on every poll once triggered).
  Pinned items are fetched via `/api/items?ids=` so they stay visible even if they'd
  otherwise be filtered out by the Market tab's liquidity/search filters.
- **Bank tab**: paste a RuneLite [Bank Memory](https://github.com/Lazyfaith/runelite-bank-memory-plugin)
  TSV export (or read it straight from the clipboard) to get your real total bank value —
  confirmed working against a real ~600-item bank export (see `bankParse.ts`). Values each
  item by live GE "low" price. Genuinely untradeable items (pets, quest items, clue scrolls)
  show their real name with no GE value, not silently dropped. A small alias table
  (`backend/src/routes/bank.ts` `VALUE_ALIASES` + `nameFallbackCandidates`) catches the common
  case where a *held* item is untradeable in its charged/imbued/combined state but a specific
  or same-named base item is a known stand-in for its value (charged Bow of faerdhinen →
  Bow of faerdhinen (inactive), Toxic blowpipe → (empty), Abyssal tentacle → Abyssal whip,
  imbued combat rings `(i)` → base ring, barrows charge-state suffixes like "Ahrim's robetop
  100" → base piece) — flagged with an amber "est." badge + tooltip so it's never silently
  blended with real live prices. Note: this won't exactly match RuneLite's own in-client
  "GE value" tooltip (Bank Memory's own total, ~523M in one real test vs. our ~380M after
  fixes) — that discrepancy wasn't fully run down; it's presumably a different price source/
  methodology client-side, not something worth chasing to exact parity given our numbers are
  traceable to live GE bid/ask per item. **Multiple pastes merge** ("Parse & add to total")
  rather than overwrite, useful if Bank Memory only captures what you've viewed recently.
  **Imports persist server-side** (SQLite `bank_imports` table) — "Save snapshot to history"
  stores a permanent, timestamped record you can revisit later (foundation for a net-worth-
  over-time view). "Use as Buy Signals bankroll" writes the total into the Buy Signals tab.
- **Item detail modal**: click any item name anywhere (Market/Buy Signals/Watchlist/search) to
  open a chart (hand-rolled SVG, buy/sell lines + volume bars, no chart library dependency)
  with 6h/1d/7d/30d/6m/1y ranges via the Wiki API's `/timeseries` endpoint, plus full stats.
- **Global item lookup**: header search box (`/api/lookup`) finds *any* item by name, including
  ones with no recent trades or that don't pass the Market tab's filters — opens the same
  detail modal.
- **Update News & Sentiment tab**: placeholder — not built yet (deferred, see DESIGN.md §13).
- **Layout**: responsive up through 2K/ultrawide — content max-width and text/padding
  scale up at the `2xl` breakpoint (≥1536px) instead of staying pinned to a narrow column.

### Note on the Wiki API

The `/timeseries` endpoint's actual query parameter is `lookback` (`6h|24h|7d|30d|6m|1y`), not
`timestep` as the API's own docs implied at design time — the earlier design doc research got
this detail wrong; corrected once the real API returned `{"error":"lookback must be a valid value"}`
during implementation. Fixed in both `backend/src/wiki.ts` and DESIGN.md §2.1.

## Project layout

```
backend/
  src/
    wiki.ts       # Wiki Real-time Prices API client
    db.ts         # SQLite schema + upserts (node:sqlite, no native deps)
    poller.ts      # polling loop (mapping daily, prices every 60s)
    signals.ts     # tax calc, net margin, liquidity score
    routes/items.ts # REST API
    index.ts       # Fastify server
frontend/
  src/
    api.ts               # backend client
    format.ts             # gp/percent/time formatting
    components/MarketTable.tsx
    App.tsx               # tab shell, dark glass theme
```
