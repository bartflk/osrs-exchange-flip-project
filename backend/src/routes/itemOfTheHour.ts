import type { FastifyInstance } from "fastify";
import {
  computeItemOfTheHour,
  currentSlot,
  slotLabel,
  slotProfileCoverage,
  refreshSlotProfiles,
} from "../slotProfiles.js";

// DESIGN.md §14.44: "best item to buy" for a given half-hour of the UTC day.

export async function itemOfTheHourRoutes(app: FastifyInstance) {
  app.get("/api/item-of-the-hour", async (req) => {
    const { slot, limit } = req.query as { slot?: string; limit?: string };
    const requested = Number(slot);
    // Default to now, but allow browsing any slot -- "what should I be buying at 03:00" is a
    // planning question as much as a live one.
    const useSlot = Number.isInteger(requested) && requested >= 0 && requested < 48 ? requested : currentSlot();
    const coverage = slotProfileCoverage();

    return {
      slot: useSlot,
      slotLabel: slotLabel(useSlot),
      currentSlot: currentSlot(),
      picks: computeItemOfTheHour(useSlot, Math.min(Number(limit) || 12, 40)),
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
}
