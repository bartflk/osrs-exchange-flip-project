import { db } from "./db.js";
import { geTax } from "./signals.js";

// DESIGN.md §10 item 15: Set Conversion Arbitrage -- buy pieces separately and sell as the
// combined set ("combine"), or buy the set and sell the pieces separately ("decombine"),
// whichever direction is currently profitable. Fully deterministic against data already local --
// no new data source, just a curated set->pieces mapping (there are ~105 GE-combinable "set"
// items total; this covers the high-value/high-interest subset worth flipping, not all of them --
// extend SET_DEFINITIONS if a specific set you care about is missing).
export interface SetDefinition {
  setName: string;
  pieceNames: string[];
}

export const SET_DEFINITIONS: SetDefinition[] = [
  {
    setName: "Ahrim's armour set",
    pieceNames: ["Ahrim's hood", "Ahrim's robetop", "Ahrim's robeskirt", "Ahrim's staff"],
  },
  {
    setName: "Dharok's armour set",
    pieceNames: ["Dharok's helm", "Dharok's platebody", "Dharok's platelegs", "Dharok's greataxe"],
  },
  {
    setName: "Guthan's armour set",
    pieceNames: ["Guthan's helm", "Guthan's platebody", "Guthan's chainskirt", "Guthan's warspear"],
  },
  {
    setName: "Karil's armour set",
    pieceNames: ["Karil's coif", "Karil's leathertop", "Karil's leatherskirt", "Karil's crossbow"],
  },
  {
    setName: "Torag's armour set",
    pieceNames: ["Torag's helm", "Torag's platebody", "Torag's platelegs", "Torag's hammers"],
  },
  {
    setName: "Verac's armour set",
    pieceNames: ["Verac's helm", "Verac's brassard", "Verac's plateskirt", "Verac's flail"],
  },
  {
    setName: "Torva armour set",
    pieceNames: ["Torva full helm", "Torva platebody", "Torva platelegs"],
  },
  {
    setName: "Virtus armour set",
    pieceNames: ["Virtus mask", "Virtus robe top", "Virtus robe bottom"],
  },
  {
    setName: "Masori armour set (f)",
    pieceNames: ["Masori mask (f)", "Masori body (f)", "Masori chaps (f)"],
  },
  {
    setName: "Bloodbark armour set",
    pieceNames: [
      "Bloodbark helm",
      "Bloodbark body",
      "Bloodbark legs",
      "Bloodbark gauntlets",
      "Bloodbark boots",
    ],
  },
  // DESIGN.md §14.11/§14.14: these three sets each bundle a weapon too, not just 3 armour
  // pieces -- confirmed via the OSRS Wiki ("a Blood moon helm, Blood moon chestplate, Blood moon
  // tassets and Dual macuahuitl") and cross-checked against live prices (the set-vs-3-pieces gap
  // matched the weapon's own price almost exactly). Omitting it understated pieceCost by the
  // weapon's full value, inflating combineProfit by millions.
  {
    setName: "Blood moon armour set",
    pieceNames: [
      "Blood moon helm",
      "Blood moon chestplate",
      "Blood moon tassets",
      "Dual macuahuitl",
    ],
  },
  {
    setName: "Blue moon armour set",
    pieceNames: ["Blue moon helm", "Blue moon chestplate", "Blue moon tassets", "Blue moon spear"],
  },
  {
    setName: "Eclipse moon armour set",
    pieceNames: [
      "Eclipse moon helm",
      "Eclipse moon chestplate",
      "Eclipse moon tassets",
      "Eclipse atlatl",
    ],
  },
  {
    setName: "Justiciar armour set",
    pieceNames: ["Justiciar faceguard", "Justiciar chestguard", "Justiciar legguards"],
  },
  {
    setName: "Inquisitor's armour set",
    pieceNames: ["Inquisitor's great helm", "Inquisitor's hauberk", "Inquisitor's plateskirt"],
  },
  {
    setName: "Obsidian armour set",
    pieceNames: ["Obsidian helmet", "Obsidian platebody", "Obsidian platelegs"],
  },
  {
    setName: "Dragonstone armour set",
    pieceNames: [
      "Dragonstone full helm",
      "Dragonstone platebody",
      "Dragonstone platelegs",
      "Dragonstone gauntlets",
      "Dragonstone boots",
    ],
  },
];

