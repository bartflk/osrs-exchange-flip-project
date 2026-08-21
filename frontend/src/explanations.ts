// Every computed number in this app comes from a formula written down somewhere in the backend.
// This is the one place those formulas are explained in plain English, so a tooltip can never
// drift into describing a calculation the code doesn't actually do -- if a formula changes, it
// changes here too, and every screen showing that number updates at once.
//
// Rule for writing entries: `formula` is transcribed from the source file named in `source`, not
// paraphrased from memory. `caveat` is required whenever the number rests on an assumption the
// reader would not guess -- an unbacktested constant, a sample too small to trust, a known
// optimism. A metric with no honest caveat simply omits the field; a metric with one that goes
// unsaid is how §14.45 shipped a 52x overstatement that looked perfectly reasonable on screen.

export interface Explanation {
  /** Short human title -- what the number is, not how it's derived. */
  title: string;
  /** The actual calculation, in the closest readable form to the code. */
  formula?: string;
  /** Plain-English body. Each string renders as its own paragraph. */
  body: string[];
  /** What this number does NOT tell you, or where it's known to be soft. */
  caveat?: string;
  /** File the formula lives in, shown as a footer so it's traceable. */
  source?: string;
}

export const EXPLANATIONS = {
  // ---------------------------------------------------------------- core market maths

  geTax: {
    title: "GE tax",
    formula: "tax = min(floor(sell_price × 2%), 5,000,000)",
    body: [
      "The Grand Exchange takes 2% of the sale price from the seller. It was 1% until the 2025-05-29 update, so any older guide you read is out of date.",
      "The tax is capped at 5,000,000gp per sale, which means items above 250m are taxed at a flat 5m rather than 2%. It rounds down to zero on anything under 50gp, so cheap items are effectively untaxed.",
    ],
    caveat:
      "A whitelist of tax-exempt items exists in game (bonds, teleport tabs, charged jewellery, basic tools, some food and ammo). This app does not model it yet, so margins on those specific items are understated.",
    source: "backend/src/signals.ts — geTax()",
  },

  netMargin: {
    title: "Net margin",
    formula: "margin = sell (high) − buy (low) − GE tax on the sell",
    body: [
      "What one unit clears after tax, using the most recent price someone actually bought at and the most recent price someone actually sold at.",
    ],
    caveat:
      "Buy and sell here are the last completed trades, not a live order book. An offer placed at exactly those prices can sit unfilled — see Execution margin for a more realistic pair.",
    source: "backend/src/signals.ts — scoreItem()",
  },

  roi: {
    title: "ROI",
    formula: "roi = net margin ÷ buy price",
    body: [
      "Return per gp tied up, not per flip. A 5% ROI on a 1k item and on a 100m item are the same efficiency but wildly different absolute profit.",
      "Rank by ROI when your bankroll is the binding constraint. Rank by Potential profit when your GE slots are.",
    ],
    source: "backend/src/signals.ts — scoreItem()",
  },

  liquidity: {
    title: "Liquidity per hour",
    formula: "liquidity = min( min(vol_high_5m, vol_low_5m) × 12,  min(vol_high_1h, vol_low_1h) )",
    body: [
      "A conservative estimate of how many units per hour actually change hands.",
      "Both sides are minimised before anything else: an item with 5,000 buys and 3 sells is not liquid, it is a trap, so it scores as 3. The 5-minute figure is scaled up to an hourly rate and then the smaller of the two windows wins, so a momentary burst can't inflate it.",
    ],
    source: "backend/src/signals.ts — scoreItem()",
  },

  score: {
    title: "Score",
    formula: "score = (net margin × log₁₀(liquidity + 1)) ÷ (1 + volatility)",
    body: [
      "The single ranking number used by the Market table, Buy Signals and the Capital Allocator alike.",
      "Absolute gp margin drives it, because gp is what you actually keep. Liquidity enters through a log, so going from 10 to 100 units per hour matters a lot and 1,000 to 10,000 barely matters at all — past a point, more volume doesn't help you fill any faster.",
      "Volatility divides it as a mild penalty. An item with no volatility history yet gets a penalty of exactly 1, meaning it ranks the same as it did before volatility existed rather than being punished for missing data.",
    ],
    caveat:
      "The shape of this formula is a considered judgement, not a backtested optimum. It has never been calibrated against the resolved outcomes in Track Record.",
    source: "backend/src/signals.ts — scoreItem()",
  },

  potentialProfit: {
    title: "Potential profit",
    formula: "potential = net margin × GE buy limit",
    body: [
      "The most this item could pocket in one 4-hour buy-limit cycle, if every unit filled at the quoted prices.",
      "This is the number to sort by when you have slots free and money spare — it answers 'how much can this item actually absorb', which ROI deliberately ignores.",
    ],
    caveat:
      "Assumes the full limit fills at today's spread. Thin items rarely do. It also uses the catalogue limit, not what's left of your own 4h window.",
    source: "frontend/src/components/MarketTable.tsx — potentialProfit()",
  },

  volatility: {
    title: "Volatility (24h)",
    formula: "volatility = stddev(high) ÷ mean(high), over the trailing 24 hours",
    body: [
      "The coefficient of variation of the buy price. Dividing by the mean makes it comparable across a 5gp item and a 500m item, which raw standard deviation is not.",
      "Under about 1% is a quiet, stable item. Above 5% the price is moving enough that the margin you see now may not be there when your buy fills.",
      "Needs at least 10 price samples in the window. Below that it shows as blank rather than a fake zero, because 'no data' and 'perfectly stable' are not the same claim.",
    ],
    source: "backend/src/volatility.ts",
  },

  executionMargin: {
    title: "Execution margin",
    formula:
      "buy = low + 0.5%,  sell = high − 0.5%,  margin = sell − buy − tax(sell)",
    body: [
      "The margin you'd clear if you paid to jump the queue instead of assuming a perfect fill at the quoted spread.",
      "Buying a touch above the last buy price and selling a touch below the last sell price is what actually gets an offer filled quickly. This is that trade-off priced in.",
    ],
    caveat:
      "The 0.5% nudge is a flat heuristic, not the real GE tick-size table, and it has not been calibrated against fill data — no fill-rate history exists yet to calibrate against. Treat it as a sanity check on the optimistic number, not a promise.",
    source: "backend/src/signals.ts — executionNudge()",
  },

  // ---------------------------------------------------------------- position & risk

  sizingTiers: {
    title: "Position sizing tiers",
    formula:
      "qty = floor( min(buy limit, hourly liquidity) × tier × stability )\ntier: conservative 25%, suggested 50%, aggressive 100%\nstability = clamp(1 − volatility × 10, 0.2, 1)",
    body: [
      "Three sizes rather than one number, so the spread between them communicates confidence without needing a sentence.",
      "The ceiling is whichever binds first: the GE's 4-hour buy limit, or how much volume genuinely clears in an hour. There's no point sizing past what could realistically fill.",
      "Volatility then shrinks all three. An item with unknown volatility gets 0.6 — a moderate default rather than false confidence.",
    ],
    caveat: "The ×10 volatility scaling is a chosen constant, not a backtested one.",
    source: "frontend/src/positionSizing.ts",
  },

  tradeHealth: {
    title: "Trade health",
    formula: "starts at 100, deductions subtract from it",
    body: [
      "A live 0–100 read on an open offer, recomputed every poll from the offer plus the current market row. Nothing is stored, so it can never go stale.",
      "Deductions: −40 if the underlying margin has gone flat or negative (the thesis broke, and no reprice fixes that). Up to −30 for the market drifting past your price. Up to −20 for volatility above 3%. −15 for liquidity under 10/hr. Up to −15 for an offer sitting over 4 hours unfilled.",
      "70 and up is Healthy, 40–69 is Watch, below 40 is At risk. Every deduction is listed in plain English next to the score — there is no silent component.",
    ],
    caveat:
      "The weights are reasoned, not fitted. Read the reasons rather than the number: the reasons are facts, the number is a summary of them.",
    source: "frontend/src/tradeHealth.ts",
  },

  capitalAllocator: {
    title: "Capital allocator",
    formula:
      "rank by score → fill slots one at a time\nqty = min(remaining 4h limit, floor(cap ÷ buy price))\ncap = min(bankroll × max allocation %, cash left)",
    body: [
      "A greedy allocator, not a portfolio optimiser. Markowitz-style optimisation assumes short-selling and continuous rebalancing, and the GE offers neither — you get eight buy-only slots with hard quantity limits.",
      "It walks the ranked list, gives each slot the best item it can still afford, and moves on. The per-item cap stops a single item eating the whole bankroll.",
      "Quantity respects what's left of your real 4-hour buy limit, taken from your actual fills — not the catalogue limit. Suggesting 11,000 Diamond when 9,360 of the limit is already spent is a suggestion the GE would simply refuse.",
    ],
    source: "frontend/src/capitalAllocator.ts",
  },

  maximizeUtilization: {
    title: "Maximise utilisation",
    formula: "rank = score × (0.4 + 0.6 × min(1, item capacity ÷ (bankroll ÷ slots)))",
    body: [
      "With a large bankroll and few slots, ranking on score alone leaves most of the money idle — the highest-edge item may have a buy limit that caps its spend at a few million while you're holding hundreds of millions.",
      "This re-ranks so an item that can absorb its full fair share keeps its whole score, and one that can only take a sliver is discounted proportionally. A tiny-limit item ranked #1 no longer claims a slot a bigger item could have filled.",
    ],
    caveat:
      "This deliberately trades some per-unit edge for deployed capital. If you'd rather have the highest-edge picks and accept idle gp, leave it off.",
    source: "frontend/src/capitalAllocator.ts",
  },

  // ---------------------------------------------------------------- timing

  timingEdge: {
    title: "Timing edge",
    formula:
      "for each day both slots have a reading:\n  profit = sell − tax(sell) − buy\nedge = median(those daily profits) ÷ buy",
    body: [
      "How much a round trip is worth if you buy at one half-hour slot and sell at another, judged across roughly a week of days.",
      "The buy and sell readings are paired inside the same day before anything is compared. That pairing is the whole point: a round trip happens within one day's prices, so taking the median of all sell prices and subtracting the median of all buy prices measures something else entirely — on a trending item those two medians land on different days and the trend gets reported as timing edge.",
      "Tax is applied to the sale, not to the edge, and the result is expressed against the buy price so it reads as a return.",
    ],
    caveat:
      "Needs at least 4 paired days to show at all. Check the Days won column beside it — the same profit figure from 4 days and from 7 are different claims.",
    source: "backend/src/slotProfiles.ts + db.ts getPairedDays()",
  },

  daysWon: {
    title: "Days won",
    formula: "days where sell − tax − buy > 0,  out of days where both slots had a reading",
    body: [
      "The sample sitting underneath the profit figure next to it.",
      "5/7 means the round trip made money on five of the seven days measured. Green at 70% or better, amber at 50% or worse.",
      "A high median profit won on 4 of 7 days is a coin flip with a good average. A smaller one won on 7 of 7 is a pattern.",
    ],
    source: "backend/src/slotProfiles.ts",
  },

  tradingHours: {
    title: "Best hours to trade",
    formula:
      "per hour-of-day: deviation from that day's own mean, then median across days",
    body: [
      "Built from 7 days of hourly prices from the Wiki API — the API caps every request at 365 points, which is what limits the window.",
      "Each reading is first expressed as a percentage deviation from its own day's mean. That removes the week's overall trend, so a falling item doesn't make every late hour look 'cheap'.",
      "The median across days is then taken rather than the mean, because prices are heavy-tailed and one freak print will drag a mean somewhere the item never actually traded.",
    ],
    caveat:
      "Seven days is enough to notice a rhythm and nowhere near enough to prove one. Weekly seasonality is not modelled at all yet.",
    source: "backend/src/tradingHours.ts",
  },

  itemOfTheHour: {
    title: "Item of the hour",
    formula: "best paired buy → sell slot for the current half hour, ranked by gp on your bankroll",
    body: [
      "For the half-hour slot you're in right now, the item whose historical buy-here / sell-later round trip has the best median paid profit, sized against your bankroll rather than shown as a bare percentage.",
      "Ranking by gp your bankroll would actually earn, rather than by percentage, stops a 40% edge on an item you can only buy three of from outranking a 2% edge you can put real money behind.",
    ],
    caveat:
      "Profiles older than 3 days are excluded from ranking rather than shown as current. A stale profile is a claim about last week's market.",
    source: "backend/src/slotProfiles.ts — computeItemOfTheHour()",
  },

  deployableUnits: {
    title: "Buy quantity",
    formula: "units = min(GE buy limit, floor(bankroll ÷ buy price))\nfill share = units ÷ volume per 30m slot",
    body: [
      "How many units your bankroll can actually take here, capped by whichever binds first: the 4-hour buy limit or what you can afford.",
      "The number turns amber once the position is more than half a typical slot's volume. Past that point you're not taking the observed price any more, you're setting it — and a historical median stops predicting your own fill.",
    ],
    source: "backend/src/slotProfiles.ts — bestPickForItem()",
  },

  slotScore: {
    title: "Slot score",
    formula:
      "gpTerm = min(1, log₁₀(cycle profit) ÷ 7.7)\nfillPenalty = 1 if fill share ≤ 50%, else 0.5 ÷ fill share (floor 0.15)\nscore = round(gpTerm × fillPenalty × 100)",
    body: [
      "Ranks by gp your bankroll would actually earn, then discounts anything you couldn't realistically fill.",
      "The log scaling lets the ranking span cheap high-volume items and big weapons without the top end flattening: 1m earns 0.60, 5m earns 0.78, 50m earns 1.0.",
    ],
    caveat:
      "These weights have never been calibrated against the resolved outcomes this app already stores. It's a reasoned ranking, not a measured one.",
    source: "backend/src/slotProfiles.ts — bestPickForItem()",
  },

  // ---------------------------------------------------------------- realised results

  realisedProfit: {
    title: "Realised profit",
    formula: "per flip: (sell × qty) − tax − (buy × qty),  buys matched to sells FIFO",
    body: [
      "Actual money made on completed round trips, read from your real GE fills — not a projection.",
      "Buys are matched to sells first-in-first-out, so a partially sold position reports profit only on the units that actually closed.",
      "Prices are the realised ones: gp spent ÷ quantity filled, taken from the change between two slot readings. Nothing is inferred from the price you asked for.",
    ],
    caveat:
      "Flips that sold more units than the ledger saw bought are excluded entirely, not counted as free inventory. Cost basis of zero is missing data. On the first run this exclusion was the difference between a truthful ~0 gp/hr session and a fabricated 147k gp/hr one.",
    source: "backend/src/flips.ts",
  },

  gpPerHour: {
    title: "GP per hour",
    formula: "realised profit ÷ hours elapsed since capture started",
    body: [
      "Measured from when this app first started watching your GE slots, not from when you logged in.",
      "The clock runs whether or not you were trading, so an idle stretch dilutes it exactly as much as it dilutes your actual earnings.",
    ],
    caveat:
      "Early in a session this is extremely noisy — one flip closing divides by a very small number of hours.",
    source: "backend/src/flips.ts — computeSession()",
  },

  realization: {
    title: "Realisation ratio",
    formula: "ratio = realised avg net margin ÷ projected avg net margin, across resolved picks",
    body: [
      "How much of what this app projected has historically turned into real money. A ratio of 0.6 means picks have delivered about 60% of the projected margin.",
      "The calibrated profit shown on Buy Signals is the raw projection multiplied by this ratio, so the app is scored against its own past record rather than trusted at face value.",
    ],
    caveat:
      "Only meaningful once enough recommendations have resolved. A ratio built on a handful of picks is a rumour, not a track record.",
    source: "backend/src/scorekeeping.ts",
  },

  netWorth: {
    title: "Net worth",
    formula: "bank value + cash on hand + worn gear + value sitting in GE offers",
    body: [
      "Bank value comes from RuneLite's Bank Value Tracker snapshots (main tab only). GE value is added to the newest point only, since it's a live figure with no history behind it.",
      "Cash and gear on hand are values you enter yourself — nothing on disk reports them.",
    ],
    caveat:
      "Only the newest point includes GE value, so the shape of the historical line and the current total are measuring slightly different things.",
    source: "backend/src/runeliteBank.ts — combineNetWorth()",
  },

  buyLimitWindow: {
    title: "Remaining buy limit",
    formula: "catalogue limit − units bought in the trailing 4 hours",
    body: [
      "The GE resets each item's buy limit every 4 hours, per item, on a rolling window from your first purchase.",
      "This is computed from your real fills, so it reflects what the GE will actually let you buy next — not what the item's limit is in principle.",
    ],
    caveat:
      "Only counts fills seen since this app started watching your slots. Purchases made before that are invisible to it and the remaining limit will read high.",
    source: "backend/src/flips.ts — computeBuyLimitUsage()",
  },
} as const satisfies Record<string, Explanation>;

export type ExplanationId = keyof typeof EXPLANATIONS;
