# Project Flashwave

A locally-run OSRS Grand Exchange flip/merchanting dashboard. Pulls live prices from the
[Wiki Real-time Prices API](https://prices.runescape.wiki/), computes tax/limit-aware net margin
and a liquidity-weighted score, and layers deterministic signals (volatility, forecast bands,
trend leaderboards, crash/spike alerts, set arbitrage, and more) on top — with an optional local
LLM for plain-language explanations and digests.

It also reads **your own trades** from the files a RuneLite plugin already writes to your disk, so
the GE board, your portfolio, session profit and flip history are your real numbers rather than
hand-entered ones — see [Reading your GE offers](#reading-your-ge-offers).

Single-user, local machine only, never hosted. Read-only with respect to the game: it observes and
reports, it never acts. No auto-trading, no GE automation, no input of any kind.

Full design/reasoning: [Design/DESIGN.md](Design/DESIGN.md).

## Requirements

- **Node.js 24+** — ships a built-in `node:sqlite` module, so no native build toolchain is needed
  for the database. (`winget install OpenJS.NodeJS.LTS` on Windows.)
- **[Ollama](https://ollama.com/)**, running locally, with a model pulled — needed for every LLM
  feature (item "Explain the pick," the daily/weekly research digest, Settings → Test LLM). The
  app runs fine without it; those specific features will just fail until Ollama is up.
  ```bash
  ollama pull qwen3:14b
  ollama serve   # or just open the Ollama app -- it runs its own server automatically
  ```
  Any OpenAI-compatible endpoint works instead (OpenAI, Anthropic's compat endpoint, a different
  local model, etc.) — see `backend/.env.example`.
- **[RuneLite](https://runelite.net/) + the Flipping Copilot plugin** — needed for anything that
  shows *your* trades (GE board, Portfolio, Session, Flips). Must be the **same machine** the
  backend runs on, since it reads the plugin's files directly. Everything price-related works
  without it. Full setup below.
- **Python 3.11+** — optional, only for the Reddit/Discord sentiment sidecar (`sidecar/`), which
  is not required for anything else to work.

## Reading your GE offers

Everything that shows *your* trading — the GE board, Portfolio, Session, Flips, Visualize flip,
Missed flips, and the Capital Allocator's free-slot/buy-limit awareness — comes from files a
RuneLite plugin already writes to your own disk. **The app reads those files; it never touches the
game client.** There is nothing to configure, no API key, and no login.

### What you need

1. **[RuneLite](https://runelite.net/)** — one of the two clients on Jagex's approved list.
2. **[Flipping Copilot](https://github.com/cbrewitt/flipping-copilot)** (Plugin Hub) — **required
   for live GE slots.** It writes one JSON file per GE box:
   ```
   ~/.runelite/flipping-copilot/acc_<accountHash>_0.json … _7.json
   ```
   These carry `itemId / price / totalQuantity / quantitySold / spent / state`, which is a 1:1 dump
   of RuneLite's own `GrandExchangeOffer`. Keep the plugin installed and RuneLite running while you
   trade — that's the whole setup.
3. **[Flipping Utilities](https://github.com/Flipping-Utilities/rl-plugin)** (Plugin Hub) —
   **optional, one-time.** Its `~/.runelite/flipping/<Account>.json` holds *historical* trades, which
   the backend imports once on first boot to backfill flips from before you started tracking.
   Copilot has no local history (its trade log is server-side), so this is the only way to seed the
   past. After the import you can uninstall it; the data is already in SQLite.

On Windows those paths are under `%USERPROFILE%\.runelite\`; macOS/Linux use `~/.runelite/`.

### How capture works

The backend reads the slot files every 20 seconds. A slot's `quantitySold` only ever increases, so
when the same offer is seen twice with a higher figure, the difference **is** a fill — recorded at
the price actually paid (`Δspent / Δquantity`), not your offer price.

Two honest limitations, both by design:

- **Offers already part-filled when you first run the app are not backdated.** Those units carry no
  information about *when* they filled, and inventing a timestamp would put a fake spike on the
  profit graph. Capture starts clean and the UI says "live capture since …". Anything sold from
  stock bought earlier is excluded from profit figures and listed under **Missed flips**, rather
  than counted as pure gain against a zero cost basis.
- **There's a ~20s blind spot** if a slot is emptied and refilled between two reads. Closing that
  gap is the only thing a purpose-built plugin would buy — see
  [Design/RUNELITE_PLUGIN_GUIDE.md](Design/RUNELITE_PLUGIN_GUIDE.md), which also covers why reading
  your own trade data carries no account risk (the rules target automation and combat advantage,
  not observation) and where the line actually is.

If neither plugin is installed the app still runs — the Portfolio tab just says so, and everything
price-related works exactly as before.

## Run it

### One click (Windows)

Double-click **`Start Flashwave.bat`**. That's the whole thing — it checks Node, installs
dependencies on first run, starts both servers in their own labelled windows, waits for them, and
opens the app in your browser.

It's a `.bat` rather than a `.ps1` on purpose: Windows won't run a PowerShell script on
double-click by default (the execution policy blocks it, and the shell's default action for `.ps1`
is to open Notepad). The `.bat` launches `start.ps1` with `-ExecutionPolicy Bypass`, which keeps it
to one click without changing any machine-wide setting.

- Copy `Start Flashwave.bat` to your Desktop if you want it there; it finds the project by path.
- Moved or renamed the project folder? Right-click the `.bat` → Edit and update the `PROJECT` line.
- **To stop:** close the two `Flashwave backend` / `Flashwave frontend` windows.
- Re-running while it's already up is harmless — it detects the listening ports and skips them.
- It also reports, without blocking, whether Ollama is up and whether the RuneLite GE files are
  present, so a missing optional piece is visible immediately instead of showing up later as an
  empty tab.

### Manually

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

Backend listens on `http://127.0.0.1:3001` and starts polling the Wiki API immediately (item
mapping once at boot + daily refresh, prices every 60s). Frontend dev server runs on
`http://localhost:5173` (or the next free port) and proxies `/api/*` to the backend.

### RuneLite WebSocket

The local backend also exposes `ws://127.0.0.1:3001/ws/runelite` for the companion RuneLite
plugin. It is read-only for now: the plugin can request market information, but order placement is
intentionally not part of this protocol yet.

Messages are JSON. Every request may include a `requestId`, which is echoed in its response:

```json
{ "type": "status", "requestId": "1" }
{ "type": "items", "requestId": "2", "limit": 20, "minScore": 50 }
{ "type": "buy_recommendation", "requestId": "3" }
{ "type": "item", "requestId": "4", "itemId": 4151 }
{ "type": "item_analysis", "requestId": "5", "itemId": 4151 }
{ "type": "portfolio", "requestId": "6" }
{ "type": "history", "requestId": "7", "itemId": 4151, "limit": 200 }
{ "type": "snapshot", "requestId": "8", "itemId": 4151 }
{ "type": "subscribe", "requestId": "9", "intervalMs": 60000 }
{ "type": "unsubscribe", "requestId": "10" }
```

The server sends a `hello` message immediately after connection. `status`, `items`, and `item`
return `{ "type": "response", "requestId", "ok", "data" }`. `item_analysis` adds prediction,
recommendation, profit calculations, and history for one item. `portfolio` provides positions,
live GE slots, buy-limit usage, totals, session data, and capture metadata. `history` provides
local price history, transactions, and item flips. `snapshot` delivers all Flashwave-owned data in
one response with these sections: `market`, `scoring`, `recommendations`, `portfolio`, `history`,
and optional `itemAnalysis`. A subscription sends an immediate `market_update` followed by ranked
market and recommendation updates at the requested interval, clamped to 5 seconds through 5
minutes. `buy_recommendation` returns one item with `action`, `itemId`, `itemName`, `quantity`,
`offerPrice`, `expectedSellPrice`, `expectedProfitEach`, `expectedProfitTotal`, `roiPct`, `score`,
`buyLimit`, and `marketUpdatedAt`, or `data: null` when no profitable opportunity is available.
Item payloads use the same scored shape as `GET /api/items`, including execution prices,
net margin, ROI, liquidity, and score.

Give the backend a minute after first boot — tables only have data once the first poll cycle
completes.

### LLM setup (optional but recommended)

The backend talks to whatever's configured in `backend/.env` (copy `backend/.env.example` to get
started — it's gitignored, so your local config never gets committed). Defaults to a local Ollama
instance at `http://localhost:11434/v1` running `qwen3:14b`. To use a different model or provider,
edit `LLM_MODEL`/`LLM_BASE_URL`/`LLM_API_KEY` in `.env`. Verify the connection any time from
**Settings → LLM / AI → Test LLM** in the app — it pings the model and shows the model name,
latency, and reply, or the exact error if something's misconfigured.

### Sentiment sidecar (optional)

```bash
cd sidecar
python -m venv .venv && .venv\Scripts\activate   # or source .venv/bin/activate on macOS/Linux
pip install -r requirements.txt
uvicorn main:app --port 8000
```
Reddit/Discord collection additionally needs `REDDIT_CLIENT_ID`/`REDDIT_CLIENT_SECRET`/
`REDDIT_USER_AGENT` or `DISCORD_SELF_BOT_TOKEN` env vars — neither is required for the sidecar or
main app to run; `/health` reports what's configured. The backend polls this only opportunistically
and never depends on it being up.

## What's implemented

Actively developed — see [Design/DESIGN.md](Design/DESIGN.md) §14 for the full, dated build log
and §10 for what's still on the backlog. Highlights as of the latest pass:

- **Market tab** — full sortable/filterable item table (net margin, ROI%, liquidity score, buy
  limit, volatility), trend leaderboards (1h-30d movers), substitution-lag flags, crash/spike
  alerts with tiered severity.
- **Signals tab** — a **live GE board**: eight boxes in the same 4×2 layout as the in-game Grand
  Exchange, so slot 3 on screen is slot 3 in the game. Occupied boxes show your real offer with a
  fill bar and a verdict — *Collect* / *Cancel* / *Reprice* (with the target price) / *Filling* /
  *Waiting* — and only the ones needing a decision light up. Empty boxes carry the Capital
  Allocator's next suggestion, sized against your **remaining** 4h buy limit and the cash not
  already committed to open offers. Plus position-sizing tiers and a "since last visit" diff.
- **Item detail modal** — price chart with IQR forecast bands, per-item track record, an
  LLM-generated "explain the pick" rationale + risk note.
- **Portfolio tab** — what you're actually holding, derived from your real trade ledger: quantity,
  average buy, market value and unrealised profit *net of GE tax*, plus a session tracker
  (profit, flips made, GP/hr, ROI) and a net-worth-over-time chart.
- **Flips tab** — completed flips paired FIFO with real tax and ROI; the raw transaction stream;
  **Visualize flip**, which draws your own buys and sells on the item's price chart with average
  buy/sell lines; and **Missed flips**, which surfaces trades the ledger can't fully account for
  instead of quietly inflating profit.
- **Blocklist / watchlist** — pin items for threshold alerts, or permanently exclude items from
  recommendations.
- **Bank tab** — paste a RuneLite Bank Memory export for real bank valuation, snapshot history,
  net-worth-over-time chart.
- **Actions tab** — a bankstand/session planner (Wise Old Man integration) suggesting AFK
  activities that fit your skills while trades are open.
- **Sets tab** — Grand Exchange set conversion arbitrage (combine/decombine, all curated sets)
  and Barrows repair-flip profit, both with a per-item cost/tax breakdown.
- **Update News & Sentiment tab** — official patch-note feed, an LLM-synthesized daily/weekly
  research digest grounded in the app's own Track Record/trend/alert data, and an update-cycle
  countdown badge.
- **Track Record** — the app logs its own top picks and checks back against real outcomes at
  multiple hold periods (2/3/6/12/24h) — an honest, self-graded win rate, not a marketing number.
- **Settings** — mute alert types, refresh cadence, Wise Old Man username, blocklist management,
  and an LLM connectivity test.

## Project layout

```
backend/
  src/
    index.ts, poller.ts        # Fastify server, polling loop
    runeliteWebsocket.ts       # read-only RuneLite WebSocket protocol
    db.ts, warehouse.ts        # SQLite (operational) + DuckDB (analytical rollups)
    signals.ts, volatility.ts, forecast.ts   # scoring, volatility, IQR forecast bands
    alerts.ts, trends.ts, substitutions.ts   # crash/spike alerts, leaderboards, lag flags
    scorekeeping.ts, trackRecordHorizons.ts  # recommendation logging + outcome resolution
    runeliteImport.ts          # reads the RuneLite plugins' local GE files
    geLedger.ts, flips.ts      # slot-diff -> transactions -> FIFO flips/positions/session
    setArbitrage.ts, sessionPlanner.ts, wiseoldman.ts
    llm.ts, researchReport.ts  # LLM client (OpenAI-compatible) + daily/weekly digest
    routes/                    # REST API, one file per feature area
frontend/
  src/
    api.ts, format.ts          # backend client, gp/percent/time formatting
    components/                # one component per tab/widget
    capitalAllocator.ts, geSlots.ts, positionSizing.ts, repriceGuidance.ts, signalsDiff.ts
                               # pure logic, no backend calls -- readable and testable on their own
    App.tsx                    # tab shell
sidecar/
  main.py, collectors/         # optional FastAPI sentiment collector (Reddit/Discord)
Design/
  DESIGN.md                    # the actual design doc — goals, architecture, full build log
  RUNELITE_PLUGIN_GUIDE.md     # GE-offer capture, and where the account-safety line actually is
```
