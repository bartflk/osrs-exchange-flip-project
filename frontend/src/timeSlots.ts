// DESIGN.md §14.49: half-hour slots are stored and computed in UTC (the game's clock, and the
// only sane basis for a market-wide time-of-day analysis), but nobody plans their evening in UTC.
// These render a slot in the viewer's own timezone, with UTC kept alongside rather than dropped --
// the underlying data, the API, and every DESIGN.md note are all in UTC, so silently switching
// would make the UI and the docs disagree.
//
// The zone comes from the browser, not a hardcoded offset. That gets DST right for free (a fixed
// +2 for Amsterdam would be an hour wrong from late October) and follows the user if they travel.

/** Slot 0-47 -> "HH:MM" in UTC. Mirrors slotLabel() on the backend. */
export function slotToUtcLabel(slot: number): string {
  const h = Math.floor(slot / 2);
  const m = slot % 2 === 0 ? "00" : "30";
  return `${String(h).padStart(2, "0")}:${m}`;
}

/**
 * A UTC slot rendered in local time.
 *
 * `dayOffset` matters for a bedtime picker: 23:30 UTC is 01:30 the *next* local day in Amsterdam,
 * and showing a bare "01:30" would have you plan for the wrong night.
 */
export function slotToLocal(slot: number): { label: string; dayOffset: number } {
  const utcHour = Math.floor(slot / 2);
  const utcMinute = slot % 2 === 0 ? 0 : 30;
  // Anchored to today, because the offset is date-dependent under DST and "tonight" is what's
  // being planned.
  const d = new Date();
  d.setUTCHours(utcHour, utcMinute, 0, 0);
  // Forced 24-hour: the UTC half of every label is 24-hour, and "10:30 PM · 20:30 UTC" makes the
  // reader do a conversion to check the two agree. Also matches how OSRS and the Netherlands both
  // write time, rather than deferring to whatever locale the browser happens to report.
  const label = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  // Compare calendar dates in each zone rather than doing offset arithmetic by hand.
  const localDay = d.getDate();
  const utcDay = d.getUTCDate();
  let dayOffset = 0;
  if (localDay !== utcDay) {
    // Month/year boundaries make a raw date subtraction unreliable; the sign is all we need.
    const diff = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() -
      Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
    dayOffset = diff > 0 ? 1 : -1;
  }
  return { label, dayOffset };
}

/** "22:30 (+1d)" when the local rendering lands on another day, else "22:30". */
export function slotToLocalLabel(slot: number): string {
  const { label, dayOffset } = slotToLocal(slot);
  if (dayOffset === 0) return label;
  return `${label} (${dayOffset > 0 ? "+1d" : "-1d"})`;
}

// Deliberately removed: slots used to render as "03:30 · 01:30 UTC", and the zone was printed
// next to every time as "(GMT+2)". Direct instruction: *"stop using the GMT +2 and all that random
// stuff, Just use my local time"*. The data is still keyed on UTC internally and every conversion
// still goes through slotToLocal() -- that is an implementation detail of where the numbers come
// from, and putting it on screen made every timestamp twice as long to read for no decision it
// ever changed. One clock, the reader's.

/** Short zone name for headers, e.g. "GMT+2". Falls back silently if unavailable. */
export function localZoneLabel(): string {
  try {
    const parts = new Intl.DateTimeFormat([], { timeZoneName: "short" }).formatToParts(new Date());
    return parts.find((p) => p.type === "timeZoneName")?.value ?? "local";
  } catch {
    return "local";
  }
}

/** Convert an "HH:MM" UTC label (as the API returns) into the dual rendering. */
export function utcLabelToSlot(label: string): number {
  const [h, m] = label.split(":").map(Number);
  return h * 2 + (m >= 30 ? 1 : 0);
}

// §14.50: the current slot, computed from the browser clock.
//
// This used to come from the API response and was read once when the component mounted, so the
// "now" default froze at whatever half-hour the page happened to load in and drifted further the
// longer the tab stayed open. Observed live: at 23:01 local the bedtime picker still read
// 22:30, because the page had been loaded at ~22:40.
//
// "What half-hour is it" needs no server round trip -- the browser knows, and computing it
// locally means it can also tick.
export function currentSlotNow(): number {
  const d = new Date();
  return d.getUTCHours() * 2 + (d.getUTCMinutes() >= 30 ? 1 : 0);
}

/** Milliseconds until the next half-hour boundary, so the tick lands on the rollover. */
export function msUntilNextSlot(): number {
  const d = new Date();
  const mins = d.getUTCMinutes();
  const next = mins < 30 ? 30 : 60;
  return ((next - mins) * 60 - d.getUTCSeconds()) * 1000 - d.getMilliseconds() + 250;
}

// Milliseconds until the next occurrence of a half-hour slot, wrapping to tomorrow when it has
// already passed today. Slots are indices into the UTC day, so the arithmetic is done in UTC and
// only rendered in local time -- doing it the other way round breaks on any DST boundary.
export function msUntilSlot(slot: number): number {
  const now = new Date();
  const target = new Date(now);
  target.setUTCHours(Math.floor(slot / 2), slot % 2 === 0 ? 0 : 30, 0, 0);
  if (target.getTime() <= now.getTime()) target.setUTCDate(target.getUTCDate() + 1);
  return target.getTime() - now.getTime();
}

/** "14h 20m", "45m", or "now" -- a wait, not a clock time. */
export function formatWait(ms: number): string {
  if (ms <= 0) return "now";
  const totalMinutes = Math.round(ms / 60000);
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  if (h === 0) return `${m}m`;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}
