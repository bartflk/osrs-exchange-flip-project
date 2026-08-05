export interface ParsedBankEntry {
  id: number;
  qty: number;
  name?: string;
}

/**
 * Parses bank export text into {id, qty} pairs. Primary target is the RuneLite
 * "Bank Memory" plugin's clipboard export, which is TSV with a header row:
 *   Item id\tItem name\tItem quantity
 * Falls back to a couple of other common shapes (bare "id\tqty" TSV/CSV lines, or a
 * JSON array of {id|itemId, qty|quantity}) since exact plugin output can vary/change.
 */
export function parseBankText(text: string): {
  entries: ParsedBankEntry[];
  error: string | null;
  skipped: string[];
} {
  const trimmed = text.trim();
  if (!trimmed) return { entries: [], error: "Paste something first.", skipped: [] };

  // Try JSON first.
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed);
      const arr = Array.isArray(parsed) ? parsed : Object.values(parsed);
      const entries = arr
        .map((row: Record<string, unknown>) => {
          const id = Number(row.id ?? row.itemId ?? row.item_id);
          const qty = Number(row.qty ?? row.quantity ?? row.amount ?? 1);
          return { id, qty };
        })
        .filter((e) => Number.isFinite(e.id) && Number.isFinite(e.qty) && e.qty > 0);
      if (entries.length === 0)
        return {
          entries: [],
          error: "Couldn't find id/quantity fields in that JSON.",
          skipped: [],
        };
      return { entries, error: null, skipped: [] };
    } catch {
      return { entries: [], error: "That looked like JSON but didn't parse.", skipped: [] };
    }
  }

  // TSV/CSV: "Item id\tItem name\tItem quantity" (Bank Memory plugin) or bare "id\tqty".
  const lines = trimmed.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const entries: ParsedBankEntry[] = [];
  const skipped: string[] = [];
  for (const line of lines) {
    const cols = line.split(/\t|,/).map((c) => c.trim());
    if (/^item\s*id$/i.test(cols[0])) continue; // header row
    if (cols.length < 2) {
      skipped.push(line);
      continue;
    }

    const id = Number(cols[0]);
    // Quantities sometimes render with thousands separators depending on the export
    // path -- strip them before parsing rather than silently dropping the line.
    const qty = Number(cols[cols.length - 1].replace(/,/g, ""));
    const name = cols.length >= 3 ? cols.slice(1, -1).join(" ") : undefined;
    if (Number.isFinite(id) && Number.isFinite(qty) && qty > 0) {
      entries.push({ id, qty, name });
    } else {
      skipped.push(line);
    }
  }

  if (entries.length === 0) {
    return {
      entries: [],
      error:
        "Couldn't parse that. Expected the Bank Memory plugin's TSV export (Item id / Item name / Item quantity columns) or a JSON array of {id, qty}.",
      skipped,
    };
  }
  return { entries, error: null, skipped };
}
