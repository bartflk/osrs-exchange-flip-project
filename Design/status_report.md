# OSRS Flip Assistant — Status Report

*As of 2026-08-04. Full detail lives in DESIGN.md — this is the condensed view.*

## Built and verified live

| Area | What | Notes |
|---|---|---|
| **Core dashboard** | Market table, Buy Signals, Watchlist, item detail modal w/ zoomable chart | v0/v1, done |
| **GE tax** | 2% (corrected from stale 1%), capped, waived under 50gp | §3 |
| **Bank import** | Clipboard TSV paste, tax-adjusted valuation, import history | §6.5, built ahead of schedule |
| **Actions tab** | Sell suggestions, fresh buy candidates, manual GE-offer tracking | §6.6 |
| **Settings** | Mute toggles, refresh interval, min-liquidity default | §6.7 |
| **Crash/spike alerts** | Market-wide, 10-min window, cooldown, live-caught & fixed 2 false-positive bugs | §11.3 item 5 |
| **Manipulation detector** | Volume z-score vs 24h baseline, correctly silent until enough history exists | §11.3 item 6 |
| **Recommendation scorekeeping** | Logs top-10 picks every 30min, resolves 4h later, currently 58% win rate on 14/24 resolved | §10 item 1 |
| **DuckDB warehouse** | Second embedded DB for analytics; daily price rollup + 3-day raw retention | §11.1/§11.2 |
| **Python sidecar scaffold** | FastAPI, health-checked from Node, Reddit/Discord routes stubbed | §11.3.1 |
| **Official news feed** | RSS ingestion into DuckDB, chronological UI, 15 real items live | §6.4 (partial — see below) |
| **Capital Allocator** | Greedy 8-slot allocator, validated against Gielinor Gains' shipped "Planner" | §11.3 item 7 |

## Built but blocked

| Area | Status | Blocker |
|---|---|---|
| **Claude integration** | Backend done (`/api/items/:id/explain`), typechecks clean | Anthropic API has no credit balance — separate billing from any claude.ai/Claude Code subscription. Add a few dollars in Console -> Plans & Billing, then it's a one-command verify. |

## Explicitly not started (needs your legwork, not more code)

| Area | What's needed |
|---|---|
| **Reddit sentiment** (§6.4) | 2-4 week Reddit API app pre-approval |
| **Discord monitoring** (§11.3.1) | A prepped self-bot account, joined to target trading servers |
| **Historical-analog reasoning** (§11.3 item 2) | Needs Claude (blocked above) -- `events` table already has real data to reason over once unblocked |

## New backlog from competitor research (§4.3, not started)

Sourced from a live pass on runebergterminal.com + gnomestreet.com, and the full r/OSRSflipping "Flipping Resource Megathread":

1. Multi-window trend leaderboards (1h/4h/12h/24h/7d/30d biggest movers) -- Runeberg Terminal
2. Tiered/named alert severity ("High Profit >=380k" vs raw %) -- Runeberg Terminal
3. Manual "I took this flip" confirmation -- Gnome Street
4. Calibrated EV via measured realization ratio -- Quant Terminal. Highest-value idea found: use this app's own Track Record data to discount displayed projected profits, not just report win rate separately.
5. Execution-quality/fill modeling -- Quant Terminal (speculative, lower priority)
6. Bank value history / net worth chart over time -- several tools' portfolio views

## Explicitly out of scope

Regime detection, statistical arbitrage, trained ML prediction models, knowledge graphs -- all considered against the V6/V7 quant-platform brainstorm and rejected as disproportionate for a local single-user tool (§11.3 item 9).

## Recommended next step

Fund the Anthropic account (cheapest, unblocks the single biggest stated-purpose gap) -> verify -> build the Claude UI in the item modal. In parallel, backlog item #4 above (calibrated EV) is buildable today with zero blockers once Track Record has more resolved data.
