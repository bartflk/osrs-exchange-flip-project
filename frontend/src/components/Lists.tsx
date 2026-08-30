import { useEffect, useMemo, useState } from "preact/hooks";
import { fetchItems, type MarketItem } from "../api";
import { formatGp, formatPct } from "../format";
import {
  type ItemList,
  loadLists,
  createList,
  renameList,
  deleteList,
  removeItemFromList,
} from "../lists";
import { EmptyState } from "./ui";

// Direct request, modeled on FlipSmart's named, browsable watchlists ("Passive Flips (above
// 10M)", "Overnight", "Tax-Free Passive Flips"): personal named item collections, distinct from
// the single starred watchlist. Starter lists are seeded once in App.tsx (the only place with the
// full loaded catalogue); this page just browses/manages whatever lists exist. Items are added to
// a list from ItemDetailModal's "Add to list" control, not from here.

function iconUrl(icon: string | null | undefined): string {
  if (!icon) return "";
  return `https://oldschool.runescape.wiki/images/${encodeURIComponent(icon.replace(/ /g, "_"))}`;
}

export function Lists({
  items,
  onSelectItem,
}: {
  items: MarketItem[];
  onSelectItem: (item: MarketItem) => void;
}) {
  const [lists, setLists] = useState<ItemList[]>(() => loadLists());
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [newListName, setNewListName] = useState("");
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");

  useEffect(() => {
    if (!selectedId && lists.length > 0) setSelectedId(lists[0].id);
  }, [lists, selectedId]);

  const selected = lists.find((l) => l.id === selectedId) ?? null;

  // A list can reference items the Market tab's current filter excluded (e.g. below its
  // liquidity floor) -- same "fetch what's missing by id" pattern already used for the
  // watchlist/held-items lookups in App.tsx, rather than silently dropping rows.
  const [fetchedItems, setFetchedItems] = useState<Record<number, MarketItem>>({});
  useEffect(() => {
    if (!selected) return;
    const known = new Set(items.map((i) => i.id));
    const missing = selected.itemIds.filter((id) => !known.has(id) && !fetchedItems[id]);
    if (missing.length === 0) return;
    let cancelled = false;
    fetchItems({ ids: missing })
      .then((res) => {
        if (cancelled) return;
        setFetchedItems((prev) => {
          const next = { ...prev };
          for (const it of res.items) next[it.id] = it;
          return next;
        });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.id, items]);

  const rows = useMemo(() => {
    if (!selected) return [];
    const byId = new Map(items.map((i) => [i.id, i]));
    return selected.itemIds
      .map((id) => byId.get(id) ?? fetchedItems[id] ?? null)
      .filter((i): i is MarketItem => i != null);
  }, [selected, items, fetchedItems]);

  function handleCreate() {
    const name = newListName.trim();
    if (!name) return;
    setLists(createList(lists, name));
    setNewListName("");
  }

  function handleRenameCommit(id: string) {
    const name = renameDraft.trim();
    if (name) setLists(renameList(lists, id, name));
    setRenamingId(null);
  }

  function handleDelete(id: string) {
    setLists(deleteList(lists, id));
    if (selectedId === id) setSelectedId(null);
  }

  function handleRemoveItem(itemId: number) {
    if (!selected) return;
    setLists(removeItemFromList(lists, selected.id, itemId));
  }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-[260px_1fr] gap-4 items-start">
      <div className="glass rounded-xl p-3">
        <div className="text-xs uppercase tracking-wide text-gray-500 mb-2 px-1">Your lists</div>
        <div className="space-y-1 mb-3">
          {lists.map((l) => (
            <div
              key={l.id}
              className={`group flex items-center gap-1 rounded-lg ${
                selectedId === l.id ? "bg-white/10" : "hover:bg-white/5"
              }`}
            >
              {renamingId === l.id ? (
                <input
                  autoFocus
                  value={renameDraft}
                  onInput={(e) => setRenameDraft((e.target as HTMLInputElement).value)}
                  onBlur={() => handleRenameCommit(l.id)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") handleRenameCommit(l.id);
                    if (e.key === "Escape") setRenamingId(null);
                  }}
                  className="flex-1 min-w-0 bg-transparent px-2.5 py-1.5 text-sm text-gray-100 outline-none"
                />
              ) : (
                <button
                  onClick={() => setSelectedId(l.id)}
                  className="flex-1 min-w-0 text-left px-2.5 py-1.5 text-sm text-gray-200 truncate"
                >
                  {l.name}
                  <span className="text-gray-600 text-xs ml-1.5">{l.itemIds.length}</span>
                </button>
              )}
              <button
                onClick={() => {
                  setRenamingId(l.id);
                  setRenameDraft(l.name);
                }}
                title="Rename"
                className="opacity-0 group-hover:opacity-100 text-gray-500 hover:text-gray-200 text-xs px-1.5 transition-opacity"
              >
                ✎
              </button>
              <button
                onClick={() => handleDelete(l.id)}
                title="Delete list"
                className="opacity-0 group-hover:opacity-100 text-gray-500 hover:text-rose-400 text-xs px-1.5 pr-2 transition-opacity"
              >
                ✕
              </button>
            </div>
          ))}
          {lists.length === 0 && (
            <p className="text-xs text-gray-600 px-1 py-2">No lists yet, create one below.</p>
          )}
        </div>
        <div className="flex items-center gap-1.5 border-t border-white/10 pt-2">
          <input
            value={newListName}
            onInput={(e) => setNewListName((e.target as HTMLInputElement).value)}
            onKeyDown={(e) => e.key === "Enter" && handleCreate()}
            placeholder="New list name…"
            className="flex-1 min-w-0 glass rounded-lg px-2.5 py-1.5 text-xs text-gray-100 placeholder:text-gray-500 outline-none"
          />
          <button
            onClick={handleCreate}
            className="px-2.5 py-1.5 rounded-lg text-xs bg-violet-500/15 text-violet-300 hover:bg-violet-500/25 border border-violet-500/30"
          >
            + New
          </button>
        </div>
      </div>

      <div className="glass rounded-xl p-4 min-h-[300px]">
        {!selected ? (
          <EmptyState
            title="No list selected"
            hint="Create a list on the left, or add an item to one from its detail view (+ List)."
          />
        ) : rows.length === 0 ? (
          <EmptyState
            title={`${selected.name} is empty`}
            hint={`Open an item's detail view and use the "+ List" control to add it here.`}
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-[11px] uppercase tracking-wide text-gray-500 text-left">
                  <th className="pb-2 pr-3 font-medium">Item</th>
                  <th className="pb-2 pr-3 font-medium text-right">Buy</th>
                  <th className="pb-2 pr-3 font-medium text-right">Sell</th>
                  <th className="pb-2 pr-3 font-medium text-right">Margin</th>
                  <th className="pb-2 pr-3 font-medium text-right">ROI</th>
                  <th className="pb-2 pr-3 font-medium text-right">Liquidity/hr</th>
                  <th className="pb-2 font-medium text-right"></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((item) => (
                  <tr key={item.id} className="border-t border-white/5 hover:bg-white/5">
                    <td className="py-2 pr-3">
                      <button
                        onClick={() => onSelectItem(item)}
                        className="flex items-center gap-2 text-gray-200 hover:text-white hover:underline text-left"
                      >
                        {item.icon && (
                          <img src={iconUrl(item.icon)} alt="" className="w-4 h-4 object-contain" />
                        )}
                        {item.name}
                      </button>
                    </td>
                    <td className="py-2 pr-3 text-right font-mono text-gray-300">
                      {formatGp(item.low)}
                    </td>
                    <td className="py-2 pr-3 text-right font-mono text-gray-300">
                      {formatGp(item.high)}
                    </td>
                    <td
                      className={`py-2 pr-3 text-right font-mono ${(item.net_margin ?? 0) >= 0 ? "text-emerald-400" : "text-rose-400"}`}
                    >
                      {formatGp(item.net_margin)}
                    </td>
                    <td
                      className={`py-2 pr-3 text-right font-mono ${(item.roi_pct ?? 0) >= 0 ? "text-emerald-400" : "text-rose-400"}`}
                    >
                      {formatPct(item.roi_pct)}
                    </td>
                    <td className="py-2 pr-3 text-right font-mono text-gray-400">
                      {Math.round(item.liquidity).toLocaleString()}
                    </td>
                    <td className="py-2 text-right">
                      <button
                        onClick={() => handleRemoveItem(item.id)}
                        title="Remove from this list"
                        className="text-gray-600 hover:text-rose-400 text-xs px-1.5"
                      >
                        ✕
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
