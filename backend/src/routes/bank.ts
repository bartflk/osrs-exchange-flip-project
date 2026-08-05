import type { FastifyInstance } from "fastify";
import { db } from "../db.js";
import { geTax } from "../signals.js";

interface BankRow {
  id: number;
  name: string;
  icon: string;
  value: number;
  highalch: number | null;
  low: number | null;
  high: number | null;
}

interface BankEntry {
  id: number;
  qty: number;
  name?: string;
}

interface ValuedItem {
  id: number;
  name: string;
  icon: string;
  qty: number;
  unitValue: number;
  value: number;
  // Tax-adjusted: what you'd actually walk away with if you instant-sold this stack right now,
  // i.e. value minus the 1% GE tax (capped at 5m/item, waived under 100gp -- see signals.ts geTax).
  netUnitValue: number;
  netValue: number;
  priced: boolean;
  estimated?: boolean;
  note?: string;
  highAlch: number | null;
  highAlchValue: number | null;
}

// GE tax applies per-unit at the moment of sale, so a stack's total tax is qty * tax(unitPrice) --
// not tax(unitPrice * qty), since the 5,000,000gp cap applies per individual item sold, not per offer.
function netOf(unitValue: number, qty: number): { netUnitValue: number; netValue: number } {
  const taxPerUnit = geTax(unitValue);
  const netUnitValue = unitValue - taxPerUnit;
  return { netUnitValue, netValue: netUnitValue * qty };
}

// A handful of very common cases where the exact held item (a charged weapon, a combined
// weapon, etc.) is untradeable but one or more specific OTHER items are a well-known stand-in
// for its value -- either a direct "inactive"/"uncharged" counterpart, or (for items that
// dismantle into multiple components, like crystal equipment) a sum of several. Checked first,
// before the generic name-stripping fallback below, since these aren't simple suffix variations
// of the same name. Verified against the OSRS Wiki (see DESIGN.md / README for the research
// this table is built from) -- each note says what the estimate is actually based on.
const VALUE_ALIASES: Record<
  number,
  { components: { aliasId: number; qty: number }[]; note: string }
> = {
  25865: {
    components: [{ aliasId: 25862, qty: 1 }],
    note: "valued as Bow of faerdhinen (inactive)",
  },
  12926: { components: [{ aliasId: 12924, qty: 1 }], note: "valued as Toxic blowpipe (empty)" },
  12006: {
    components: [{ aliasId: 4151, qty: 1 }],
    note: "valued as Abyssal whip (degrades back to this)",
  },
  // Eye of ayak is only tradeable fully uncharged (id 31115).
  31113: { components: [{ aliasId: 31115, qty: 1 }], note: "valued as Eye of ayak (uncharged)" },
  // Crystal equipment dismantles back into crystal armour/weapon seeds (wiki-confirmed counts).
  23975: {
    components: [{ aliasId: 23956, qty: 3 }],
    note: "valued as 3x Crystal armour seed (dismantle value)",
  },
  23979: {
    components: [{ aliasId: 23956, qty: 2 }],
    note: "valued as 2x Crystal armour seed (dismantle value)",
  },
  23971: {
    components: [{ aliasId: 23956, qty: 1 }],
    note: "valued as Crystal armour seed (dismantle value)",
  },
  23987: {
    components: [{ aliasId: 4207, qty: 1 }],
    note: "valued as Crystal weapon seed (revertible via Ilfeen)",
  },
  // Neitiznot faceguard is a combination of these two tradeable pieces -- not a strict "revert"
  // mechanic, but a real floor on its value since you could always disassemble the idea into them.
  24271: {
    components: [
      { aliasId: 24268, qty: 1 },
      { aliasId: 10828, qty: 1 },
    ],
    note: "valued as Basilisk jaw + Helm of neitiznot (its components)",
  },
  // Ferocious gloves are crafted from Hydra leather -- not a revert, just the closest tradeable
  // value reference available (flagged as looser than the others via the note).
  22981: {
    components: [{ aliasId: 22983, qty: 1 }],
    note: "rough estimate only: valued as its Hydra leather cost",
  },
};

