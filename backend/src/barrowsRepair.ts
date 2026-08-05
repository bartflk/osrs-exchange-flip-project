import { db } from "./db.js";
import { geTax } from "./signals.js";

// DESIGN.md §10 item 16: Barrows Repair Flip -- buy a fully-degraded "0%" piece cheap, pay to
// repair it to 100%, sell the repaired (un-degraded) piece. Repair cost formula sourced directly
// from the OSRS Wiki (https://oldschool.runescape.wiki/w/Barrows_equipment), not guessed: base
// repair cost = internal degradation (0-1000) x a per-slot multiplier (weapon 100, body 90,
// legs 80, helm 60). A "0%" item is fully degraded (1000/1000), so a full repair back to 100%
// costs the full 1000 x multiplier at the standard Barrows-chest/NPC rate. A player-owned-house
// armour stand offers a Smithing-level discount (cost x (1 - level/200)) -- not modeled here since
// this app has no account/skill data; the NPC rate is the conservative (worse-case) baseline, so
// real repair cost via an armour stand would only ever be cheaper than what's shown.
const SLOT_MULTIPLIER: Record<"weapon" | "body" | "legs" | "helm", number> = {
  weapon: 100,
  body: 90,
  legs: 80,
  helm: 60,
};
const FULL_DEGRADATION = 1000;

interface BarrowsPiece {
  degradedName: string; // GE item name of the fully-degraded "0" variant
  repairedName: string; // GE item name of the repaired (undegraded) piece
  slot: keyof typeof SLOT_MULTIPLIER;
}

const BARROWS_PIECES: BarrowsPiece[] = [
  { degradedName: "Ahrim's hood 0", repairedName: "Ahrim's hood", slot: "helm" },
  { degradedName: "Ahrim's robetop 0", repairedName: "Ahrim's robetop", slot: "body" },
  { degradedName: "Ahrim's robeskirt 0", repairedName: "Ahrim's robeskirt", slot: "legs" },
  { degradedName: "Ahrim's staff 0", repairedName: "Ahrim's staff", slot: "weapon" },
  { degradedName: "Dharok's helm 0", repairedName: "Dharok's helm", slot: "helm" },
  { degradedName: "Dharok's platebody 0", repairedName: "Dharok's platebody", slot: "body" },
  { degradedName: "Dharok's platelegs 0", repairedName: "Dharok's platelegs", slot: "legs" },
  { degradedName: "Dharok's greataxe 0", repairedName: "Dharok's greataxe", slot: "weapon" },
  { degradedName: "Guthan's helm 0", repairedName: "Guthan's helm", slot: "helm" },
  { degradedName: "Guthan's platebody 0", repairedName: "Guthan's platebody", slot: "body" },
  { degradedName: "Guthan's chainskirt 0", repairedName: "Guthan's chainskirt", slot: "legs" },
  { degradedName: "Guthan's warspear 0", repairedName: "Guthan's warspear", slot: "weapon" },
  { degradedName: "Karil's coif 0", repairedName: "Karil's coif", slot: "helm" },
  { degradedName: "Karil's leathertop 0", repairedName: "Karil's leathertop", slot: "body" },
  { degradedName: "Karil's leatherskirt 0", repairedName: "Karil's leatherskirt", slot: "legs" },
  { degradedName: "Karil's crossbow 0", repairedName: "Karil's crossbow", slot: "weapon" },
  { degradedName: "Torag's helm 0", repairedName: "Torag's helm", slot: "helm" },
  { degradedName: "Torag's platebody 0", repairedName: "Torag's platebody", slot: "body" },
  { degradedName: "Torag's platelegs 0", repairedName: "Torag's platelegs", slot: "legs" },
  { degradedName: "Torag's hammers 0", repairedName: "Torag's hammers", slot: "weapon" },
  { degradedName: "Verac's helm 0", repairedName: "Verac's helm", slot: "helm" },
  { degradedName: "Verac's brassard 0", repairedName: "Verac's brassard", slot: "body" },
  { degradedName: "Verac's plateskirt 0", repairedName: "Verac's plateskirt", slot: "legs" },
  { degradedName: "Verac's flail 0", repairedName: "Verac's flail", slot: "weapon" },
];

interface PriceRow {
  high: number | null;
  low: number | null;
}

const priceStmt = db.prepare(`
  SELECT s.high AS high, s.low AS low
  FROM items i JOIN latest_snapshot s ON s.item_id = i.id
  WHERE i.name = ?
`);

export interface BarrowsRepairResult {
  degradedName: string;
  repairedName: string;
  degradedBuy: number;
  repairCost: number;
  repairedSell: number;
  profit: number;
}

export function computeBarrowsRepairFlips(): BarrowsRepairResult[] {
  const results: BarrowsRepairResult[] = [];

  for (const piece of BARROWS_PIECES) {
    const degraded = priceStmt.get(piece.degradedName) as PriceRow | undefined;
    const repaired = priceStmt.get(piece.repairedName) as PriceRow | undefined;
    if (!degraded || degraded.low == null) continue;
    if (!repaired || repaired.high == null) continue;

    const repairCost = FULL_DEGRADATION * SLOT_MULTIPLIER[piece.slot];
    const profit = repaired.high - geTax(repaired.high) - degraded.low - repairCost;

    results.push({
      degradedName: piece.degradedName,
      repairedName: piece.repairedName,
      degradedBuy: degraded.low,
      repairCost,
      repairedSell: repaired.high,
      profit,
    });
  }

  results.sort((a, b) => b.profit - a.profit);
  return results;
}
