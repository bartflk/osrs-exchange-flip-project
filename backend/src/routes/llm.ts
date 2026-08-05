import type { FastifyInstance } from "fastify";
import { db } from "../db.js";
import { scoreItem, type ItemRow } from "../signals.js";
import { explainItem, type Explanation } from "../llm.js";

// Cache per item -- price data (and the case for/against a flip) doesn't meaningfully change
// minute to minute, and there's no reason to pay for a fresh LLM call every time the same item's
// detail modal is reopened. 15 minutes balances staleness against cost.
const TTL_MS = 15 * 60 * 1000;
const cache = new Map<number, { at: number; data: Explanation }>();

export async function llmRoutes(app: FastifyInstance) {
  app.get("/api/items/:id/explain", async (req, reply) => {
    const { id } = req.params as { id: string };
    const itemId = Number(id);

    const cached = cache.get(itemId);
    if (cached && Date.now() - cached.at < TTL_MS) {
      return { ...cached.data, cached: true };
    }

    const row = db
      .prepare(
        `
      SELECT i.id, i.name, i.members, i.buy_limit, i.icon,
             s.high, s.low, s.vol_high_5m, s.vol_low_5m, s.vol_high_1h, s.vol_low_1h, s.updated_at
      FROM items i JOIN latest_snapshot s ON s.item_id = i.id
      WHERE i.id = ?
    `,
      )
      .get(itemId) as unknown as ItemRow | undefined;
    if (!row) return reply.code(404).send({ error: "item not found" });

    const scored = scoreItem(row);
    if (scored.high == null || scored.low == null) {
      return reply.code(400).send({ error: "item not currently tradeable" });
    }

    try {
      const explanation = await explainItem({
        name: row.name,
        high: scored.high,
        low: scored.low,
        netMargin: scored.net_margin,
        roiPct: scored.roi_pct,
        liquidity: scored.liquidity,
        tax: scored.tax,
        buyLimit: row.buy_limit,
        members: row.members === 1,
      });
      cache.set(itemId, { at: Date.now(), data: explanation });
      return { ...explanation, cached: false };
    } catch (err) {
      req.log.error(err);
      return reply.code(502).send({ error: "failed to get explanation from the model" });
    }
  });
}
