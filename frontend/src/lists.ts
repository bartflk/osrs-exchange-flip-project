// Direct request, modeled on FlipSmart's "Passive Flips (above 10M)" / "Overnight" / "Tax-Free
// Passive Flips" browsable watchlists: named, user-editable collections of items, distinct from
// the existing single starred watchlist.ts (one flat set, no naming) and blocklist.ts (never-
// recommend). Same flat-localStorage load/save shape as those two, just keyed by list id with an
// itemIds array instead of by item id directly -- see App.tsx for the one-time starter-list seed.
export interface ItemList {
  id: string;
  name: string;
  itemIds: number[];
  createdAt: number;
}

const KEY = "itemLists";

export function loadLists(): ItemList[] {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

export function saveLists(lists: ItemList[]) {
  localStorage.setItem(KEY, JSON.stringify(lists));
}

function makeId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function createList(lists: ItemList[], name: string, itemIds: number[] = []): ItemList[] {
  const next = [...lists, { id: makeId(), name, itemIds, createdAt: Date.now() }];
  saveLists(next);
  return next;
}

export function renameList(lists: ItemList[], id: string, name: string): ItemList[] {
  const next = lists.map((l) => (l.id === id ? { ...l, name } : l));
  saveLists(next);
  return next;
}

export function deleteList(lists: ItemList[], id: string): ItemList[] {
  const next = lists.filter((l) => l.id !== id);
  saveLists(next);
  return next;
}

export function addItemToList(lists: ItemList[], id: string, itemId: number): ItemList[] {
  const next = lists.map((l) =>
    l.id === id && !l.itemIds.includes(itemId) ? { ...l, itemIds: [...l.itemIds, itemId] } : l,
  );
  saveLists(next);
  return next;
}

export function removeItemFromList(lists: ItemList[], id: string, itemId: number): ItemList[] {
  const next = lists.map((l) =>
    l.id === id ? { ...l, itemIds: l.itemIds.filter((i) => i !== itemId) } : l,
  );
  saveLists(next);
  return next;
}

export function isItemInAnyList(lists: ItemList[], itemId: number): boolean {
  return lists.some((l) => l.itemIds.includes(itemId));
}
