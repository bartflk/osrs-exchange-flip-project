import type { FastifyInstance } from "fastify";
import type { WebSocket } from "ws";
import { db } from "./db.js";
import { scoreItem, type ItemRow } from "./signals.js";
import { getPricePollTiming } from "./poller.js";
import { computeForecast } from "./forecast.js";
import { computeFlips, computePositions, computeSession, computeBuyLimitUsage } from "./flips.js";
import { getGeTransactions } from "./db.js";
import { getCaptureStartedAt } from "./geLedger.js";
import { readCopilotSlots, runeliteSourcesAvailable } from "./runeliteImport.js";

const itemQuery = db.prepare(`
  SELECT i.id, i.name, i.members, i.buy_limit, i.icon,
         s.high, s.low, s.vol_high_5m, s.vol_low_5m, s.vol_high_1h, s.vol_low_1h, s.updated_at
  FROM items i
  JOIN latest_snapshot s ON s.item_id = i.id
  WHERE s.high IS NOT NULL AND s.low IS NOT NULL
`);

const singleItemQuery = db.prepare(`
  SELECT i.id, i.name, i.members, i.buy_limit, i.icon,
         s.high, s.low, s.vol_high_5m, s.vol_low_5m, s.vol_high_1h, s.vol_low_1h, s.updated_at
  FROM items i
  JOIN latest_snapshot s ON s.item_id = i.id
  WHERE i.id = ?
`);

type ClientMessage =
  | { type: "status"; requestId?: string }
  | { type: "items"; requestId?: string; limit?: number; minScore?: number }
  | { type: "buy_recommendation"; requestId?: string }
  | { type: "item"; requestId?: string; itemId: number }
  | { type: "item_analysis"; requestId?: string; itemId: number }
  | { type: "portfolio"; requestId?: string }
  | { type: "history"; requestId?: string; itemId?: number; since?: number; limit?: number }
  | { type: "snapshot"; requestId?: string; itemId?: number }
  | { type: "subscribe"; requestId?: string; intervalMs?: number }
  | { type: "unsubscribe"; requestId?: string };

function send(socket: WebSocket, message: unknown) {
  if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message));
}

function status() {
  const itemCount = (db.prepare("SELECT COUNT(*) as c FROM items").get() as { c: number }).c;
  const lastUpdate = db.prepare("SELECT MAX(updated_at) as t FROM latest_snapshot").get() as {
    t: number | null;
  };
  const { nextPricePollAt } = getPricePollTiming();
  return { itemCount, lastUpdate: lastUpdate.t, nextPricePollAt };
}

function getItems(limit = 50, minScore = 0) {
  const items = (itemQuery.all() as unknown as ItemRow[])
    .map(scoreItem)
    .filter((item) => item.net_margin != null && item.score >= minScore)
    .sort((left, right) => right.score - left.score);
  return items.slice(0, Math.min(Math.max(limit, 1), 300));
}

function getBuyRecommendation() {
  const item = getItems(300).find((candidate) => (candidate.execution_margin ?? 0) > 0);
  if (!item || item.execution_buy_price == null || item.execution_sell_price == null || item.execution_margin == null) {
    return null;
  }
  const quantity = item.buy_limit ?? 1;
  return {
    action: "BUY",
    itemId: item.id,
    itemName: item.name,
    quantity,
    offerPrice: item.execution_buy_price,
    expectedSellPrice: item.execution_sell_price,
    expectedProfitEach: item.execution_margin,
    expectedProfitTotal: item.execution_margin * quantity,
    roiPct: item.roi_pct == null ? null : item.roi_pct * 100,
    score: item.score,
    buyLimit: item.buy_limit,
    marketUpdatedAt: item.updated_at,
  };
}

function getPortfolio() {
  const positions = computePositions();
  const slots = readCopilotSlots();
  const assetsValue = positions.reduce((sum, position) => sum + (position.marketValue ?? 0), 0);
  const cashInBuyOffers = slots.reduce(
    (sum, slot) => sum + (slot.type === "buy" ? (slot.total_quantity - slot.quantity_sold) * slot.price : 0),
    0,
  );
  return {
    positions,
    slots,
    buyLimits: computeBuyLimitUsage(),
    totals: {
      assetsValue,
      cashInBuyOffers,
      unrealizedProfit: positions.reduce((sum, position) => sum + (position.unrealizedProfit ?? 0), 0),
      uniqueItems: positions.length,
      slotsUsed: slots.length,
      freeSlots: Math.max(0, 8 - slots.length),
    },
    session: computeSession(Math.floor(Date.now() / 1000) - 24 * 60 * 60),
    sources: runeliteSourcesAvailable(),
    captureStartedAt: getCaptureStartedAt(),
  };
}

function getHistory(itemId?: number, since = 0, limit = 500) {
  const max = Math.min(Math.max(limit, 1), 2_000);
  const transactions = itemId == null
    ? getGeTransactions(since, max)
    : getGeTransactions(since, max).filter((transaction) => transaction.item_id === itemId);
  const priceHistory = itemId == null
    ? []
    : db.prepare(
        "SELECT ts, high, low, avg_high_5m, avg_low_5m FROM price_history WHERE item_id = ? ORDER BY ts DESC LIMIT ?",
      ).all(itemId, max);
  return { itemId: itemId ?? null, priceHistory, transactions, flips: itemId == null ? [] : computeFlips().filter((flip) => flip.itemId === itemId) };
}