interface PriceRow {
  name: string;
  high: number | null;
  low: number | null;
}

const priceStmt = db.prepare(`
  SELECT i.name AS name, s.high AS high, s.low AS low
  FROM items i JOIN latest_snapshot s ON s.item_id = i.id
  WHERE i.name = ?
`);

// Per-item cost/tax breakdown -- a piece's own buy/sell price plus the GE tax charged on
// *its* sale specifically (geTax is per-transaction, not a flat rate applied to the total), so
// the UI can show exactly where the profit is won or lost rather than just an aggregate number.
export interface PieceBreakdown {
  name: string;
  buy: number;
  sell: number;
  tax: number; // geTax(sell) -- what selling this one piece costs in GE tax
}

export interface SetArbitrageResult {
  setName: string;
  pieceNames: string[];
  setBuy: number;
  setSell: number;
  setTax: number; // geTax(setSell) -- tax on selling the assembled set as one transaction
  pieceCost: number; // sum of piece buy (low) prices
  pieceRevenue: number; // sum of piece sell (high) prices, pre-tax
  pieces: PieceBreakdown[];
  combineProfit: number; // buy pieces, sell as set
  decombineProfit: number; // buy set, sell pieces
  bestDirection: "combine" | "decombine";
  bestProfit: number;
}

export function computeSetArbitrage(): SetArbitrageResult[] {
  const results: SetArbitrageResult[] = [];

  for (const def of SET_DEFINITIONS) {
    const setPrice = priceStmt.get(def.setName) as PriceRow | undefined;
    if (!setPrice || setPrice.high == null || setPrice.low == null) continue;

    const pieces: PriceRow[] = [];
    let missing = false;
    for (const pieceName of def.pieceNames) {
      const p = priceStmt.get(pieceName) as PriceRow | undefined;
      if (!p || p.high == null || p.low == null) {
        missing = true;
        break;
      }
      pieces.push(p);
    }
    if (missing) continue;

    const pieceCost = pieces.reduce((sum, p) => sum + (p.low ?? 0), 0);
    const pieceRevenue = pieces.reduce((sum, p) => sum + (p.high ?? 0), 0);
    const pieceRevenueAfterTax = pieces.reduce((sum, p) => sum + (p.high! - geTax(p.high!)), 0);
    const setTax = geTax(setPrice.high);

    const pieceBreakdown: PieceBreakdown[] = pieces.map((p, i) => ({
      name: def.pieceNames[i],
      buy: p.low!,
      sell: p.high!,
      tax: geTax(p.high!),
    }));

    // Combine: buy every piece at its low, sell the assembled set at its high (taxed once, as one sale).
    const combineProfit = setPrice.high - setTax - pieceCost;
    // Decombine: buy the set at its low, sell every piece separately at its high (taxed per piece).
    const decombineProfit = pieceRevenueAfterTax - setPrice.low;

    const bestDirection: "combine" | "decombine" =
      combineProfit >= decombineProfit ? "combine" : "decombine";
    const bestProfit = Math.max(combineProfit, decombineProfit);

    results.push({
      setName: def.setName,
      pieceNames: def.pieceNames,
      setBuy: setPrice.low,
      setSell: setPrice.high,
      setTax,
      pieceCost,
      pieceRevenue,
      pieces: pieceBreakdown,
      combineProfit,
      decombineProfit,
      bestDirection,
      bestProfit,
    });
  }

  results.sort((a, b) => b.bestProfit - a.bestProfit);
  return results;
}
