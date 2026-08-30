import { db } from "./db.js";
import { scoreItem, type ItemRow } from "./signals.js";
import { computeAllTrendEntries, type TrendWindow } from "./trends.js";

// Market Highlights: the "at a glance" curated leaderboards that sit under the Market table.
// These replaced the Trending movers / Sector indices / Substitution flags stack, which were
// three specialist panels that nobody browses casually. Everything here answers one of two
// questions -- "what moved?" and "what is worth buying right now?" -- across the WHOLE tracked
// universe, not the Market tab's filtered top 300, which is exactly why it is computed
// server-side rather than derived from whatever the table happens to be showing.

// Nature rune: the reagent cost baked into every High Level Alchemy cast. Priced live off the
// GE rather than hardcoded, since its own price drifts and it is often the entire difference
// between an alch being profitable and not.
const NATURE_RUNE_ID = 561;

// The GE caps at 2,147,483,647 and a handful of never-traded prestige items (3rd age, etc.) sit
// pinned at or near that ceiling with no real trade behind the number. Those are data artifacts,
// not "the most expensive item in the game", so they stay out of the price leaderboard.
const MAX_SANE_PRICE = 2_100_000_000;

// Profit leaderboards need *some* evidence the item actually trades -- otherwise a single stale
// tick on a dead item wins every card. Deliberately light (a trades-per-hour floor, not a rate
// you would actually flip at), since the high-volume card is the one that exists to demand real
// throughput.
const MIN_LIQUIDITY = 5;
const HIGH_VOLUME_LIQUIDITY = 1_000;

const LIST_SIZE = 25; // frontend shows the first 8 and expands to the rest on "view all"

// Only the movers cards have a time dimension at all -- everything else here is a snapshot of
// the current book (margins, buy-limit profit, price), which has no "over 7 days" reading. So
// the window selector on this panel drives the gainers/losers lists and nothing else, and the
// choice is deliberately coarse (a day, a week, a month) rather than trends.ts's full six
// windows: this is the casual browsing surface, not the mover-hunting one.
export type HighlightWindow = "1d" | "7d" | "30d";
export const HIGHLIGHT_WINDOWS: HighlightWindow[] = ["1d", "7d", "30d"];
const TREND_WINDOW: Record<HighlightWindow, TrendWindow> = {
  "1d": "24h",
  "7d": "7d",
  "30d": "30d",
};
const WINDOW_LABEL: Record<HighlightWindow, string> = {
  "1d": "24 hours",
  "7d": "7 days",
  "30d": "30 days",
};

export type HighlightMetric = "change" | "profit" | "margin" | "price";

export interface HighlightEntry {
  itemId: number;
  name: string;
  icon: string;
  price: number | null;
  /** The number shown in the right-hand column, in the unit implied by the list's metric. */
  value: number | null;
  /** Only set on the movers lists, so a row can show both the gp and the % move. */
  changePct?: number;
}

export interface HighlightList {
  key: string;
  title: string;
  /** Header for the value column; null means the list only shows a price. */
  valueLabel: string | null;
  metric: HighlightMetric;
  hint: string;
  entries: HighlightEntry[];
}

export interface HighlightsResponse {
  generatedAt: number;
  /** The movers window these lists were built for. */
  window: HighlightWindow;
  /** Rough 24h gp turnover across every tracked item -- 1h volumes scaled up to a day. */
  tradedValue24h: number;
  lists: HighlightList[];
}

const CACHE_MS = 30_000;
const cache = new Map<HighlightWindow, { at: number; data: HighlightsResponse }>();

export async function computeHighlights(
  window: HighlightWindow = "1d",
): Promise<HighlightsResponse> {
  const hit = cache.get(window);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.data;
  const data = await build(window);
  cache.set(window, { at: Date.now(), data });
  return data;
}