function getItemAnalysis(itemId: number) {
  const item = singleItemQuery.get(itemId) as unknown as ItemRow | undefined;
  if (!item) return null;
  const scored = scoreItem(item);
  return {
    market: scored,
    profit: {
      netMargin: scored.net_margin,
      executionMargin: scored.execution_margin,
      tax: scored.tax,
      roiPct: scored.roi_pct,
      limitAdjustedProfit: scored.limit_adjusted_profit,
    },
    prediction: scored.high == null ? null : computeForecast(itemId, scored.high),
    recommendation: scored.execution_margin != null && scored.execution_margin > 0
      ? {
          action: "BUY",
          quantity: scored.buy_limit ?? 1,
          offerPrice: scored.execution_buy_price,
          expectedSellPrice: scored.execution_sell_price,
        }
      : null,
    history: getHistory(itemId),
  };
}

function getSnapshot(itemId?: number) {
  return {
    market: { items: getItems(300) },
    scoring: { model: "scoreItem", ranked: true },
    recommendations: { items: getItems(50).filter((item) => (item.execution_margin ?? 0) > 0) },
    portfolio: getPortfolio(),
    history: getHistory(),
    itemAnalysis: itemId == null ? null : getItemAnalysis(itemId),
  };
}

function parseMessage(raw: string): ClientMessage | null {
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object" || !("type" in value)) return null;
    return value as ClientMessage;
  } catch {
    return null;
  }
}

export async function runeliteWebsocket(app: FastifyInstance) {
  app.get("/ws/runelite", { websocket: true }, (connection) => {
    const socket = connection.socket;
    let updateTimer: ReturnType<typeof setInterval> | undefined;

    send(socket, {
      type: "hello",
      protocol: 1,
      capabilities: [
        "status",
        "market_data",
        "scoring",
        "buy_recommendation",
        "predictions",
        "recommendations",
        "profit_calculations",
        "portfolio_analysis",
        "history",
        "item_analysis",
        "snapshot",
        "market_subscription",
      ],
      serverTime: Date.now(),
    });

    const stopSubscription = () => {
      if (updateTimer) clearInterval(updateTimer);
      updateTimer = undefined;
    };

    const sendMarketUpdate = () => {
      const items = getItems(300);
      send(socket, {
        type: "market_update",
        market: { items },
        scoring: { model: "scoreItem", ranked: true },
        recommendations: { items: items.filter((item) => (item.execution_margin ?? 0) > 0).slice(0, 50) },
      });
    };

    socket.on("message", (raw) => {
      const message = parseMessage(raw.toString());
      if (!message) {
        send(socket, { type: "error", error: "message must be valid JSON with a type" });
        return;
      }

      const requestId = "requestId" in message ? message.requestId : undefined;
      try {
        if (message.type === "status") {
          send(socket, { type: "response", requestId, ok: true, data: status() });
        } else if (message.type === "items") {
          send(socket, {
            type: "response",
            requestId,
            ok: true,
            data: { items: getItems(message.limit, message.minScore) },
          });
        } else if (message.type === "buy_recommendation") {
          send(socket, { type: "response", requestId, ok: true, data: getBuyRecommendation() });
        } else if (message.type === "item") {
          const item = singleItemQuery.get(message.itemId) as unknown as ItemRow | undefined;
          if (!item) {
            send(socket, { type: "response", requestId, ok: false, error: "item not found" });
            return;
          }
          send(socket, { type: "response", requestId, ok: true, data: scoreItem(item) });
        } else if (message.type === "item_analysis") {
          const analysis = getItemAnalysis(message.itemId);
          if (!analysis) {
            send(socket, { type: "response", requestId, ok: false, error: "item not found" });
            return;
          }
          send(socket, { type: "response", requestId, ok: true, data: analysis });
        } else if (message.type === "portfolio") {
          send(socket, { type: "response", requestId, ok: true, data: getPortfolio() });
        } else if (message.type === "history") {
          send(socket, { type: "response", requestId, ok: true, data: getHistory(message.itemId, message.since, message.limit) });
        } else if (message.type === "snapshot") {
          send(socket, { type: "response", requestId, ok: true, data: getSnapshot(message.itemId) });
        } else if (message.type === "subscribe") {
          stopSubscription();
          const intervalMs = Math.min(Math.max(message.intervalMs ?? 60_000, 5_000), 300_000);
          sendMarketUpdate();
          updateTimer = setInterval(sendMarketUpdate, intervalMs);
          send(socket, { type: "response", requestId, ok: true, data: { intervalMs } });
        } else if (message.type === "unsubscribe") {
          stopSubscription();
          send(socket, { type: "response", requestId, ok: true, data: { subscribed: false } });
        } else {
          send(socket, { type: "response", requestId, ok: false, error: "unsupported message type" });
        }
      } catch (error) {
        app.log.error(error);
        send(socket, { type: "response", requestId, ok: false, error: "request failed" });
      }
    });

    socket.on("close", stopSubscription);
    socket.on("error", stopSubscription);
  });
}
