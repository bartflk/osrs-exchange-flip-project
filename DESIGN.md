# OSRS Flip Assistant — Design Doc

A locally-run web app that pulls live OSRS Grand Exchange prices, surfaces short-term margin flips and long-term "merchant" investments, and uses Claude to reason about opportunities a pure spreadsheet formula would miss.

**Status:** draft v4 — 2026-08-04 (v0/v1 built, bank import/watchlist/global lookup/Actions tab running ahead of the original roadmap, GE tax rate corrected to 2%, all-time price history added — see §13)

---

## 1. Goals / non-goals

**Goals**
- Pull real-time and historical GE price data locally, no cloud dependency for data.
- Surface two distinct opportunity classes:
  1. **Daily/short-term margin flips** — buy low, sell high within hours, small capital risk per trade, high trade frequency.
  2. **Long-term flips ("merchanting")** — hold days/weeks on items expected to appreciate from update cycles, meta shifts, seasonal demand, supply shocks.
- Use Claude to add judgment on top of quantitative filters: read patch notes / community chatter, explain *why* an item is flagged, flag risk (manipulation, dying demand, volume too thin), and rank a shortlist in plain English.
- Stay strictly **read-only** with respect to the game: fetch and display data only. Never automate GE offers or in-game input.

**Non-goals**
- No auto-trading / bot automation of the RuneLite client or game window. This crosses into Jagex ToS territory (macroing real-world trading actions) and is explicitly out of scope regardless of what's technically possible.
- Not a general portfolio tracker for other games/markets.
- Not trying to reverse-engineer or scrape the actual game client — all data comes from public APIs.

---

## 2. Data sources

### 2.1 OSRS Wiki Real-time Prices API (primary)
Built in partnership with RuneLite; sourced from aggregated real client transactions. This is what essentially every serious third-party tool (GE Tracker, Flipping Copilot, osrs-flipper, etc.) is built on.

