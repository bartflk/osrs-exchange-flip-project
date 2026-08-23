import type { FastifyInstance } from "fastify";
import { getTrackRecord, getItemTrackRecord } from "../scorekeeping.js";
import { computeHorizonTrackRecord } from "../trackRecordHorizons.js";

export async function scorekeepingRoutes(app: FastifyInstance) {
  // ?strategy=overnight scopes the record to the Overnight page's picks. Defaults to "signals"
  // so existing callers keep the exact record they had -- see getTrackRecord() for why these
  // must not be pooled.
  app.get("/api/track-record", async (req) => {
    const { strategy } = req.query as { strategy?: string };
    return getTrackRecord(strategy === "overnight" ? "overnight" : "signals");
  });

  // DESIGN.md §14.12: per-item slice, for the item detail modal's flipsmart-parity stats block.
  app.get("/api/items/:id/track-record", async (req) => {
    const { id } = req.params as { id: string };
    return getItemTrackRecord(Number(id));
  });

  // DESIGN.md §14.22: multi-horizon backtest -- how the same logged picks would have gone at
  // 2/3/6/12/24h hold periods, not just the fixed 4h resolution.
  app.get("/api/track-record/horizons", async () => ({ horizons: computeHorizonTrackRecord() }));
}
