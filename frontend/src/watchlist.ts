export interface WatchEntry {
  itemId: number;
  addedAt: number;
  alertAbove: number | null;
  alertBelow: number | null;
}

const KEY = "watchlist";

export function loadWatchlist(): Record<number, WatchEntry> {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

export function saveWatchlist(entries: Record<number, WatchEntry>) {
  localStorage.setItem(KEY, JSON.stringify(entries));
}

export function toggleWatch(entries: Record<number, WatchEntry>, itemId: number): Record<number, WatchEntry> {
  const next = { ...entries };
  if (next[itemId]) {
    delete next[itemId];
  } else {
    next[itemId] = { itemId, addedAt: Date.now(), alertAbove: null, alertBelow: null };
  }
  saveWatchlist(next);
  return next;
}

export function updateWatchAlert(
  entries: Record<number, WatchEntry>,
  itemId: number,
  patch: Partial<Pick<WatchEntry, "alertAbove" | "alertBelow">>
): Record<number, WatchEntry> {
  const existing = entries[itemId];
  if (!existing) return entries;
  const next = { ...entries, [itemId]: { ...existing, ...patch } };
  saveWatchlist(next);
  return next;
}
