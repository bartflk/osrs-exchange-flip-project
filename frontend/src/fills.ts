// Lightweight fill log -- when a tracked GE offer (offers.ts) actually goes through, "I bought
// it" / "I sold it" moves it here instead of just deleting it, so there's a small record of what
// actually happened (not just what was planned). Same manual/local-only shape as offers.ts: no
// RuneLite export exists to detect fills automatically, so the user confirms by hand. Distinct
// from the automatic recommendation_snapshots scorekeeping (DESIGN.md §10 item 1) -- that tracks
// whether the app's own picks were good; this tracks what the user actually did.
export interface Fill {
  id: string;
  type: "buy" | "sell";
  itemName: string;
  price: number;
  qty: number;
  filledAt: number; // unix seconds
}

const KEY = "geFills";
const MAX_FILLS = 50;

export function loadFills(): Fill[] {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

export function saveFills(fills: Fill[]) {
  localStorage.setItem(KEY, JSON.stringify(fills.slice(0, MAX_FILLS)));
}