async function build(window: HighlightWindow): Promise<HighlightsResponse> {
  const rows = db
    .prepare(
      `
    SELECT i.id, i.name, i.members, i.buy_limit, i.icon,
           s.high, s.low, s.vol_high_5m, s.vol_low_5m, s.vol_high_1h, s.vol_low_1h, s.updated_at
    FROM items i
    JOIN latest_snapshot s ON s.item_id = i.id
    WHERE s.high IS NOT NULL AND s.low IS NOT NULL
  `,
    )
    .all() as unknown as ItemRow[];

  const scored = rows.map(scoreItem).filter((r) => r.net_margin != null && (r.high ?? 0) > 0);

  const alchRows = db
    .prepare(`SELECT id, highalch FROM items WHERE highalch IS NOT NULL AND highalch > 0`)
    .all() as unknown as { id: number; highalch: number }[];
  const alchMap = new Map(alchRows.map((r) => [r.id, r.highalch]));
  const natureRunePrice =
    (
      db.prepare(`SELECT high FROM latest_snapshot WHERE item_id = ?`).get(NATURE_RUNE_ID) as
        | { high: number | null }
        | undefined
    )?.high ?? null;

  const tradedValue24h = rows.reduce((sum, r) => {
    const mid = ((r.high ?? 0) + (r.low ?? 0)) / 2;
    const hourlyUnits = (r.vol_high_1h ?? 0) + (r.vol_low_1h ?? 0);
    return sum + mid * hourlyUnits * 24;
  }, 0);

  type Scored = (typeof scored)[number];

  const entry = (r: Scored, value: number | null, price?: number | null): HighlightEntry => ({
    itemId: r.id,
    name: r.name,
    icon: r.icon,
    price: price === undefined ? r.high : price,
    value,
  });

  const tradeable = scored.filter((r) => r.liquidity >= MIN_LIQUIDITY);

  const byProfit = (pool: Scored[]) =>
    pool
      .filter((r) => (r.limit_adjusted_profit ?? 0) > 0)
      .sort((a, b) => (b.limit_adjusted_profit ?? 0) - (a.limit_adjusted_profit ?? 0))
      .slice(0, LIST_SIZE)
      .map((r) => entry(r, r.limit_adjusted_profit));

  // Movers are ranked by gp moved rather than percent: this panel sits under a table people
  // read in gp, and a percent ranking on a 1k item is not comparable to one on a 400m item.
  // The percent is still carried on the row so the size of the move stays readable.
  const movers = (await computeAllTrendEntries(TREND_WINDOW[window]))
    .map((t) => ({ ...t, changeGp: t.toPrice - t.fromPrice }))
    .filter((t) => t.changeGp !== 0);
  const moverEntry = (t: (typeof movers)[number]): HighlightEntry => ({
    itemId: t.itemId,
    name: t.name,
    icon: t.icon,
    price: t.toPrice,
    value: t.changeGp,
    changePct: t.changePct,
  });

  const gainers = movers
    .filter((t) => t.changeGp > 0)
    .sort((a, b) => b.changeGp - a.changeGp)
    .slice(0, LIST_SIZE)
    .map(moverEntry);
  const losers = movers
    .filter((t) => t.changeGp < 0)
    .sort((a, b) => a.changeGp - b.changeGp)
    .slice(0, LIST_SIZE)
    .map(moverEntry);

  const alchs =
    natureRunePrice == null
      ? []
      : scored
          .filter((r) => alchMap.has(r.id) && r.liquidity >= MIN_LIQUIDITY && r.buy_limit)
          .map((r) => {
            const perCast = alchMap.get(r.id)! - (r.low ?? 0) - natureRunePrice;
            return { r, perCast, profit: perCast * (r.buy_limit ?? 0) };
          })
          .filter((x) => x.perCast > 0)
          .sort((a, b) => b.profit - a.profit)
          .slice(0, LIST_SIZE)
          .map((x) => entry(x.r, x.profit, x.r.low));

  // 7d/30d come out of the DuckDB daily rollup, which only has as many days as this install has
  // been running -- an empty list there means "no history yet", not "nothing moved", and the two
  // read very differently to someone staring at a blank card.
  const noHistory = movers.length === 0 && window !== "1d";
  const moversHint = (direction: "rise" | "fall") =>
    noHistory
      ? `Not enough local price history for a ${WINDOW_LABEL[window]} window yet, the daily rollup needs to run that many days first.`
      : `Biggest gp ${direction} over the last ${WINDOW_LABEL[window]}.`;

  const lists: HighlightList[] = [
    {
      key: "gainers",
      title: "Top gainers",
      valueLabel: `${window} change`,
      metric: "change",
      hint: moversHint("rise"),
      entries: gainers,
    },
    {
      key: "losers",
      title: "Top losers",
      valueLabel: `${window} change`,
      metric: "change",
      hint: moversHint("fall"),
      entries: losers,
    },
    {
      key: "highVolume",
      title: "High volume profit",
      valueLabel: "Profit",
      metric: "profit",
      hint: `Profit per full buy limit, restricted to items clearing ${HIGH_VOLUME_LIQUIDITY.toLocaleString()}+ trades/hr.`,
      entries: byProfit(scored.filter((r) => r.liquidity >= HIGH_VOLUME_LIQUIDITY)),
    },
    {
      key: "margins",
      title: "Largest margins",
      valueLabel: "Margin",
      metric: "margin",
      hint: "Net margin on a single unit, after GE tax.",
      entries: tradeable
        .filter((r) => (r.net_margin ?? 0) > 0)
        .sort((a, b) => (b.net_margin ?? 0) - (a.net_margin ?? 0))
        .slice(0, LIST_SIZE)
        .map((r) => entry(r, r.net_margin)),
    },
    {
      key: "profitable",
      title: "Most profitable",
      valueLabel: "Profit",
      metric: "profit",
      hint: "Net margin times the 4-hour buy limit.",
      entries: byProfit(tradeable),
    },
    {
      key: "profitableF2p",
      title: "Most profitable F2P",
      valueLabel: "Profit",
      metric: "profit",
      hint: "Same ranking, free-to-play items only.",
      entries: byProfit(tradeable.filter((r) => r.members === 0)),
    },
    {
      key: "taxFree",
      title: "Tax-free profit",
      valueLabel: "Profit",
      metric: "profit",
      hint: "Items priced low enough that the 2% GE tax rounds down to zero.",
      entries: byProfit(tradeable.filter((r) => (r.tax ?? 0) === 0)),
    },
    {
      key: "expensive",
      title: "Most expensive",
      valueLabel: null,
      metric: "price",
      hint: "Highest current sell price, excluding never-traded items pinned at the GE cap.",
      // No liquidity floor here, unlike the profit lists: the whole point of this card is the
      // rarest, thinnest-traded items in the game, and a trades-per-hour filter deletes exactly
      // those (twisted bows and 3rd age do not trade five times an hour).
      entries: scored
        .filter((r) => (r.high ?? 0) <= MAX_SANE_PRICE)
        .sort((a, b) => (b.high ?? 0) - (a.high ?? 0))
        .slice(0, LIST_SIZE)
        .map((r) => entry(r, null)),
    },
    {
      key: "alchs",
      title: "Profitable alchs",
      valueLabel: "Alch profit",
      metric: "profit",
      hint:
        natureRunePrice == null
          ? "Needs a live nature rune price, which is not in the snapshot yet."
          : `High alch value minus buy price minus a ${natureRunePrice}gp nature rune, times the buy limit.`,
      entries: alchs,
    },
  ];

  return { generatedAt: Date.now(), window, tradedValue24h, lists };
}
