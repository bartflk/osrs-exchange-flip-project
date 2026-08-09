import {
  getGeSlotStates,
  upsertGeSlotStates,
  insertGeTransactions,
  kvGet,
  kvSet,
  type GeSlotState,
  type NewGeTransaction,
} from "./db.js";
import { readCopilotSlots, readFlippingUtilitiesHistory } from "./runeliteImport.js";

// DESIGN.md §14.40: turn observed GE slot state into a transaction ledger.
//
// The core fact this rests on: for a given offer sitting in a given slot, `quantitySold` only
// ever increases, and `spent` increases with it. So if the same offer (same slot, item, price,
// direction) is seen twice with a higher quantity the second time, the difference IS a fill --
// deterministically, not as an inference. That keeps this in the same "plain documented formula"
// category as every other signal in the app (§1): no ML, no guessing.
//
// The price recorded is the *realised* one, `deltaSpent / deltaQuantity`, not the offer price.
// They differ constantly and materially: a buy offer at 830 that fills against sellers at 827
// spends 827/unit, and using the offer price would quietly overstate every buy's cost and
// understate every flip's profit.

const CAPTURE_START_KEY = "ledger:captureStartedAt";
const FU_BACKFILL_KEY = "ledger:flippingUtilitiesBackfilled";

function slotKey(s: { account_hash: string; slot: number }): string {
  return `${s.account_hash}:${s.slot}`;
}

// Is this the same offer we saw last time, or has the slot been reused for something new?
// Price is part of the identity because repricing an offer in OSRS means cancelling and
// re-placing it -- a changed price is always a different offer, never the same one updated.
function isSameOffer(a: GeSlotState, b: GeSlotState): boolean {
  return a.item_id === b.item_id && a.type === b.type && a.price === b.price;
}

export interface SlotSyncResult {
  slotsRead: number;
  transactionsInserted: number;
}

/**
 * Read the live GE slots and record any fills that happened since the last read.
 *
 * Deliberately records nothing on the first sighting of a slot. An offer that is already
 * partially filled when we first see it carries no information about *when* those units filled,
 * and writing them all at `now` would fabricate a timestamp -- which would then show up as a
 * fake spike on the profit graph and a wrong entry in Visualize Flip. Instead the first read
 * establishes a baseline and `captureStartedAt` is recorded, so every view can honestly say
 * "history known since X" (which is exactly how Flipping Copilot's own Missed Flips tab handles
 * the same limitation).
 */
export function syncGeSlots(): SlotSyncResult {
  const current = readCopilotSlots();
  if (!current.length) return { slotsRead: 0, transactionsInserted: 0 };

  if (!kvGet(CAPTURE_START_KEY)) {
    kvSet(CAPTURE_START_KEY, String(Math.floor(Date.now() / 1000)));
  }

  const previous = new Map(getGeSlotStates().map((s) => [slotKey(s), s]));
  const transactions: NewGeTransaction[] = [];

  for (const slot of current) {
    const prev = previous.get(slotKey(slot));

    // First sighting, or the slot now holds a different offer than it did last poll. Either way
    // there is no trustworthy baseline to diff against, so just adopt the new state. When a slot
    // is reused, any units the old offer filled between our last two polls are genuinely lost --
    // that 60s blind spot is the one thing the RuneLite plugin in Design/RUNELITE_PLUGIN_GUIDE.md
    // actually buys us, since it gets every state change as it happens.
    if (!prev || !isSameOffer(prev, slot)) continue;

    const deltaQty = slot.quantity_sold - prev.quantity_sold;
    if (deltaQty <= 0) continue;

    const deltaSpent = slot.spent - prev.spent;
    // Fall back to the offer price only if `spent` didn't move with the quantity, which would
    // mean the file is inconsistent rather than that the items were free.
    const unitPrice = deltaSpent > 0 ? Math.round(deltaSpent / deltaQty) : slot.price;

    transactions.push({
      account_hash: slot.account_hash,
      item_id: slot.item_id,
      type: slot.type,
      quantity: deltaQty,
      price: unitPrice,
      spent: deltaSpent > 0 ? deltaSpent : unitPrice * deltaQty,
      slot: slot.slot,
      occurred_at: slot.observed_at,
      source: "slot-diff",
    });
  }

  const inserted = insertGeTransactions(transactions);
  upsertGeSlotStates(current);
  return { slotsRead: current.length, transactionsInserted: inserted };
}

/**
 * One-time import of Flipping Utilities' local trade history.
 *
 * Guarded by a kv flag purely to avoid the log noise of re-reading it every boot -- the UNIQUE
 * constraint on ge_transactions already makes a repeat import a no-op, so correctness doesn't
 * depend on the flag.
 */
export function backfillFlippingUtilities(force = false): number {
  if (!force && kvGet(FU_BACKFILL_KEY)) return 0;
  const rows = readFlippingUtilitiesHistory();
  const inserted = insertGeTransactions(rows);
  kvSet(FU_BACKFILL_KEY, String(Math.floor(Date.now() / 1000)));
  return inserted;
}

/** Unix seconds from which the ledger is actually complete. Null if capture never ran. */
export function getCaptureStartedAt(): number | null {
  const row = kvGet(CAPTURE_START_KEY);
  return row ? Number(row.value) : null;
}