- Base: `https://prices.runescape.wiki/api/v2/osrs`
- `/mapping` — static item metadata: `id`, `name`, `examine`, `members`, `lowalch`, `highalch`, `limit` (4h buy limit), `value`, `icon`. Fetch once, cache, refresh daily.
- `/latest[?id=]` — most recent instant buy/sell: `high`, `highTime`, `low`, `lowTime`.
- `/5m` and `/1h[?timestamp=]` — windowed averages with `avgHighPrice`, `avgLowPrice`, `highPriceVolume`, `lowPriceVolume`. This is where real volume/liquidity signal comes from.
- `/timeseries?id=&lookback={6h|24h|7d|30d|6m|1y}` — historical series per item, used for trend/volatility calculations and charts. (Corrected during implementation: the API takes a `lookback` window, not a `timestep` — the server picks its own point granularity for that window and doesn't guarantee it.)
- `/24h` — daily rollups.

**Requirements:** no API key, but a descriptive `User-Agent` header is mandatory (e.g. `osrs-flip-assistant/0.1 - contact: <email or discord>`); default library user agents get blocked. No published hard rate limit, but poll on a sane interval (e.g. every 60s for `/latest`, every 5 min for `/5m`) rather than hammering it — this is a community-run service, be a good citizen, coordinate in the Wiki Discord `#api-discussion` if scaling up.

Docs: [RuneScape:Real-time Prices](https://oldschool.runescape.wiki/w/RuneScape:Real-time_Prices), [FAQ](https://prices.runescape.wiki/osrs/faqs)

### 2.2 Official Jagex GE API (secondary, low value)
`https://secure.runescape.com/m=itemdb_oldschool/api/...` — `catalogue/category.json`, `graph/{itemId}.json` (daily history ~180 days), `info.json`. Coarse (daily) granularity and only covers "categorized" items. Not worth building around, but useful as a redundant historical daily-price cross-check if the Wiki timeseries endpoint ever has gaps.

### 2.3 weirdgloop Exchange History API — the real answer to "history older than 1 year" (**built**)
The Wiki Real-time Prices API's own `/timeseries` endpoint caps at `lookback=1y` — confirmed by probing the live API directly with longer values (`5y`, `all`), both return `{"error":"lookback must be a valid value"}`. True all-time history (back to each item's GE release, 2015 for the oldest items) lives on a **separate** API run by the same people (weirdgloop, who operate the OSRS Wiki):

- Base: `https://api.weirdgloop.org/exchange/history/osrs`
- `/all?id={itemId}` — full daily history since release. Confirmed live: item 4151 (Abyssal whip) returns 4,076 daily points from 2015-03-28 to today. Payload: `{"<id>": [{"id","price","volume","timestamp"}]}`, `timestamp` in **milliseconds**. `volume` is `null` before RuneLite-sourced volume tracking began partway through the series.
- `/last90d?id=` and `/sample?id=` also exist (recent daily-ish window, and a sparse weekly-sampled overview respectively) — not currently used, `/all` covers both use cases.
- **Critical limitation, not a bug to fix**: this dataset only ever tracked **one blended daily price**, never a separate buy/sell (high/low) spread — that split is a Real-time Prices API concept that didn't exist yet when this history starts. Any "all-time chart" built from this data is necessarily a single line, not the usual two-line buy/sell chart.
- Same courtesy rules as §2.1: descriptive `User-Agent` header, no published hard rate limit but don't hammer it.
- **Built**: `backend/src/wiki.ts`'s `fetchAllTimeHistory()`, exposed through the existing `/api/items/:id/timeseries?lookback=all` route (reshaped into the same point shape the frontend already consumed, with a `blended: true` flag), rendered by `PriceChart.tsx` as a single line + neutral-gray volume bars instead of the usual green/red split.

### 2.4 Out-of-band signal (Claude's job, not an API)
Patch notes / update blog RSS, GE-affecting content changes, community chatter (Reddit r/2007scape, RunescapeFlipping). No structured API for this — Claude reads it, not a cron job.

---

## 3. Constraints the design must respect

- **4-hour rolling buy limits** per item (`limit` field from `/mapping`). Any flip recommendation must show remaining-limit-aware max position size, not just "buy X" with no ceiling.
- **2% GE tax on sales** (introduced at 1% in the Dec 2021 "GE Tax & Item Sink" update, **doubled to 2% on 2025-05-29** in the "Yama CAs & More!" update — verified live against the OSRS Wiki's Grand Exchange page during this pass, since the app's own `geTax()` was still hardcoded at the stale 1% rate until now, silently under-stating every net margin in the app by roughly half the tax amount). Tax rounds down to the nearest whole number, which waives it under 50gp (was under 100gp at the 1% rate — the exemption threshold moves with the rate, it isn't a fixed rule). Capped at 5,000,000gp tax per sale. A curated whitelist of exempt items also exists regardless of price (bonds, teleport tablets, charged jewelry, basic tools, low-level food/ammo/potions — see the Wiki page for the full list) — **not modeled** in `geTax()`, which is price-threshold-only; this needs a maintained item-id list, not a rate change, and net margin will slightly under-state profit on that specific whitelist until it's added. Net margin calculations must subtract this, not just quote raw high−low spread.
- **8 GE slots max** — long-term/short-term recommendation lists should respect a configurable "how many slots do you have free" constraint so suggestions aren't unusable.
- **Jagex Rules of RuneScape**, Rule 7 bans macroing/automation of gameplay and real-world trading. Pure price-fetch-and-display tools (GE Tracker, the Wiki price viewer itself) are the established safe category; this app must stay in that category — no auto-placing offers, no client injection, no input automation. Worth stating explicitly in the app's own README/UI disclaimer.

---

## 4. Where the edge actually is

Talking to the existing ecosystem (GE Tracker, Flipping Copilot, osrs-flipper, Flipping Utilities plugin, r/RunescapeFlipping discussion), the "edge" isn't in having data others don't — everyone reads the same Wiki API. It's in:

1. **Better filtering than raw margin-sort.** Most flip-finder sites just sort by `margin %` or `margin × volume`, which surfaces items with 2 total trades and one outlier price (worthless). Real edge = weighting by *sustained* volume across multiple windows (5m + 1h + 24h agreement), buy-limit-adjusted realistic position size, and spread stability (variance of the spread over the last N windows, not just current snapshot).
2. **Tax- and limit-aware net profit**, computed correctly, not just gross spread — cheap to get right, and a lot of hobby tools get it subtly wrong.
3. **Narrative/context reasoning for long-term flips**, which quant filters alone can't do: "an update dropped yesterday that changed demand for X," "this item's price is trending because of a meta shift," "float glass demand usually rises before X seasonal event." This is squarely Claude's job — feed it recent price trend + patch note / Reddit context for shortlisted items and have it write a rationale + risk flag, not invent numbers.
4. **Personalization**: bankroll size, GE slots free, risk tolerance, time horizon — the plugins (Flipping Copilot) do this for margin flips already inside the game; a local dashboard can do it for long-term picks too, which nothing on the market currently does well.
5. **Anomaly/manipulation detection**: flag items with sudden spread/volume anomalies vs their own trailing baseline (possible pump activity) so you avoid the trap rather than chase it.

No tool in the research turned up a serious open, well-maintained "AI reasoning layer on top of GE data" for long-term merchanting — that's a real gap, not a saturated space.

### 4.1 How the competitors actually work internally (confirmed)

Dug into this specifically since it changes what's worth copying vs. building fresh:

- **GE Tracker** — no published scoring formula anywhere (site, guides, forums, GitHub). Their own copy just says Flip Finder surfaces "margins for high price items, and lower priced high volume items" with custom filters. Charts are marketed as built on "5-minute data" ("the most accurate of all merchanting sites") but exact chart mechanics (candlestick vs. line, overlays) aren't documented in text — worth a manual look at a live item page before finalizing chart design, since specifics couldn't be confirmed via automated fetch. **Their ranking logic is a trade secret**, not a documented algorithm — nothing to literally "copy," only the general UX pattern (filterable table + item detail chart).
- **Flipping Copilot** — the client is open source, but the actual suggestion brain is a **closed backend service**. The plugin just ships an `AccountStatus` (inventory, gp, active offers, preferences) to a `POST /suggestion` endpoint and renders back one of buy/sell/wait/abort with qty/price/profit. Whether the backend model is ML or heuristic is undisclosed. Confirms: personalized, account-state-aware suggestions are valuable enough that a paid product exists purely for that — reinforces building bankroll/slots-aware personalization from day one (§4 point 4).
- **Flipping Utilities** (fully OSS, 50k+ users) — tracks real trade history client-side (`AccountData`/`FlippingItem`/`OfferEvent` models), shows a per-offer flip log + live realized profit + margin-check quick-fill. This is the "track what I actually did" pattern, distinct from "recommend what to do" — worth adopting as a v3+ feature (log actual trades locally, compare against what the app suggested, to self-grade the recommendation engine).
- **07Flip** is the one tool that publishes an actual weighted formula (self-reported, not verified): volume 40%, volatility 30%, spread% 20%, data freshness 10%. Reasonable starting weights to prototype against for the short-term score in §7.
- **No tool found** (including GE Tracker) automatically links a specific patch note to "this update affects item X." Discord bots like PatchBot just relay patch notes verbatim with no item-impact analysis. **This is a confirmed, real gap** — the update-news-to-item-suggestion tab in §6 has no real competitor doing it well today.

---

## 5. Architecture

```
┌───────────────────────────────────────────────────────────────────────┐
│  Browser (local) — dark glass UI, see §6                               │
│  Tabs: Market / Buy Signals / Watchlist / Update News & Sentiment       │
└───────────────▲───────────────────────────┬─────────────────────────────┘
                 │ REST/WS                   │
┌────────────────┴───────────────────────────┴─────────────────────────┐
│  Local backend (Node/TS)                                              │
│                                                                          │
│  ┌───────────────┐  ┌────────────────┐  ┌─────────────────┐          │
│  │ Price poller  │→ │ SQLite/DuckDB  │→ │ Signal engine    │          │
│  │ (Wiki API)    │  │ (mapping,      │  │ (margin, vol,    │          │
│  │ 60s/5m cron   │  │  latest, 5m/1h,│  │  stability,      │          │
│  └───────────────┘  │  timeseries)   │  │  limit-adjusted  │          │
│                      └───────▲────────┘  │  net profit)     │          │
│                              │            └────────┬────────┘          │
│  ┌───────────────┐          │                     │                   │
│  │ News/sentiment │──────────┘          ┌──────────▼────────┐          │
│  │ collector      │                      │ Claude layer       │          │
│  │ - OSRS RSS     │─────────────────────▶│ - daily digest      │          │
│  │   (daily cron) │                      │ - rank shortlist    │          │
│  │ - Reddit PRAW  │─────────────────────▶│ - write rationale    │          │
│  │   (daily cron) │                      │ - risk flags          │          │
│  └───────────────┘                      │ - item↔update linking  │          │
│                                          │ - buy-signal qty calc   │          │
│                                          └────────────────────────┘          │
└─────────────────────────────────────────────────────────────────────────────┘
```

**Data flow**
1. Price poller fetches `/mapping` once/daily, `/latest` every ~60s, `/5m` + `/1h` on their natural cadence, `/timeseries` on demand.
2. News/sentiment collector runs once/day (not real-time — see §6.4): pulls the official OSRS RSS feed + OSRS Wiki update history, and a batch of Reddit posts/comments from r/2007scape + r/RunescapeFlipping via PRAW, filtered to a tracked item-name/keyword list.
3. Everything lands in a local embedded DB (SQLite is plenty; DuckDB if you want fast analytical queries over timeseries history).
4. Signal engine runs deterministic, cheap, no-LLM math continuously: net margin after tax, limit-adjusted max position value, ROI %, volume-weighted confidence, spread stability score. Produces ranked candidate lists — this never depends on an LLM call being available.
5. Claude is invoked in three places, always on small, bounded inputs (never the full ~4000-item catalogue): (a) once/day on the news/sentiment batch to produce the Update News digest + item links, (b) on the **top N shortlist** (~20-30 candidates) from the signal engine to write rationale/risk tags and compute suggested buy quantity, (c) ad hoc when the user asks a free-form question in the UI.
6. Frontend polls the local backend, shows a live-updating market table, a Buy Signals page, a Watchlist, and the Update News & Sentiment tab.

---

## 6. UI design

**Look & feel**: dark mode, glassmorphism — translucent panels (`backdrop-filter: blur()`) over a dark gradient/base background, subtle 1px light borders, no heavy skeuomorphism. Green (`#22c55e`-ish) for positive/buy/up, red (`#ef4444`-ish) for negative/sell/down, used consistently for price deltas, margin sign, and signal badges — this is the universal trading-app convention and it's what makes the data scannable at a glance.

**Performance/motion**: fast over flashy. No page-transition animations, no spring-bounce effects, no animated counters that delay reading a number. The only motion budget: a quick (~120-150ms) fade/opacity change when a price/row updates, and maybe a one-time subtle flash-highlight on a cell that just changed — that's it. Data tables must virtualize (TanStack Table + TanStack Virtual) since you'll have a few thousand rows in the full market view; glass/blur panels should be limited to static chrome (nav, cards, modals) rather than applied to scrolling table rows, since backdrop-filter on many moving elements is a real perf cost.

**Tabs**

1. **Market** — the "GE Tracker, but ours" tab. Full sortable/filterable item table (name, buy/sell price, margin, tax-adjusted net margin, ROI%, buy limit, volume). Clicking a row opens an item detail panel with a price/volume chart. Chart: line (buy price + sell price as two lines) with a volume bar strip beneath, time-range selector (6h/1d/7d/30d/all — mirrors what GE Tracker and the Wiki API's `/timeseries` timesteps naturally support), red/green fill between the two price lines depending on spread direction. (Note: GE Tracker's exact chart mechanics weren't confirmable from text research alone — treat "copy GE Tracker's charts" as "build the standard flip-chart pattern," not a literal clone of unseen implementation details.)
2. **Buy Signals** — see §6.3 below, dedicated ranked list of current best actionable flips with suggested quantity.
3. **Watchlist** — user-pinned items with alert thresholds (price crosses X, margin exceeds Y); local desktop notification when triggered. **Built as designed**: star an item in Market to pin it, set per-item "alert above"/"alert below" gp thresholds, browser `Notification` + in-app banner fires once on crossing (doesn't re-fire every poll). Pinned items are fetched via `/api/items?ids=` so they stay visible even if they'd otherwise fail the Market tab's liquidity/search filters.
4. **Update News & Sentiment** — see §6.4 below. Still a placeholder (deferred, §13).
5. **Bank** (not in the original 4-tab plan, added during v1 build) — see §6.5.

Additionally, a **global item lookup** search box lives in the header, independent of tabs: queries `/api/lookup` (a straight `LIKE` match over the full item mapping, no tradeability/liquidity filter) so it finds *any* item, including ones with no recent trades — opens the same item detail modal as clicking a row elsewhere. This wasn't in the original tab list but turned out to be necessary once the bank-value lookups needed to resolve items that don't pass the Market tab's filters.

### 6.3 Buy Signals page

This is the actionable, opinionated view — distinct from the raw Market table.

- A ranked list (not a full table) of the current best buy-side opportunities, each card showing: item, current buy/sell price, **net margin after tax**, a green "BUY" or red "AVOID/SELL" badge, and — the specific ask — **suggested quantity to buy right now**, computed as `min(remaining_buy_limit_in_current_4h_window, floor(bankroll_allocation / buy_price), affordability_cap)`. Bankroll allocation is a user-set setting (e.g. "don't put more than 15% of bankroll in one item").
- Split into **Short-term signals** (margin/liquidity driven, refreshes every poll cycle) and **Long-term signals** (trend/fundamentals + news-driven, refreshes daily alongside the sentiment digest) as two sub-sections or a toggle — matches the two opportunity classes from §1.
- Each card expands to show Claude's one-paragraph rationale + risk tag (from §8), and for long-term picks, a link back to the specific update/Reddit thread that's driving the pick (traceable to §6.4's linking output — never an unsourced "trust me" recommendation).
- A signal that later gets invalidated (volume dried up, price moved past the entry point) should visibly downgrade/gray out rather than silently disappear — useful for the historical-accuracy tracking in the roadmap (§9).

### 6.4 Update News & Sentiment tab

Pulls together three sources, none of which are real-time — this runs as a **daily batch job**, not a live stream, both because the sources don't update faster than that in practice and because it keeps API usage trivial:

- **Official patch notes**: OSRS RSS feed `https://secure.runescape.com/m=news/latest_news.rss?oldschool=true`, cross-checked against the [OSRS Wiki Update history](https://oldschool.runescape.wiki/w/Update_history) page. Updates release weekly, Wednesdays ~11:30 UTC, so the daily poll will pick up new ones same-day.
- **Reddit sentiment**: r/2007scape + r/RunescapeFlipping via **PRAW**, polled once/day for new posts/comments matching a tracked keyword/item-name list. As of the 2025 "Responsible Builder Policy," even free/personal-use Reddit API access now requires a one-time pre-approval application (2-4 week review) — budget for that lead time before this tab can go live; it's still free for hobby volume once approved. Rate limit (100 QPM authenticated) is a total non-issue at daily-batch volume.
- **Twitter/X**: **not viable** — X killed its free tier; pricing is now pay-per-use ($0.005/read, $0.015/post) with no practical hobby tier, and scraping alternatives (Nitter etc.) are unreliable/ToS-risk. Skip X entirely for v1; Reddit + official news is the realistic sentiment surface. Revisit only if X pricing changes materially.
- **Claude's job on this data**: given the day's patch notes + a batch of Reddit posts/comments, produce (a) a short digest ("what happened today"), (b) a structured list of `{item_name, update_or_thread_source, claimed_impact, confidence}` links — this item↔update linking is the part **no existing competitor tool does** (confirmed in research — GE Tracker, GE Margin, and patch-note Discord bots all stop at relaying the note, none map it to specific items). This structured output feeds directly into the Long-term Buy Signals in §6.3.
- UI: a chronological feed, newest first, each entry = one update or sentiment cluster, tagged with the items it affects (clickable → jumps to that item in Market/Buy Signals), and a confidence/speculation indicator since "Reddit rumor" and "official patch note" carry very different reliability.

### 6.5 Bankroll import (bank sync) — **built, ahead of schedule**

This was scoped as v2+ but got built early, and turned out simpler than the original plan (no file-watching, no JSON-export plugin dependency):

- **Actual mechanism**: the [Bank Memory](https://github.com/Lazyfaith/runelite-bank-memory-plugin) RuneLite plugin's **TSV clipboard export** (`Item id\tItem name\tItem quantity` rows), pasted into a textarea in the Bank tab (or read via `navigator.clipboard.readText()`). Parsing lives in `frontend/src/bankParse.ts` — it also accepts a bare `id\tqty` TSV/CSV fallback and a JSON array of `{id|itemId, qty|quantity}`, since exact plugin output can drift. Confirmed working against a real ~600-item bank export.
- The `isaachansen/runelite-json-export` file-watch approach from the original plan was **not built** — the clipboard-paste flow proved good enough in practice and avoids depending on a second third-party plugin. Revisit only if manual paste becomes annoying (per §11 v4+).
- **Valuation** (`backend/src/routes/bank.ts`): each held item is priced at live GE **low** price (realistic instant-sell value) over the static mapping `value` (alch/store reference), with an alias/fallback chain for common untradeable derived items — a curated `VALUE_ALIASES` map for known cases (Bow of faerdhinen ↔ inactive, blowpipe ↔ empty, whip ↔ degraded form), then a generic name-stripping fallback for charge-numbered and imbued `(i)` variants (e.g. "Ahrim's robetop 100" → "Ahrim's robetop"). Anything that still doesn't resolve is reported by name with `priced: false` rather than silently dropped or shown as 0gp-and-forgotten.
- Every explicit "Import" (as opposed to a live re-value) is persisted to a `bank_imports` table (`imported_at`, `total_value`, `item_count`, raw entries, full result) so import history is queryable later (`/api/bank/imports`) — not in the original plan, added because it's essentially free once you're computing the valuation anyway and sets up the "track record over time" pattern from §10.1.
- "Use as Buy Signals bankroll" writes the computed total straight into §6.3's bankroll input, replacing the manual placeholder — the core goal of this section is done.
- **Not yet built**: cross-referencing bank contents against Buy Signals to flag "you already hold N of this" / "sell into this signal instead of buying" — still a real gap, worth picking up next since the data (bank contents + live signals) is already sitting in the same backend.

---

## 7. Tech stack recommendation

- **Backend**: Node.js + TypeScript (Fastify), as planned. Python/PRAW is still the plan for the sentiment collector when §6.4 gets picked back up, as a sidecar rather than forcing it into the Node process.
- **DB**: **Built with `node:sqlite`** (Node's built-in module, stable since Node 22) instead of the originally planned `better-sqlite3` — same synchronous embedded-SQLite model, but zero native-module build step, which matters more than expected on a Windows dev machine (`better-sqlite3` needs node-gyp/a C++ toolchain; `node:sqlite` needs nothing beyond the Node LTS already required). Trade-off accepted: less mature API surface, no `better-sqlite3`-specific ecosystem tooling. `PRAGMA journal_mode = WAL` is set explicitly since it isn't `node:sqlite`'s default.
- **Frontend**: React + Vite + Tailwind, as planned. **Charting deviated from plan**: instead of pulling in uPlot or Recharts, the price/volume chart in the item detail modal is a hand-rolled inline SVG (`frontend/src/components/PriceChart.tsx`) — no charting library dependency at all. Reasonable at current chart complexity (two price lines + a volume bar strip); revisit if charts grow more elaborate (log scale, brush-to-zoom, multi-item overlay) since a library starts paying for itself past that point. The Market table itself does **not** yet use TanStack Table/Virtual — it's a plain sorted/filtered table capped at 300 rows server-side (`items.ts` returns `.slice(0, 300)`), which has been fast enough without virtualization at that row count; revisit if the row cap is lifted.
- **Scheduling**: `node-cron` for the price poller (60s/5m cadence) and a separate daily cron for the news/sentiment collector — no need for a heavyweight job queue at this scale.
- **Claude integration**: Anthropic SDK (Messages API), calling Claude with structured JSON in and requesting structured JSON back (rationale + score + risk tag + item-links) so the frontend never has to parse prose. Cache Claude's response per-item per-poll-cycle (buy signals) and per-day (news digest) to avoid redundant calls.
- **Local-only**: bind to `localhost`, no auth needed for v1 since it never leaves your machine; if you ever want to hit it from your phone on LAN, add a simple password gate then.

---

## 8. Signal engine details

### 8.1 As built (`backend/src/signals.ts`) — v1 scoring, single unified list

The implementation is a scaled-down version of the original plan — one score, not yet split into short-term vs. long-term lists, and no stability/variance term yet:

- `net_margin = high − low − tax(high)`, where `tax(x) = min(round(x * 0.01), 5_000_000)` unless `x < 100`. (Tax-exempt starter-tool whitelist from §3 — **not implemented yet**, noted as a known low-value edge case directly in the code.)
- `roi_pct = net_margin / low`
- `limit_adjusted_profit = net_margin * buy_limit` (not yet capped by affordable quantity/bankroll at this layer — that capping happens downstream in the Buy Signals tab's quantity formula, §6.3)
- `liquidity = min(min(vol_high_5m, vol_low_5m) * 12, min(vol_high_1h, vol_low_1h))` — takes the smaller of buy/sell volume on each window (so a one-sided burst can't inflate the score), normalizes the 5m window to an hourly rate, then takes whichever window is more conservative. Simpler than the originally planned multi-window "agreement" scoring, but captures the same intent (penalize thin/one-sided volume).
- `score = net_margin * log10(liquidity + 1)` — this is the actual single ranking score used by both the Market tab's default sort and the Buy Signals tab. Log-dampening liquidity keeps a handful of enormous trades from completely dominating the ranking over a smaller, cleaner margin.

**Not built yet**: `stability_score` (spread variance over trailing `timeseries` points), the short-term/long-term list split (§7's roadmap describes this as v1-scope; in practice only the short-term-shaped unified score exists — there is no long-term trend/momentum screen yet since that was meant to lean on Claude's read of external demand drivers, which isn't wired in). Buy Signals currently just filters the unified list to `net_margin > 0` and sorts by `score` — see §6.3.

### 8.2 Original v1 plan (for reference / not yet superseded)

- **Short-term list** = rank by `net_margin * liquidity_score`, filter to items with buy limit / volume high enough to fill in a single 4h window.
- **Long-term list** = different lens entirely: rank by sustained upward price trend over multi-day timeseries + low volatility + (once wired) Claude's read on external demand drivers. This list intentionally ignores instant flip margin and instead looks like a trend/momentum + fundamentals screen.

---

## 9. Claude's role, concretely

Claude is not doing the price math — the signal engine does that deterministically so results are always debuggable without an LLM call. Claude's value-add:

- **Explain the pick** in plain language for the shortlist (why this item, what's the risk).
- **Cross-reference outside context** (patch notes, Reddit threads) that no price API captures, when the user asks "why is Y spiking" or on a periodic long-term-list refresh.
- **Flag anomalies as a second check**, not the first — e.g. "this margin looks great but volume dropped 90% in the last hour, might be a manipulation artifact," using it as a sanity pass on quant output rather than the primary filter.
- **Link updates/sentiment to items** (§6.4) — the confirmed gap no competitor fills.
- **Compute suggested buy quantity with reasoning attached** (§6.3), not just a number — "buy up to 340 (your limit), but I'd size down to ~150 given the spread's been widening the last 2 hours."
- Optional: a chat panel where you ask Claude free-form questions about the current data ("what's a good long hold under 5m gp right now given I have 3 GE slots free").

---

## 10. Other features worth considering for an edge

Beyond what's already specced above, roughly in order of effort-to-value:

1. **Recommendation scorekeeping (high value, do this early).** Log every Buy Signal the app ever surfaces with a timestamp and the price at the time, then check back N hours/days later and record whether it would've been profitable. This is the single best way to know if the signal engine (or Claude's rationale) is actually adding value versus noise — none of the competitor tools researched expose this to users, so it's also a genuine differentiator, not just internal QA. Surface it as a small "track record" widget (win rate, avg realized margin) rather than hiding it in logs.
2. **Cross-item correlation / substitution flags.** Some items move together (raw vs. cooked variants, ore vs. bar, herb vs. potion) — flag when a substitute item's price hasn't followed a leader's move yet, which is a classic merchanting signal nothing in the research surfaced as automated anywhere.
3. **Update-cycle calendar awareness.** OSRS updates release weekly (Wednesdays ~11:30 UTC per §6.4). A "days since last update" / "next update in" indicator contextualizes whether current price action is update-driven noise or a stable trend — cheap to add given the RSS feed is already being polled.
4. **Seasonal/event pattern library.** Track recurring demand spikes (Halloween/Christmas events, Deadman/Leagues launches, double XP weekends) manually at first (a small curated calendar), later inferred from historical price data year-over-year once you have enough history stored. Long-term flippers already reason this way per the Reddit research; encoding it saves you from having to remember it.
5. **Manipulation/pump detection as its own signal, not just a Claude sanity check.** A deterministic rule (e.g. volume or price z-score vs. 30-day trailing baseline) that flags outliers *before* they ever reach the shortlist, so you're not paying an LLM call to catch what a simple statistical check catches for free.
6. **"What changed since I last looked" diffing.** Since this runs locally and persists history, a simple "since your last session, these items entered/left the Buy Signals list, and here's why" view turns a one-off dashboard into something worth checking daily — directly reinforces the daily habit the news/sentiment tab is already built around.
7. **Confidence-weighted position sizing tiers**, not just a single suggested quantity — e.g. show a "conservative / suggested / aggressive" quantity band derived from the stability_score (§8), so the number itself communicates how sure the system is.

None of these are required for v1 — treat them as the backlog once the core Market/Buy Signals/News loop (roadmap below) is working and you have a feel for what you actually check daily.

---

## 11. Roadmap

1. **v0 — done.** Poller + SQLite (`node:sqlite`, not `better-sqlite3` — see §7) + `/latest` and `/mapping` ingestion, net-margin table, dark/glass shell UI.
2. **v1 — mostly done.** `/5m`, `/1h`, `/timeseries` all wired (`wiki.ts`); unified liquidity-weighted score (§8.1) rather than the planned short/long split; item detail charts built (hand-rolled SVG, not uPlot/Recharts — §7); manual bankroll input built (persisted in `localStorage`). **Still open from v1 scope**: short-term/long-term list split, stability/variance scoring.
3. **v2 — partially done, out of order.** Bank import (§6.5) is **done**, and done earlier than planned, via the clipboard-TSV route rather than the JSON-export route originally sketched. **Claude integration (§9) is not started** — no rationale/risk-flagging, no structured JSON in/out, no response caching. This is the biggest gap between the design doc's stated purpose ("uses Claude to reason about opportunities") and what's actually running today: the app currently is a pure signal-engine dashboard with zero LLM calls.
4. **v3 — not started, per explicit deferral (§13).** News/sentiment collector (OSRS RSS + Reddit PRAW), Update News & Sentiment tab, Claude's item-linking. **Watchlist has been pulled forward and is already done** (§6, tab 3) — built alongside bank import rather than waiting for v3. Recommendation scorekeeping (§10.1) not started.
5. **v4+**: unchanged — pick from the §10 backlog based on what you actually find yourself wanting day to day. Automatic file-watch bank sync is now explicitly **not planned** (§6.5) unless the clipboard flow proves annoying in practice, which it hasn't so far.

**Suggested next step**, given the above: wiring in Claude (§9) is the largest remaining gap relative to the project's actual stated purpose, and everything it needs (a scored shortlist from `/api/items`, an item detail/history endpoint) already exists — it doesn't need the news/sentiment pipeline to add value, since §9's rationale/risk-flag/anomaly-check roles all work off data already being polled.

---

## 12. Required software (dev environment)

Checked/installed on this machine on 2026-08-04:

| Tool | Status | Notes |
|---|---|---|
| **Node.js LTS** (v24.19.0) + npm | ✅ installed via `winget install OpenJS.NodeJS.LTS` | Runs both backend (Fastify/TS) and frontend (Vite/React) |
| **Git** (2.55.0) | ✅ already present | |
| **Python** (3.10.11) | ✅ already present | Only needed later for the Reddit/PRAW sentiment collector (§6.4, now deferred — see §13) |
| **winget** (1.29.280) | ✅ already present | Used for the Node install above |

Nothing else is required to build the v0/v1 prototype (§11). If/when the sentiment collector (§6.4) is picked back up, `pip install praw` covers it — no additional system packages needed.

## 13. Status note — 2026-08-04

Reddit + Twitter/X sentiment (§6.4) is **deferred to backburner** per explicit direction — not blocking the prototype. Building order is now: v0/v1 core (poller → SQLite → signal engine → dark/glass Market + Buy Signals UI) first, sentiment/news tab later.

Also flagged for later: the user recalled there are RuneLite plugins for "profit tracking" and flagging which items are "safe to keep" (something death-risk or inventory-value related) beyond Flipping Utilities — exact plugin name wasn't recalled and quick research didn't turn up an obvious single match (closest candidates are RuneLite's core "Profit Tracker" for AFK-training profit, and various death-indicator/inventory-value plugins, but none clearly matched "keep or not to keep, safe or not"). Revisit once the user remembers the name or a screenshot/link is available — not blocking the prototype.

## 13.1 Status note — build progress since §13, still 2026-08-04

Implementation has run **ahead of the roadmap in places and behind it in one important place**:

- **Ahead**: Watchlist (originally v3) and Bank import (originally v2) are both built and working, plus a global item-lookup search box that wasn't in the original design at all (§6). Bank import in particular ended up more capable than sketched — value-alias/fallback handling for degraded and imbued items, persisted import history — see §6.5.
- **Behind, and this is the one that matters most**: **no Claude integration exists yet.** Everything shipped so far (Market, Buy Signals, Watchlist, Bank, item detail charts) is deterministic signal-engine output — real, tax/limit-aware, and useful, but it's the part of this design every competitor tool (§4) already does. None of §9's Claude-specific value-adds (plain-language rationale, anomaly sanity-check, update↔item linking, reasoned buy-quantity sizing) are live. The app's own README currently states this plainly ("No Claude integration yet"). Since the confirmed differentiation gap in the competitive landscape (§4) is specifically the Claude reasoning layer, not the data plumbing, this is the natural next build target — see the roadmap's "Suggested next step" in §11.
- Implementation deviated from the original tech-stack plan in a few low-risk ways worth knowing about if picking this back up cold: `node:sqlite` instead of `better-sqlite3` (§7), a hand-rolled SVG chart instead of a charting library (§7), and no TanStack Table/Virtual yet on the Market table (works fine at the current 300-row server-side cap, §7).

---

## 14. Key references

- [RuneScape:Real-time Prices — OSRS Wiki](https://oldschool.runescape.wiki/w/RuneScape:Real-time_Prices)
- [prices.runescape.wiki API FAQ](https://prices.runescape.wiki/osrs/faqs)
- [Grand Exchange — OSRS Wiki](https://oldschool.runescape.wiki/w/Grand_Exchange) (buy limits)
- [Update: Grand Exchange Tax & Item Sink](https://oldschool.runescape.wiki/w/Update:Grand_Exchange_Tax_%26_Item_Sink)
- [Rules of Old School RuneScape (Jagex)](https://legal.jagex.com/docs/rules/rules-of-old-school-runescape)
- [Flipping-Utilities RuneLite plugin (OSS)](https://github.com/Flipping-Utilities/rl-plugin)
- [Flipping Copilot plugin](https://github.com/cbrewitt/flipping-copilot)
- [japsuu/osrs-flipper](https://github.com/japsuu/osrs-flipper) — filter-based flip finder, closest prior art to the signal-engine idea here
- [GE Tracker](https://www.ge-tracker.com/) — biggest incumbent third-party site, good reference for UI/feature expectations
- [OSRS official news RSS](https://secure.runescape.com/m=news/latest_news.rss?oldschool=true)
- [OSRS Wiki Update history](https://oldschool.runescape.wiki/w/Update_history)
- [PRAW (Python Reddit API Wrapper)](https://github.com/praw-dev/praw)
- [Reddit API pricing/access changes (2025-26 Responsible Builder Policy)](https://redreplier.com/en/blog/reddit-api-pricing)
- [Bank Memory RuneLite plugin (bank → clipboard JSON export)](https://github.com/Lazyfaith/runelite-bank-memory-plugin)
- [isaachansen/runelite-json-export — local JSON snapshots for AI-assistant consumption](https://github.com/isaachansen/runelite-json-export)
