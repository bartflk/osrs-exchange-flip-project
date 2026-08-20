import type { FastifyInstance } from "fastify";
import { computeFlips, computePositions, computeSession, computeBuyLimitUsage } from "../flips.js";
import { getGeTransactions } from "../db.js";
import { getCaptureStartedAt } from "../geLedger.js";
import { readCopilotSlots, runeliteSourcesAvailable } from "../runeliteImport.js";
import {
  readBankValueHistory,
  combineNetWorth,
  bankValueTrackerAvailable,
} from "../runeliteBank.js";
import { db } from "../db.js";

// DESIGN.md §14.40: the GE trade ledger API -- Portfolio, Session, Flips, Transactions,
// Visualize flip and Missed flips are all views over these.

const itemMetaStmt = db.prepare(`SELECT name, icon FROM items WHERE id = ?`);
const latestStmt = db.prepare(`SELECT high, low FROM latest_snapshot WHERE item_id = ?`);

export async function ledgerRoutes(app: FastifyInstance) {
  // Open positions + live GE slots. The two are deliberately separate: positions are what you
  // *hold* (derived from the ledger), slots are what's *on the GE right now* (read live from
  // disk). An item can be in one without the other -- bought and collected but not yet relisted,
  // or a sell offer that hasn't filled a single unit.
  app.get("/api/portfolio", async () => {
    const positions = computePositions();
    const slots = readCopilotSlots().map((s) => {
      const meta = itemMetaStmt.get(s.item_id) as { name: string; icon: string | null } | undefined;
      const price = latestStmt.get(s.item_id) as { high: number | null; low: number | null } | undefined;
      const remaining = s.total_quantity - s.quantity_sold;
      return {
        slot: s.slot,
        itemId: s.item_id,
        name: meta?.name ?? `Item ${s.item_id}`,
        icon: meta?.icon ?? null,
        type: s.type,
        state: s.state,
        price: s.price,
        totalQuantity: s.total_quantity,
        quantitySold: s.quantity_sold,
        remaining,
        spent: s.spent,
        // What the offer is still committing: gp tied up for a buy, items tied up for a sell.
        committedGp: s.type === "buy" ? remaining * s.price : 0,
        marketPrice: s.type === "buy" ? (price?.high ?? null) : (price?.low ?? null),
      };
    });

    const cashInBuyOffers = slots.reduce((sum, s) => sum + s.committedGp, 0);
    const assetsValue = positions.reduce((sum, p) => sum + (p.marketValue ?? 0), 0);
    const unrealizedProfit = positions.reduce((sum, p) => sum + (p.unrealizedProfit ?? 0), 0);

    return {
      positions,
      slots: slots.sort((a, b) => a.slot - b.slot),
      // DESIGN.md §14.41: consumed 4h buy limits, so the Capital Allocator can size against what
      // you may still buy rather than the catalogue limit.
      buyLimits: computeBuyLimitUsage(),
      totals: {
        assetsValue,
        cashInBuyOffers,
        unrealizedProfit,
        uniqueItems: positions.length,
        slotsUsed: slots.length,
        // GE gives 8 boxes; anything the plugin reports as occupied is one we can't plan into.
        freeSlots: Math.max(0, 8 - slots.length),
      },
      sources: { ...runeliteSourcesAvailable(), bankValueTracker: bankValueTrackerAvailable() },
      captureStartedAt: getCaptureStartedAt(),
    };
  });

  // §14.47: bank value history straight from RuneLite's Bank Value Tracker, so the net-worth
  // chart works without any manual imports. The GE side is added to the newest point only --
  // see combineNetWorth() for why history is not back-filled.
  app.get("/api/bank-history", async () => {
    const history = readBankValueHistory();
    const positions = computePositions();
    const slots = readCopilotSlots();
    const assetsValue = positions.reduce((sum, p) => sum + (p.marketValue ?? 0), 0);
    const cashInBuyOffers = slots.reduce(
      (sum, s) => sum + (s.type === "buy" ? (s.total_quantity - s.quantity_sold) * s.price : 0),
      0,
    );
    const geValueNow = assetsValue + cashInBuyOffers;
    const combined = combineNetWorth(history, geValueNow);
    return {
      ...combined,
      assetsValue,
      cashInBuyOffers,
      available: bankValueTrackerAvailable(),
    };
  });

  app.get("/api/flips", async (req) => {
    const { status, limit } = req.query as { status?: string; limit?: string };
    let flips = computeFlips();
    if (status) flips = flips.filter((f) => f.status === status.toUpperCase());
    const max = Math.min(Number(limit) || 200, 1000);
    // `transactions` is only needed by Visualize Flip, which fetches one flip at a time -- sending
    // every fill for every flip would balloon the list payload for nothing.
    return {
      flips: flips.slice(0, max).map(({ transactions, ...rest }) => ({
        ...rest,
        transactionCount: transactions.length,
      })),
      total: flips.length,
      captureStartedAt: getCaptureStartedAt(),
    };
  });

  // One flip with its full fill history, for the Visualize Flip chart overlay.
  app.get("/api/flips/:itemId", async (req, reply) => {
    const { itemId } = req.params as { itemId: string };
    const id = Number(itemId);
    if (!Number.isFinite(id)) return reply.code(400).send({ error: "bad item id" });
    const flips = computeFlips().filter((f) => f.itemId === id);
    if (!flips.length) return reply.code(404).send({ error: "no flips for that item" });
    return { flips };
  });

  app.get("/api/transactions", async (req) => {
    const { since, limit } = req.query as { since?: string; limit?: string };
    const sinceUnix = Number(since) || 0;
    return { transactions: getGeTransactions(sinceUnix, Math.min(Number(limit) || 500, 2000)) };
  });

  app.get("/api/session", async (req) => {
    const { since } = req.query as { since?: string };
    // Default window: today. A session is whatever the user says it is, so the frontend owns the
    // "reset session" marker and passes it here rather than the backend guessing.
    const fallback = Math.floor(Date.now() / 1000) - 24 * 60 * 60;
    return computeSession(Number(since) || fallback);
  });

  // Flips the ledger can't fully account for. Two honest categories, not one blurred list.
  app.get("/api/missed-flips", async () => {
    const flips = computeFlips();
    const captureStartedAt = getCaptureStartedAt();
    return {
      // Sold more than we ever saw bought -> the buy happened before capture began (or in a
      // 20s slot-reuse blind spot). Profit on these reads too high and shouldn't be trusted.
      unmatchedSells: flips.filter((f) => f.sold > f.bought),
      // Still holding with nothing sold yet, and old enough that it's probably stuck rather
      // than simply in progress.
      stalled: flips.filter(
        (f) =>
          f.status !== "FINISHED" &&
          f.firstBuyTime != null &&
          Math.floor(Date.now() / 1000) - f.firstBuyTime > 24 * 60 * 60,
      ),
      captureStartedAt,
    };
  });
}
