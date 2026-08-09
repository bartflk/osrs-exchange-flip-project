import { readFileSync, readdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { NewGeTransaction, GeSlotState } from "./db.js";

// DESIGN.md §14.40 / §6.6 (corrected): reads the GE trade data RuneLite plugins already write to
// local disk. §6.6 previously concluded, after a research pass, that "no local live-offer export
// exists" and that open offers therefore had to stay a manual paste tool. That was true of the
// plugins surveyed at the time, and is false now: Flipping Copilot writes one JSON file per GE
// slot, live. This module is the correction.
//
// Two sources, deliberately different jobs:
//   - Flipping Copilot  -> live slot state (what's on the GE right now). No local history: its
//                          trade log is server-side, and the local `un_acked.jsonl` is a transient
//                          upload buffer that clears once acked, so it can't be relied on.
//   - Flipping Utilities -> local trade history (what already happened). Fully local and OSS.
//
// Everything here is read-only file access. The game client is not involved at all, which is why
// this carries no account risk whatsoever -- see Design/RUNELITE_PLUGIN_GUIDE.md.

const RUNELITE_DIR = path.join(homedir(), ".runelite");
const COPILOT_DIR = path.join(RUNELITE_DIR, "flipping-copilot");
const FLIPPING_UTILS_DIR = path.join(RUNELITE_DIR, "flipping");

// Shape of Flipping Copilot's per-slot file. Field names map 1:1 onto RuneLite's own
// GrandExchangeOffer getters (getItemId/getPrice/getTotalQuantity/getQuantitySold/getSpent/
// getState), which is how we know it's a faithful dump of the client's offer object rather than
// something reinterpreted.
interface CopilotSlotFile {
  itemId: number;
  quantitySold: number;
  totalQuantity: number;
  price: number;
  spent: number;
  state: string; // BUYING | SELLING | BOUGHT | SOLD | CANCELLED_BUY | CANCELLED_SELL | EMPTY
}

function isBuyState(state: string): boolean {
  return state === "BUYING" || state === "BOUGHT" || state === "CANCELLED_BUY";
}

/**
 * Current contents of all 8 GE slots, as last written by Flipping Copilot.
 *
 * Returns [] rather than throwing when the plugin isn't installed -- this whole feature is
 * additive, and the app has to stay fully usable without it (same "additive, not load-bearing"
 * principle as the Reddit collector in §14.35).
 */
export function readCopilotSlots(): GeSlotState[] {
  if (!existsSync(COPILOT_DIR)) return [];
  const now = Math.floor(Date.now() / 1000);
  const out: GeSlotState[] = [];

  let files: string[];
  try {
    files = readdirSync(COPILOT_DIR);
  } catch {
    return [];
  }

  for (const file of files) {
    // acc_<accountHash>_<slot>.json -- the sibling `_prefs`/`_paused` files match the acc_ prefix
    // too, so the slot component has to be numeric to be a real slot file.
    const m = /^acc_(\d+)_(\d+)\.json$/.exec(file);
    if (!m) continue;
    const [, accountHash, slotStr] = m;

    let parsed: CopilotSlotFile;
    try {
      parsed = JSON.parse(readFileSync(path.join(COPILOT_DIR, file), "utf8"));
    } catch {
      continue; // a half-written file mid-flush is expected, just skip this cycle
    }
    if (!parsed || typeof parsed.itemId !== "number" || parsed.itemId <= 0) continue;

    out.push({
      account_hash: accountHash,
      slot: Number(slotStr),
      item_id: parsed.itemId,
      type: isBuyState(parsed.state) ? "buy" : "sell",
      price: parsed.price ?? 0,
      total_quantity: parsed.totalQuantity ?? 0,
      quantity_sold: parsed.quantitySold ?? 0,
      spent: parsed.spent ?? 0,
      state: parsed.state ?? "UNKNOWN",
      observed_at: now,
    });
  }
  return out;
}

// --- Flipping Utilities history -------------------------------------------------------------
//
// Schema learned by reading the file directly (the project documents no format). Abbreviated
// keys, confirmed against observed values:
//   trades[]      one entry per item ever traded
//     .id         item id        .name   item name
//     .h.sO[]     the offer events for that item ("standardized offers")
//       .uuid     unique per offer   .b   true = buy
//       .cQIT     quantity actually transacted   .tQIT  the offer's total quantity
//       .p        price per unit     .t    timestamp (ms)
//       .s        GE slot            .st   BOUGHT|SOLD|CANCELLED_BUY|CANCELLED_SELL|BUYING|SELLING
//     .fB         the account it belongs to (display name, not a hash)

interface FuOffer {
  uuid?: string;
  b?: boolean;
  id?: number;
  cQIT?: number;
  tQIT?: number;
  p?: number;
  t?: number;
  s?: number;
  st?: string;
}

interface FuTrade {
  id?: number;
  name?: string;
  fB?: string;
  h?: { sO?: FuOffer[] };
}

interface FuFile {
  trades?: FuTrade[];
  sessionStartTime?: number;
  accumulatedSessionTimeMillis?: number;
}

/**
 * One-time backfill of trade history from Flipping Utilities.
 *
 * Grouped by offer `uuid` and reduced to the highest `cQIT` seen: if the file ever records
 * several events for one offer as it fills, the quantities are cumulative, not additive, so
 * summing them would inflate every partially-filled trade. Taking the max is correct whether
 * there's one event per offer or many, which avoids depending on an undocumented guarantee.
 */
export function readFlippingUtilitiesHistory(): NewGeTransaction[] {
  if (!existsSync(FLIPPING_UTILS_DIR)) return [];

  let files: string[];
  try {
    files = readdirSync(FLIPPING_UTILS_DIR);
  } catch {
    return [];
  }

  const out: NewGeTransaction[] = [];
  for (const file of files) {
    // Account files are "<DisplayName>.json"; skip the plugin's own bookkeeping files.
    if (!file.endsWith(".json")) continue;
    if (file.includes(".backup.") || file === "accountwide.json" || file.includes("Checkpoints")) {
      continue;
    }

    let parsed: FuFile;
    try {
      parsed = JSON.parse(readFileSync(path.join(FLIPPING_UTILS_DIR, file), "utf8"));
    } catch {
      continue;
    }

    const account = path.basename(file, ".json");
    for (const trade of parsed.trades ?? []) {
      const byUuid = new Map<string, FuOffer>();
      for (const offer of trade.h?.sO ?? []) {
        if (!offer || typeof offer.t !== "number") continue;
        const qty = offer.cQIT ?? 0;
        if (qty <= 0) continue; // cancelled with nothing filled -- not a transaction
        const key = offer.uuid ?? `${offer.t}:${offer.s}:${offer.p}`;
        const prev = byUuid.get(key);
        if (!prev || (prev.cQIT ?? 0) < qty) byUuid.set(key, offer);
      }

      for (const offer of byUuid.values()) {
        const itemId = offer.id ?? trade.id;
        const qty = offer.cQIT ?? 0;
        const price = offer.p ?? 0;
        if (!itemId || qty <= 0 || price <= 0) continue;
        out.push({
          account_hash: account,
          item_id: itemId,
          type: offer.b ? "buy" : "sell",
          quantity: qty,
          price,
          spent: qty * price,
          slot: offer.s ?? null,
          occurred_at: Math.floor(offer.t! / 1000),
          source: "flipping-utilities",
        });
      }
    }
  }
  return out;
}

export function runeliteSourcesAvailable(): { copilot: boolean; flippingUtilities: boolean } {
  return {
    copilot: existsSync(COPILOT_DIR),
    flippingUtilities: existsSync(FLIPPING_UTILS_DIR),
  };
}