// Generic fallback for the broader pattern: many degraded/imbued/charged items share a name
// with a tradeable "base" item plus a suffix -- barrows charge-state numbers ("Ahrim's robetop
// 100" -> "Ahrim's robetop"), imbued combat rings ("Berserker ring (i)" -> "Berserker ring").
// Strip the suffix and look up the resulting name; if it's a real tradeable item, use it as a
// (clearly labeled) estimate rather than reporting 0gp for something that's actually worth a lot.
function nameFallbackCandidates(name: string): { candidate: string; note: string }[] {
  const out: { candidate: string; note: string }[] = [];
  const chargeMatch = name.match(/^(.*)\s\d{1,3}$/);
  if (chargeMatch) {
    out.push({
      candidate: chargeMatch[1],
      note: `valued as ${chargeMatch[1]} (base/uncharged form)`,
    });
  }
  if (/\(i\)$/i.test(name)) {
    const base = name.replace(/\s*\(i\)$/i, "");
    out.push({ candidate: base, note: `valued as ${base} (pre-imbue form)` });
  }
  return out;
}

const nameLookupStmt = db.prepare(`
  SELECT i.id, i.name, i.icon, i.value, i.highalch, s.low, s.high
  FROM items i
  LEFT JOIN latest_snapshot s ON s.item_id = i.id
  WHERE LOWER(i.name) = LOWER(?)
  LIMIT 1
`);

function valueEntries(entries: BankEntry[]): {
  totalValue: number;
  totalNetValue: number;
  items: ValuedItem[];
} {
  const ids = entries.map((e) => e.id);
  if (ids.length === 0) return { totalValue: 0, totalNetValue: 0, items: [] };

  const aliasIds = ids.flatMap((id) => VALUE_ALIASES[id]?.components.map((c) => c.aliasId) ?? []);
  const allIds = [...new Set([...ids, ...aliasIds])];
  const placeholders = allIds.map(() => "?").join(",");
  const rows = db
    .prepare(
      `
    SELECT i.id, i.name, i.icon, i.value, i.highalch, s.low, s.high
    FROM items i
    LEFT JOIN latest_snapshot s ON s.item_id = i.id
    WHERE i.id IN (${placeholders})
  `,
    )
    .all(...allIds) as BankRow[];

  const byId = new Map(rows.map((r) => [r.id, r]));

  let totalValue = 0;
  let totalNetValue = 0;
  const items = entries
    .filter((e) => e.qty > 0)
    .map((e): ValuedItem => {
      const row = byId.get(e.id);
      if (row) {
        // Prefer live GE "low" (what you'd realistically get instant-selling) over the
        // static mapping value (alch/store reference price), since it's the actual sellable value.
        const unitValue = row.low ?? row.high ?? row.value ?? 0;
        const priced = row.low != null || row.high != null;
        const value = unitValue * e.qty;
        const { netUnitValue, netValue } = netOf(unitValue, e.qty);
        totalValue += value;
        totalNetValue += priced ? netValue : value;
        return {
          id: e.id,
          name: row.name,
          icon: row.icon,
          qty: e.qty,
          unitValue,
          value,
          netUnitValue,
          netValue,
          priced,
          highAlch: row.highalch,
          highAlchValue: row.highalch != null ? row.highalch * e.qty : null,
        };
      }

      const alias = VALUE_ALIASES[e.id];
      const aliasComponentRows = alias
        ? alias.components.map((c) => ({ row: byId.get(c.aliasId), qty: c.qty }))
        : [];
      const aliasResolved = alias && aliasComponentRows.every((c) => c.row);
      if (alias && aliasResolved) {
        // Sum each component's price * its required quantity (e.g. Crystal body = 3x seed).
        const unitValue = aliasComponentRows.reduce((sum, c) => {
          const price = c.row!.low ?? c.row!.high ?? c.row!.value ?? 0;
          return sum + price * c.qty;
        }, 0);
        const value = unitValue * e.qty;
        const { netUnitValue, netValue } = netOf(unitValue, e.qty);
        totalValue += value;
        totalNetValue += netValue;
        // Use the first component's icon as a stand-in -- there's no icon for "the item itself"
        // since it's untradeable, so this is just visually closer than a blank cell.
        const icon = aliasComponentRows[0].row!.icon;
        const highAlch = aliasComponentRows.every((c) => c.row!.highalch != null)
          ? aliasComponentRows.reduce((sum, c) => sum + c.row!.highalch! * c.qty, 0)
          : null;
        return {
          id: e.id,
          name: e.name ?? `Unknown item ${e.id}`,
          icon,
          qty: e.qty,
          unitValue,
          value,
          netUnitValue,
          netValue,
          priced: true,
          estimated: true,
          note: alias.note,
          highAlch,
          highAlchValue: highAlch != null ? highAlch * e.qty : null,
        };
      }

      if (e.name) {
        for (const { candidate, note } of nameFallbackCandidates(e.name)) {
          const match = nameLookupStmt.get(candidate) as BankRow | undefined;
          if (match && (match.low != null || match.high != null)) {
            const unitValue = match.low ?? match.high ?? match.value ?? 0;
            const value = unitValue * e.qty;
            const { netUnitValue, netValue } = netOf(unitValue, e.qty);
            totalValue += value;
            totalNetValue += netValue;
            return {
              id: e.id,
              name: e.name,
              icon: match.icon,
              qty: e.qty,
              unitValue,
              value,
              netUnitValue,
              netValue,
              priced: true,
              estimated: true,
              note,
              highAlch: match.highalch,
              highAlchValue: match.highalch != null ? match.highalch * e.qty : null,
            };
          }
        }
      }

      // Not in the Wiki's tradeable-item mapping and no known alias/fallback -- usually a
      // genuinely untradeable item (quest item, pet, clue scroll, etc.), not a bug.
      // Still worth a high alch lookup by name if we can find one -- an untradeable item
      // occasionally still has a real high alch value (most don't, alchemy will just say
      // "this item cannot be alchemised", but this covers the ones that do).
      const byNameFallback = e.name
        ? (nameLookupStmt.get(e.name) as BankRow | undefined)
        : undefined;
      const highAlch = byNameFallback?.highalch ?? null;
      return {
        id: e.id,
        name: e.name ?? `Unknown item ${e.id}`,
        icon: "",
        qty: e.qty,
        unitValue: 0,
        value: 0,
        netUnitValue: 0,
        netValue: 0,
        priced: false,
        highAlch,
        highAlchValue: highAlch != null ? highAlch * e.qty : null,
      };
    })
    .sort((a, b) => b.value - a.value);

  return { totalValue, totalNetValue, items };
}

