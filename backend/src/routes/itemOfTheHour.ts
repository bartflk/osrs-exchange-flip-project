import type { FastifyInstance } from "fastify";
import { getSlotProfile, getPairedDays } from "../db.js";
import { geTax } from "../signals.js";
import { median } from "../stats.js";
import {
  DEFAULT_BANKROLL,
  computeItemOfTheHour,
  computeOvernightPicks,
  currentSlot,
  slotLabel,
  slotProfileCoverage,
  refreshSlotProfiles,
} from "../slotProfiles.js";

// DESIGN.md §14.44: "best item to buy" for a given half-hour of the UTC day.

// §14.46: the bankroll is the caller's, and it changes the answer completely -- at 10m the best
// pick is a high-volume cheap item, at 300m it is a big-ticket weapon whose buy limit lets you
// deploy the capital. Passed per request rather than stored server-side because it lives in the
// frontend's localStorage alongside the allocator's own bankroll setting.
function parseBankroll(raw: string | undefined): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_BANKROLL;
}

export async function itemOfTheHourRoutes(app: FastifyInstance) {
  app.get("/api/item-of-the-hour", async (req) => {
    const { slot, limit, bankroll } = req.query as {
      slot?: string;
      limit?: string;
      bankroll?: string;
    };
    const requested = Number(slot);
    // Default to now, but allow browsing any slot -- "what should I be buying at 03:00" is a
    // planning question as much as a live one.
    const useSlot = Number.isInteger(requested) && requested >= 0 && requested < 48 ? requested : currentSlot();
    const coverage = slotProfileCoverage();

    return {
      slot: useSlot,
      slotLabel: slotLabel(useSlot),
      currentSlot: currentSlot(),
      picks: computeItemOfTheHour(useSlot, Math.min(Number(limit) || 12, 40), parseBankroll(bankroll)),
      bankroll: parseBankroll(bankroll),
      itemsProfiled: coverage.items,
      lastRun: coverage.lastRun,
    };
  });

  // Manual kick, mostly so the first run doesn't have to wait for the scheduled one. Returns
  // immediately -- the job takes minutes (one API request per item, deliberately spaced).
  app.post("/api/item-of-the-hour/refresh", async () => {
    refreshSlotProfiles(true).catch((err) => app.log.error(err, "slot profile refresh failed"));
    return { started: true };
  });

  // Overnight Trading, Phase 1: same slot-profile method as Item of the Hour, but the sell-slot
  // search is capped to an actual overnight hold window (default 8h) instead of the whole day.
  app.get("/api/overnight-picks", async (req) => {
    const { bedtimeSlot, maxHoldHours, limit, bankroll } = req.query as {
      bedtimeSlot?: string;
      maxHoldHours?: string;
      limit?: string;
      bankroll?: string;
    };
    const requestedSlot = Number(bedtimeSlot);
    const useSlot =
      Number.isInteger(requestedSlot) && requestedSlot >= 0 && requestedSlot < 48
        ? requestedSlot
        : currentSlot();
    // Clamp to a genuinely "overnight" range (2-14h) -- outside that this isn't the feature
    // being asked for, it's just Item of the Hour with extra steps.
    const requestedHours = Number(maxHoldHours);
    const hours = Number.isFinite(requestedHours) ? Math.min(14, Math.max(2, requestedHours)) : 8;
    const maxHoldSlots = Math.round(hours * 2);
    const coverage = slotProfileCoverage();

    return {
      bedtimeSlot: useSlot,
      bedtimeSlotLabel: slotLabel(useSlot),
      currentSlot: currentSlot(),
      maxHoldHours: hours,
      picks: computeOvernightPicks(
        useSlot,
        maxHoldSlots,
        Math.min(Number(limit) || 8, 20),
        parseBankroll(bankroll),
      ),
      bankroll: parseBankroll(bankroll),
      itemsProfiled: coverage.items,
      profiledItems: coverage.profiledItems,
      lastRun: coverage.lastRun,
    };
  });

  // The shape behind a single pick: the item's whole 48-slot day, plus the day-by-day outcomes
  // of the specific buy->sell pair being proposed. Everything here is already computed and stored
  // -- no Wiki request -- it simply was never exposed, so a pick could be read but not seen.
  //
  // Both halves matter and they answer different questions. The 48 slots say "is this a real
  // daily shape or noise"; the paired days say "how often did this actually work". A chart of the
  // first without the second is the §14.51 mistake drawn in pixels.
  app.get("/api/items/:id/slot-profile", async (req, reply) => {
    const itemId = Number((req.params as { id: string }).id);
    if (!Number.isInteger(itemId)) return reply.code(400).send({ error: "bad item id" });

    const profile = getSlotProfile(itemId);
    if (!profile.length) return reply.code(404).send({ error: "no slot profile for this item" });

    const { buySlot, sellSlot } = req.query as { buySlot?: string; sellSlot?: string };
    const b = Number(buySlot);
    const sl = Number(sellSlot);
    const havePair =
      Number.isInteger(b) && b >= 0 && b < 48 && Number.isInteger(sl) && sl >= 0 && sl < 48;

    const paired = havePair
      ? getPairedDays(itemId, b, sl).map((d) => ({
          day: d.day,
          buy: Math.round(d.buy),
          sell: Math.round(d.sell),
          // Same arithmetic the ranking uses, returned per day so the chart and the table can
          // never disagree about what a day was worth.
          profit: Math.round(d.sell - geTax(Math.round(d.sell)) - d.buy),
        }))
      : [];
    paired.sort((x, y) => (x.day < y.day ? -1 : x.day > y.day ? 1 : 0));

    const profits = paired.map((d) => d.profit);
    const spanDays =
      paired.length > 0
        ? Math.round(
            (Date.parse(paired[paired.length - 1].day + "T00:00:00Z") -
              Date.parse(paired[0].day + "T00:00:00Z")) /
              86_400_000,
          ) + 1
        : 0;

    return {
      itemId,
      updatedAt: profile[0]?.updated_at ?? null,
      slots: profile.map((r) => ({
        slot: r.slot,
        slotLabel: slotLabel(r.slot),
        buyPrice: r.buy_price,
        sellPrice: r.sell_price,
        volume: r.volume,
        days: r.days,
      })),
      buySlot: havePair ? b : null,
      sellSlot: havePair ? sl : null,
      paired,
      pairedDays: paired.length,
      winDays: profits.filter((x) => x > 0).length,
      spanDays,
      medianProfit: profits.length ? Math.round(median(profits) ?? 0) : null,
    };
  });
}
