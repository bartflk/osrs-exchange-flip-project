import type { OvernightPlan } from "./geSlots";

// Overnight plans outlive the settings that produced them, and they have to.
//
// A plan is only present in the live pick list while the item still qualifies under the CURRENT
// bankroll, risk preset, bedtime slot and hold window. That is fine for choosing what to buy and
// wrong for everything afterwards: the moment you place the offer and then nudge any of those
// settings, the plan disappears and the board goes back to telling you to reprice an offer you
// deliberately placed below market. Found exactly that way -- an offer matching its plan to
// 0.00% was still flagged "7.8% below market" because a different bankroll had dropped the item
// out of the pick list.
//
// So plans are remembered as they are shown, and looked up by item id afterwards. The GE offer
// itself is the thing being explained; it does not stop being an overnight position because a
// slider moved.

const KEY = "overnightPlans";
// Long enough to cover any overnight hold plus the morning after, short enough that a plan from
// last week never explains today's offer -- the underlying slot profile refreshes every 12h, so
// a stale plan is a claim about prices that no longer exist.
const TTL_MS = 48 * 60 * 60 * 1000;

interface StoredPlan extends OvernightPlan {
  savedAt: number;
}

function load(): Record<string, StoredPlan> {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as Record<string, StoredPlan>) : {};
  } catch {
    return {};
  }
}

function prune(store: Record<string, StoredPlan>): Record<string, StoredPlan> {
  const cutoff = Date.now() - TTL_MS;
  const next: Record<string, StoredPlan> = {};
  for (const [id, plan] of Object.entries(store)) {
    if (plan.savedAt >= cutoff) next[id] = plan;
  }
  return next;
}

/**
 * Remember the plans currently on screen, then return every plan still in date -- the fresh ones
 * overlaying anything stored earlier, so a re-computed plan always wins over a remembered one.
 */
export function rememberPlans(current: OvernightPlan[]): Map<number, OvernightPlan> {
  const store = prune(load());
  const now = Date.now();
  for (const plan of current) {
    store[String(plan.itemId)] = { ...plan, savedAt: now };
  }
  try {
    localStorage.setItem(KEY, JSON.stringify(store));
  } catch {
    // A full or unavailable localStorage must not take the board down with it -- the plans in
    // `current` still work for this render, they just won't survive a reload.
  }

  const map = new Map<number, OvernightPlan>();
  for (const plan of Object.values(store)) {
    // Copied field-by-field originally, which silently dropped buySlot/sellSlot the moment they
    // were added to OvernightPlan: the store held them, the Map handed to the component did not,
    // and the chart quietly stopped rendering while the status kept working. Destructure `savedAt`
    // off instead, so a new field on OvernightPlan is carried through without being re-listed.
    const { savedAt: _savedAt, ...rest } = plan;
    map.set(plan.itemId, rest);
  }
  return map;
}
