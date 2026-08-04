import type { BankValueItem } from "./api";

// Snapshot of the most recent bank valuation (current paste or a viewed saved import),
// keyed by item id, so any part of the UI (e.g. the item detail modal) can answer
// "do I currently hold this?" without re-fetching bank state. Persisted so it survives
// a reload without requiring a re-paste.
export type HoldingEntry = Pick<BankValueItem, "qty" | "unitValue" | "value" | "netValue" | "priced">;

const KEY = "bankHoldings";

export function loadHoldings(): Record<number, HoldingEntry> {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

export function saveHoldings(items: BankValueItem[]) {
  const next: Record<number, HoldingEntry> = {};
  for (const it of items) {
    if (it.qty > 0) {
      next[it.id] = { qty: it.qty, unitValue: it.unitValue, value: it.value, netValue: it.netValue, priced: it.priced };
    }
  }
  localStorage.setItem(KEY, JSON.stringify(next));
  return next;
}
