// DESIGN.md §10 item 19: never-recommend list, same localStorage pattern as watchlist.ts.
// Filters Buy Signals and the Capital Allocator so items you never want to trade (bad past
// experience, too illiquid for your taste, whatever) stop showing up as suggestions.
export interface BlockEntry {
  itemId: number;
  name: string;
  icon: string;
  addedAt: number;
}

const KEY = "blocklist";

export function loadBlocklist(): Record<number, BlockEntry> {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

export function saveBlocklist(entries: Record<number, BlockEntry>) {
  localStorage.setItem(KEY, JSON.stringify(entries));
}

export function toggleBlock(
  entries: Record<number, BlockEntry>,
  item: { id: number; name: string; icon: string },
): Record<number, BlockEntry> {
  const next = { ...entries };
  if (next[item.id]) {
    delete next[item.id];
  } else {
    next[item.id] = { itemId: item.id, name: item.name, icon: item.icon, addedAt: Date.now() };
  }
  saveBlocklist(next);
  return next;
}

export function removeFromBlocklist(
  entries: Record<number, BlockEntry>,
  itemId: number,
): Record<number, BlockEntry> {
  const next = { ...entries };
  delete next[itemId];
  saveBlocklist(next);
  return next;
}
