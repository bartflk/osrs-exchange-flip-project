import { useEffect, useMemo, useState, type MouseEvent } from "react";
import {
  postBankValue,
  saveBankImport,
  listBankImports,
  getBankImport,
  deleteBankImport,
  type BankValueResponse,
  type BankValueItem,
  type BankImportSummary,
} from "../api";
import { parseBankText, type ParsedBankEntry } from "../bankParse";
import { formatGp, formatAgo } from "../format";

function iconUrl(icon: string): string {
  if (!icon) return "";
  return `https://oldschool.runescape.wiki/images/${encodeURIComponent(icon.replace(/ /g, "_"))}`;
}

type SortKey = "name" | "qty" | "unitValue" | "highAlchValue" | "value" | "netValue";
type StatusFilter = "all" | "calculated" | "estimated" | "uncalculated";

export function BankImport({
  onUseAsBankroll,
  onHoldingsChange,
}: {
  onUseAsBankroll: (value: number) => void;
  onHoldingsChange?: (items: BankValueItem[]) => void;
}) {
  const [text, setText] = useState("");
  // Accumulated across possibly-multiple pastes (e.g. one export per bank tab, if Bank
  // Memory only captures tabs you've actually opened) -- keyed by item id, quantities sum.
  const [accumulated, setAccumulated] = useState<Map<number, ParsedBankEntry>>(new Map());
  const [result, setResult] = useState<BankValueResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [skipped, setSkipped] = useState<string[]>([]);
  const [showSkipped, setShowSkipped] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [importedAt, setImportedAt] = useState<number | null>(null);
  const [viewingSavedId, setViewingSavedId] = useState<number | null>(null);
  const [history, setHistory] = useState<BankImportSummary[]>([]);
  const [deletingId, setDeletingId] = useState<number | null>(null);
  const [itemFilter, setItemFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [sortKey, setSortKey] = useState<SortKey>("value");
  const [sortDir, setSortDir] = useState<1 | -1>(-1);

  function toggleSort(key: SortKey) {
    if (key === sortKey) {
      setSortDir((d) => (d === 1 ? -1 : 1));
    } else {
      setSortKey(key);
      setSortDir(key === "name" ? 1 : -1);
    }
  }

  const filteredItems = useMemo(() => {
    if (!result) return [];
    let rows = result.items;
    if (itemFilter.trim()) {
      const needle = itemFilter.toLowerCase();
      rows = rows.filter((it) => it.name.toLowerCase().includes(needle));
    }
    if (statusFilter === "calculated") rows = rows.filter((it) => it.priced && !it.estimated);
    else if (statusFilter === "estimated") rows = rows.filter((it) => it.estimated);
    else if (statusFilter === "uncalculated") rows = rows.filter((it) => !it.priced && !it.estimated);

    const sorted = [...rows].sort((a, b) => {
      let av: number | string;
      let bv: number | string;
      if (sortKey === "name") {
        av = a.name.toLowerCase();
        bv = b.name.toLowerCase();
        return av < bv ? -sortDir : av > bv ? sortDir : 0;
      }
      av = (a[sortKey] ?? -Infinity) as number;
      bv = (b[sortKey] ?? -Infinity) as number;
      return (av - bv) * sortDir;
    });
    return sorted;
  }, [result, itemFilter, statusFilter, sortKey, sortDir]);

  function refreshHistory(): Promise<BankImportSummary[]> {
    return listBankImports()
      .then((res) => {
        setHistory(res.imports);
        return res.imports;
      })
      .catch(() => []);
  }

  // On first load, show whatever was last saved instead of an empty tab -- this is meant to
  // work like a normal "my bank" page, not just a one-shot import tool.
  useEffect(() => {
    refreshHistory().then((imports) => {
      if (imports.length > 0) handleViewSaved(imports[0].id);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function valueEntries(entries: Map<number, ParsedBankEntry>) {
    setLoading(true);
    setError(null);
    setViewingSavedId(null);
    try {
      const res = await postBankValue([...entries.values()]);
      setResult(res);
      setImportedAt(Math.floor(Date.now() / 1000));
      onHoldingsChange?.(res.items);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to value bank");
    } finally {
      setLoading(false);
    }
  }

  async function handleParse(source: string, mode: "replace" | "add") {
    const { entries, error: parseError, skipped: skippedLines } = parseBankText(source);
    setSkipped(skippedLines);
    if (parseError) {
      setError(parseError);
      return;
    }
    setError(null);

    const next = mode === "replace" ? new Map<number, ParsedBankEntry>() : new Map(accumulated);
    for (const e of entries) {
      const existing = next.get(e.id);
      next.set(e.id, {
        id: e.id,
        qty: (existing?.qty ?? 0) + e.qty,
        name: e.name ?? existing?.name,
      });
    }
    setAccumulated(next);
    await valueEntries(next);
  }

  function handleClear() {
    setAccumulated(new Map());
    setResult(null);
    setText("");
    setError(null);
    setSkipped([]);
    setViewingSavedId(null);
  }

  async function handlePasteFromClipboard(mode: "replace" | "add") {
    try {
      const clip = await navigator.clipboard.readText();
      setText(clip);
      await handleParse(clip, mode);
    } catch {
      setError("Couldn't read the clipboard — paste manually into the box instead.");
    }
  }

  async function handleSaveSnapshot() {
    if (accumulated.size === 0) return;
    setSaving(true);
    try {
      const res = await saveBankImport([...accumulated.values()]);
      setResult(res);
      setImportedAt(res.importedAt);
      setViewingSavedId(res.importId);
      onHoldingsChange?.(res.items);
      refreshHistory();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save snapshot");
    } finally {
      setSaving(false);
    }
  }

  async function handleViewSaved(id: number) {
    try {
      const res = await getBankImport(id);
      setResult(res);
      setImportedAt(res.importedAt);
      setViewingSavedId(id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load saved snapshot");
    }
  }

  async function handleDeleteSnapshot(id: number, e: MouseEvent) {
    e.stopPropagation();
    setDeletingId(id);
    try {
      await deleteBankImport(id);
      if (viewingSavedId === id) {
        setResult(null);
        setViewingSavedId(null);
        setImportedAt(null);
      }
      await refreshHistory();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete snapshot");
    } finally {
      setDeletingId(null);
    }
  }

  const tabsImported = accumulated.size > 0;

  return (
    <div className="space-y-4">
      <div className="glass rounded-xl p-4">
        <p className="text-sm text-gray-300 mb-2">
          In RuneLite, install the <span className="text-gray-100">Bank Memory</span> plugin, open your bank so it
          records it, then right-click in its panel and export item data (TSV: Item id / Item name / Item
          quantity). Paste it below.
        </p>
        <p className="text-xs text-amber-400/80 mb-2">
          If items are missing: Bank Memory keeps multiple saved snapshots (game-mode variants like "(League)"/
          "(Tournament)", plus any you've manually named) alongside the live one. Make sure you're right-clicking
          the top-most <span className="text-gray-300">"Current bank &lt;name&gt;"</span> entry under Saved Banks —
          not an older named snapshot — before choosing "Copy item data to clipboard," or you'll get a stale export.
          "Parse & add" below merges multiple pastes if you still need to combine snapshots.
        </p>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={"Item id\tItem name\tItem quantity\n4151\tAbyssal whip\t1\n..."}
          rows={6}
          className="glass rounded-lg w-full px-3 py-2 text-xs font-mono text-gray-200 placeholder:text-gray-600 outline-none"
        />
        <div className="flex items-center gap-3 mt-3 flex-wrap">
          <button
            onClick={() => handleParse(text, "replace")}
            disabled={loading}
            className="px-3 py-1.5 rounded-lg text-sm bg-white/10 hover:bg-white/15 text-white transition-colors disabled:opacity-50"
          >
            {loading ? "Valuing…" : "Parse & replace"}
          </button>
          <button
            onClick={() => handleParse(text, "add")}
            disabled={loading}
            className="px-3 py-1.5 rounded-lg text-sm bg-emerald-500/15 hover:bg-emerald-500/25 text-emerald-400 border border-emerald-500/30 transition-colors disabled:opacity-50"
          >
            Parse & add to total
          </button>
          <button
            onClick={() => handlePasteFromClipboard("add")}
            className="px-3 py-1.5 rounded-lg text-sm text-gray-300 hover:text-white hover:bg-white/5 transition-colors"
          >
            Read clipboard & add
          </button>
          {tabsImported && (
            <button onClick={handleClear} className="px-3 py-1.5 rounded-lg text-sm text-gray-500 hover:text-rose-400">
              Clear all
            </button>
          )}
          {error && <span className="text-xs text-rose-400">{error}</span>}
        </div>
        {skipped.length > 0 && (
          <div className="mt-2 text-xs">
            <button onClick={() => setShowSkipped((s) => !s)} className="text-amber-400 hover:text-amber-300">
              ⚠ {skipped.length} line{skipped.length === 1 ? "" : "s"} couldn't be read from that paste
              {showSkipped ? " — hide" : " — show"}
            </button>
            {showSkipped && (
              <pre className="mt-1 glass rounded-lg p-2 text-gray-400 whitespace-pre-wrap max-h-32 overflow-auto">
                {skipped.join("\n")}
              </pre>
            )}
          </div>
        )}
      </div>

      {result && (
        <div className="glass rounded-xl overflow-hidden">
          <div className="flex items-center justify-between px-4 py-3 border-b border-white/10">
            <div>
              <div className="text-xs text-gray-500 uppercase tracking-wide">
                {viewingSavedId ? `Saved snapshot #${viewingSavedId}` : "Current total"}
                {result.items.length > 0 && ` · ${result.items.length} unique items`}
              </div>
              <div className="text-2xl font-mono text-emerald-400">{formatGp(result.totalValue)}gp</div>
              <div className="text-xs text-gray-500" title="Sum of unitValue - GE tax (1%, capped at 5m/item, waived under 100gp) across every held item, i.e. what you'd actually walk away with instant-selling everything right now.">
                {formatGp(result.totalNetValue)}gp after GE tax
              </div>
              {importedAt && (
                <div className="text-xs text-gray-600">
                  {viewingSavedId ? "Saved" : "Last updated"} {formatAgo(importedAt)}
                </div>
              )}
            </div>
            <div className="flex items-center gap-2">
              {!viewingSavedId && tabsImported && (
                <button
                  onClick={handleSaveSnapshot}
                  disabled={saving}
                  className="px-3 py-1.5 rounded-lg text-sm bg-white/10 hover:bg-white/15 text-white transition-colors disabled:opacity-50"
                >
                  {saving ? "Saving…" : "Save snapshot to history"}
                </button>
              )}
              <button
                onClick={() => onUseAsBankroll(result.totalNetValue)}
                title="Uses the tax-adjusted total, since that's the capital you'd actually have to redeploy if you liquidated"
                className="px-3 py-1.5 rounded-lg text-sm bg-emerald-500/15 hover:bg-emerald-500/25 text-emerald-400 border border-emerald-500/30 transition-colors"
              >
                Use as Buy Signals bankroll
              </button>
            </div>
          </div>
          <div className="flex items-center gap-3 flex-wrap px-4 py-2 border-b border-white/10">
            <input
              type="text"
              placeholder="Filter items…"
              value={itemFilter}
              onChange={(e) => setItemFilter(e.target.value)}
              className="glass rounded-lg px-2 py-1 text-xs text-gray-100 placeholder:text-gray-500 outline-none w-48"
            />
            <div className="flex gap-1">
              {(["all", "calculated", "estimated", "uncalculated"] as StatusFilter[]).map((f) => (
                <button
                  key={f}
                  onClick={() => setStatusFilter(f)}
                  className={`px-2 py-1 rounded-md text-[11px] capitalize transition-colors ${
                    statusFilter === f ? "bg-white/10 text-white" : "text-gray-500 hover:text-gray-300"
                  }`}
                >
                  {f}
                </button>
              ))}
            </div>
            <span className="text-[11px] text-gray-600 ml-auto">
              {filteredItems.length} of {result.items.length} shown
            </span>
          </div>
          <div className="max-h-[50vh] overflow-auto">
            <table className="w-full text-sm text-left">
              <thead>
                <tr className="border-b border-white/10 text-gray-500 text-xs sticky top-0 bg-[#0f1015]/95 backdrop-blur">
                  {(
                    [
                      { key: "name", label: "Item" },
                      { key: "qty", label: "Qty" },
                      { key: "unitValue", label: "Unit value" },
                      { key: "highAlchValue", label: "High alch" },
                      { key: "value", label: "Value" },
                      { key: "netValue", label: "After tax" },
                    ] as { key: SortKey; label: string }[]
                  ).map((c) => (
                    <th
                      key={c.key}
                      onClick={() => toggleSort(c.key)}
                      className="px-4 py-2 font-medium cursor-pointer select-none hover:text-white"
                    >
                      {c.label} {sortKey === c.key ? (sortDir === 1 ? "▲" : "▼") : ""}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filteredItems.map((it) => {
                  const uncalculated = !it.priced && !it.estimated;
                  return (
                    <tr key={it.id} className="border-b border-white/5">
                      <td className="px-4 py-1.5 flex items-center gap-2" title={it.note}>
                        {it.icon && <img src={iconUrl(it.icon)} alt="" className="w-5 h-5 object-contain" />}
                        <span className={uncalculated ? "text-rose-400" : "text-gray-100"}>{it.name}</span>
                        {it.estimated && (
                          <span className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-400 border border-amber-500/30">
                            est.
                          </span>
                        )}
                        {uncalculated && (
                          <span className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-rose-500/15 text-rose-400 border border-rose-500/30">
                            not calculated
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-1.5 font-mono text-gray-300">{it.qty.toLocaleString()}</td>
                      <td className={`px-4 py-1.5 font-mono ${uncalculated ? "text-rose-400" : "text-gray-400"}`}>
                        {formatGp(it.unitValue)}
                      </td>
                      <td className="px-4 py-1.5 font-mono text-gray-500">{formatGp(it.highAlchValue)}</td>
                      <td className={`px-4 py-1.5 font-mono ${uncalculated ? "text-rose-400" : "text-gray-200"}`}>
                        {formatGp(it.value)}
                      </td>
                      <td className="px-4 py-1.5 font-mono text-gray-400">{formatGp(it.netValue)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {history.length > 0 && (
        <div className="glass rounded-xl overflow-hidden">
          <div className="px-4 py-3 border-b border-white/10 text-xs text-gray-500 uppercase tracking-wide">
            Import history
          </div>
          <table className="w-full text-sm text-left">
            <tbody>
              {history.map((h) => (
                <tr
                  key={h.id}
                  onClick={() => handleViewSaved(h.id)}
                  className={`border-b border-white/5 hover:bg-white/5 cursor-pointer ${
                    viewingSavedId === h.id ? "bg-white/5" : ""
                  }`}
                >
                  <td className="px-4 py-2 text-gray-400">{formatAgo(h.imported_at)}</td>
                  <td className="px-4 py-2 text-gray-500">{h.item_count} items</td>
                  <td className="px-4 py-2 font-mono text-gray-200 text-right">{formatGp(h.total_value)}gp</td>
                  <td className="px-4 py-2 text-right">
                    <button
                      onClick={(e) => handleDeleteSnapshot(h.id, e)}
                      disabled={deletingId === h.id}
                      className="text-xs text-gray-500 hover:text-rose-400 disabled:opacity-50"
                    >
                      {deletingId === h.id ? "Deleting…" : "Delete"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
