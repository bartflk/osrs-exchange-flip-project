import type { FastifyInstance } from "fastify";
import { db } from "../db.js";
import { scoreItem, type ItemRow } from "../signals.js";
import { computeIndicatorBundle, type IndicatorBundle } from "../indicatorBundle.js";
import { computeTechnicalIndicators, type TechnicalIndicators } from "../technicalIndicators.js";
import { computeMarketTemperature } from "../marketTemperature.js";
import { generateMarketIntelligence, type MarketIntelligence } from "../llm.js";
import type { TrendWindow } from "../trends.js";

const VALID_WINDOWS: TrendWindow[] = ["1h", "4h", "12h", "24h", "7d", "30d"];

const itemQueryStmt = db.prepare(`
  SELECT i.id, i.name, i.members, i.buy_limit, i.icon,
         s.high, s.low, s.vol_high_5m, s.vol_low_5m, s.vol_high_1h, s.vol_low_1h, s.updated_at
  FROM items i JOIN latest_snapshot s ON s.item_id = i.id
  WHERE i.id = ?
`);

function loadScoredItem(itemId: number) {
  const row = itemQueryStmt.get(itemId) as unknown as ItemRow | undefined;
  if (!row) return null;
  return { row, scored: scoreItem(row) };
}

// DESIGN.md §10 items 36-45 ("More indicators.txt", 2026-08-06): the indicator bundle + AI
// synthesis endpoints. Split from routes/llm.ts (explain-the-pick) since this is a distinct,
// richer feature -- a "Market Intelligence" read, not the original single-verdict explanation.
const INTELLIGENCE_TTL_MS = 15 * 60 * 1000;
const intelligenceCache = new Map<number, { at: number; data: MarketIntelligence }>();

export async function indicatorsRoutes(app: FastifyInstance) {
  app.get("/api/items/:id/indicators", async (req, reply) => {
    const { id } = req.params as { id: string };
    const itemId = Number(id);
    const loaded = loadScoredItem(itemId);
    if (!loaded) return reply.code(404).send({ error: "item not found" });
    if (loaded.scored.high == null || loaded.scored.low == null) {
      return reply.code(400).send({ error: "item not currently tradeable" });
    }
    const indicators: IndicatorBundle = computeIndicatorBundle(loaded.scored);
    return indicators;
  });

  app.get("/api/items/:id/intelligence", async (req, reply) => {
    const { id } = req.params as { id: string };
    const itemId = Number(id);

    const cached = intelligenceCache.get(itemId);
    if (cached && Date.now() - cached.at < INTELLIGENCE_TTL_MS) {
      return { ...cached.data, cached: true };
    }

    const loaded = loadScoredItem(itemId);
    if (!loaded) return reply.code(404).send({ error: "item not found" });
    if (loaded.scored.high == null || loaded.scored.low == null) {
      return reply.code(400).send({ error: "item not currently tradeable" });
    }

    const indicators = computeIndicatorBundle(loaded.scored);
    try {
      const intelligence = await generateMarketIntelligence({
        name: loaded.row.name,
        netMargin: loaded.scored.net_margin,
        roiPct: loaded.scored.roi_pct,
        indicators: indicators as unknown as Record<string, unknown>,
      });
      intelligenceCache.set(itemId, { at: Date.now(), data: intelligence });
      return { ...intelligence, indicators, cached: false };
    } catch (err) {
      req.log.error(err);
      return reply.code(502).send({ error: "failed to get market intelligence from the model" });
    }
  });

  app.get("/api/items/:id/technicals", async (req, reply) => {
    const { id } = req.params as { id: string };
    const itemId = Number(id);
    const loaded = loadScoredItem(itemId);
    if (!loaded) return reply.code(404).send({ error: "item not found" });
    if (loaded.scored.high == null || loaded.scored.low == null) {
      return reply.code(400).send({ error: "item not currently tradeable" });
    }
    const technicals: TechnicalIndicators = await computeTechnicalIndicators(loaded.scored);
    return technicals;
  });

  app.get("/api/market-temperature", async (req, reply) => {
    const query = req.query as { window?: string };
    const window = (query.window ?? "24h") as TrendWindow;
    if (!VALID_WINDOWS.includes(window)) {
      return reply.code(400).send({ error: "invalid window" });
    }
    return computeMarketTemperature(window);
  });
}
