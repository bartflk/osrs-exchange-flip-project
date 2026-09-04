import type { FastifyInstance } from "fastify";
import { computeMarketIndices } from "../indices.js";
import { categoryMemberIds, INDEX_DEFINITIONS, refreshItemCategories } from "../itemCategories.js";
import type { TrendWindow } from "../trends.js";

const VALID_WINDOWS: TrendWindow[] = ["1h", "4h", "12h", "24h", "7d", "30d"];

export async function indicesRoutes(app: FastifyInstance) {
  app.get("/api/indices", async (req, reply) => {
    const query = req.query as { window?: string };
    const window = (query.window ?? "24h") as TrendWindow;
    if (!VALID_WINDOWS.includes(window)) {
      return reply.code(400).send({ error: "invalid window" });
    }
    return { window, indices: await computeMarketIndices(window) };
  });

  // Membership on demand rather than inline with every index. Smithing alone holds 276 items, and
  // shipping every member of forty groups on a poll the UI makes every few seconds would be most
  // of the payload for a list nobody has opened.
  app.get("/api/indices/:key/members", async (req, reply) => {
    const { key } = req.params as { key: string };
    const def = INDEX_DEFINITIONS.find((d) => d.key === key);
    if (!def) return reply.code(404).send({ error: `no index "${key}"` });
    return { key, label: def.label, itemIds: categoryMemberIds(def.category) };
  });

  app.post("/api/indices/refresh", async (req) => {
    // Fire and forget: a full refresh is forty wiki requests and the caller does not need to hold
    // a connection open for it, same shape as the money-maker refresh.
    void refreshItemCategories(true).catch((err) => {
      req.log.error({ err }, "category refresh failed");
    });
    return { started: true };
  });
}