const insertImportStmt = db.prepare(`
  INSERT INTO bank_imports (imported_at, total_value, item_count, entries_json, result_json)
  VALUES (@imported_at, @total_value, @item_count, @entries_json, @result_json)
`);

export async function bankRoutes(app: FastifyInstance) {
  app.post("/api/bank/value", async (req, reply) => {
    const body = req.body as { entries?: BankEntry[] };
    if (!body?.entries || !Array.isArray(body.entries)) {
      return reply.code(400).send({ error: "expected { entries: [{ id, qty }] }" });
    }
    return valueEntries(body.entries);
  });

  // Same as /api/bank/value but persists a snapshot to history -- call this when the user
  // explicitly wants to save the current import, not on every intermediate merge/paste.
  app.post("/api/bank/import", async (req, reply) => {
    const body = req.body as { entries?: BankEntry[] };
    if (!body?.entries || !Array.isArray(body.entries)) {
      return reply.code(400).send({ error: "expected { entries: [{ id, qty }] }" });
    }
    const result = valueEntries(body.entries);
    const importedAt = Math.floor(Date.now() / 1000);
    insertImportStmt.run({
      imported_at: importedAt,
      total_value: result.totalValue,
      item_count: result.items.length,
      entries_json: JSON.stringify(body.entries),
      result_json: JSON.stringify(result),
    });
    const { id } = db.prepare("SELECT last_insert_rowid() as id").get() as { id: number };
    return { importId: id, importedAt, ...result };
  });

  app.get("/api/bank/imports", async () => {
    const rows = db
      .prepare(
        `SELECT id, imported_at, total_value, item_count FROM bank_imports ORDER BY imported_at DESC LIMIT 100`,
      )
      .all();
    return { imports: rows };
  });

  app.get("/api/bank/imports/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const row = db.prepare(`SELECT * FROM bank_imports WHERE id = ?`).get(Number(id)) as
      | {
          id: number;
          imported_at: number;
          total_value: number;
          item_count: number;
          result_json: string;
        }
      | undefined;
    if (!row) return reply.code(404).send({ error: "not found" });
    return {
      importId: row.id,
      importedAt: row.imported_at,
      ...JSON.parse(row.result_json),
    };
  });

  app.delete("/api/bank/imports/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const result = db.prepare(`DELETE FROM bank_imports WHERE id = ?`).run(Number(id));
    if (result.changes === 0) return reply.code(404).send({ error: "not found" });
    return { deleted: Number(id) };
  });
}
