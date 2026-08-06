# Project Flashwave

A locally-run OSRS Grand Exchange flip/merchanting dashboard. Pulls live prices from the
[Wiki Real-time Prices API](https://prices.runescape.wiki/), computes tax/limit-aware net margin
and a liquidity-weighted score, and layers deterministic signals (volatility, forecast bands,
trend leaderboards, crash/spike alerts, set arbitrage, and more) on top — with an optional local
LLM for plain-language explanations and digests. Single-user, local machine only, never hosted.
Read-only with respect to the game: no auto-trading, no GE automation.

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
- **Python 3.11+** — optional, only for the Reddit/Discord sentiment sidecar (`sidecar/`), which
  is not required for anything else to work.

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

Backend listens on `http://127.0.0.1:3001` and starts polling the Wiki API immediately (item
mapping once at boot + daily refresh, prices every 60s). Frontend dev server runs on
`http://localhost:5173` (or the next free port) and proxies `/api/*` to the backend.

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
- **Buy Signals tab** — ranked actionable flips with a Capital Allocator (fills your actual GE
  slots against a bankroll, with a hold-time selector and deterministic reroll), position-sizing
  tiers (conservative/suggested/aggressive), and a "since last visit" diff of what's newly
  entered/left the list.
- **Item detail modal** — price chart with IQR forecast bands, per-item track record, an
  LLM-generated "explain the pick" rationale + risk note.
- **Watchlist / Blocklist** — pin items for threshold alerts, or permanently exclude items from
  recommendations.
- **Bank tab** — paste a RuneLite Bank Memory export for real bank valuation, snapshot history,
  net-worth-over-time chart.
- **Actions tab** — Open GE offers with live reprice/cancel guidance and fill tracking ("I bought
  it"), a bankstand/session planner (Wise Old Man integration) suggesting AFK activities while
  trades are open.
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
    db.ts, warehouse.ts        # SQLite (operational) + DuckDB (analytical rollups)
    signals.ts, volatility.ts, forecast.ts   # scoring, volatility, IQR forecast bands
    alerts.ts, trends.ts, substitutions.ts   # crash/spike alerts, leaderboards, lag flags
    scorekeeping.ts, trackRecordHorizons.ts  # recommendation logging + outcome resolution
    capitalAllocator.ts (frontend), setArbitrage.ts, sessionPlanner.ts, wiseoldman.ts
    llm.ts, researchReport.ts  # LLM client (OpenAI-compatible) + daily/weekly digest
    routes/                    # REST API, one file per feature area
frontend/
  src/
    api.ts, format.ts          # backend client, gp/percent/time formatting
    components/                # one component per tab/widget
    capitalAllocator.ts, positionSizing.ts, repriceGuidance.ts, signalsDiff.ts   # pure logic, no backend
    App.tsx                    # tab shell
sidecar/
  main.py, collectors/         # optional FastAPI sentiment collector (Reddit/Discord)
Design/
  DESIGN.md                    # the actual design doc — goals, architecture, full build log
```
