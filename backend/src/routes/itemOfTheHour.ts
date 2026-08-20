import type { FastifyInstance } from "fastify";
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
      lastRun: coverage.lastRun,
    };
  });
}
