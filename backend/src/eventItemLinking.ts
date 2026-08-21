import { db } from "./db.js";
import { getEventsNeedingLinking, setEventLinkedItems, getEventsForItem, type EventRecord } from "./db.js";
import { extractItemMentions } from "./llm.js";

// DESIGN.md §10 item 57: link already-collected events (Reddit + official news) to the specific
// item(s) they mention, via the local Ollama model. Flagged as a real gap in §14.45's audit
// ("70 ingested Reddit posts still have no item linkage") -- collection has been live since
// §14.35, only the linking step was ever missing.
//
// The model only suggests candidate names; every suggestion is validated against the real item
// catalogue by EXACT (case-insensitive) name match before being stored -- a hallucinated or
// slightly-off name (e.g. "twisted bows" instead of "Twisted bow") is silently dropped rather than
// stored as a wrong link or fuzzy-matched into a guess. This means real mentions using informal
// names ("tbow", "whip") won't link -- a known, accepted limitation, not a bug: matching informal
// slang reliably needs its own curated alias list, which doesn't exist yet and would itself be a
// source of wrong links if built carelessly. Better to under-link than mis-link.

const itemNameLookupStmt = db.prepare(`SELECT id, name FROM items`);

function buildNameMap(): Map<string, number> {
  const rows = itemNameLookupStmt.all() as unknown as { id: number; name: string }[];
  return new Map(rows.map((r) => [r.name.toLowerCase(), r.id]));
}

export interface LinkingRunResult {
  attempted: number;
  linked: number; // events where at least one item was matched
  failed: number;
}

// One request per event, so -- same discipline as slotProfiles.ts's refresh job -- this is a
// budget, not a target, and spaced out rather than fired concurrently against the local model.
const REQUEST_SPACING_MS = 300;

export async function linkPendingEvents(limit = 20): Promise<LinkingRunResult> {
  const events = getEventsNeedingLinking(limit);
  if (events.length === 0) return { attempted: 0, linked: 0, failed: 0 };

  const nameMap = buildNameMap();
  let linked = 0;
  let failed = 0;

  for (const event of events) {
    try {
      const suggested = await extractItemMentions(event.title, event.summary ?? "");
      const itemIds = new Set<number>();
      for (const name of suggested) {
        const id = nameMap.get(name.trim().toLowerCase());
        if (id != null) itemIds.add(id);
      }
      setEventLinkedItems(event.id, [...itemIds]);
      if (itemIds.size > 0) linked++;
    } catch {
      // One event failing the model call must not abort the run -- same additive principle as
      // the Reddit collector and the slot-profile refresh job. Left un-linked (linked_item_ids
      // stays NULL), so it's retried on the next pass rather than permanently skipped.
      failed++;
    }
    await new Promise((r) => setTimeout(r, REQUEST_SPACING_MS));
  }

  return { attempted: events.length, linked, failed };
}

export function getLinkedEventsForItem(itemId: number, limit = 10): EventRecord[] {
  return getEventsForItem(itemId, limit);
}
