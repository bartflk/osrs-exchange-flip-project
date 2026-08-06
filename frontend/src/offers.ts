// Manual entry/paste format for "what I currently have placed on the GE" -- purely a display
// aid (compare your offer price against the current market), never submitted anywhere. There's
// no confirmed RuneLite plugin that exports live GE offer slots the way Bank Memory exports bank
// contents (checked: Exchange Logger and OSRS-Flipper-2 log completed transaction history, not
// live open-offer state) -- see DESIGN.md's Actions tab section for the research notes. Until a
// real export exists, offers are typed or pasted in by hand, one per line:
//   type<TAB>item name<TAB>price<TAB>quantity
// e.g. "buy\tAbyssal whip\t830000\t5". Persisted to localStorage only -- not sent to the backend,
// since it's ephemeral ("what's on my screen right now"), not history worth keeping.
export interface Offer {
  id: string; // client-generated, stable across edits
  type: "buy" | "sell";
  itemName: string;
  price: number;
  qty: number;
  // Unix seconds. Optional only for backwards compatibility with offers saved before this field
  // existed -- new offers always set it. Feeds Trade Health's "how long has this been open"
  // staleness factor (tradeHealth.ts, DESIGN.md §10 item 23).
  trackedAt?: number;
}

const KEY = "geOffers";

export function loadOffers(): Offer[] {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

export function saveOffers(offers: Offer[]) {
  localStorage.setItem(KEY, JSON.stringify(offers));
}

export function parseOffersText(text: string): { offers: Offer[]; skipped: string[] } {
  const offers: Offer[] = [];
  const skipped: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const cols = trimmed.split("\t").map((c) => c.trim());
    if (cols.length < 4) {
      skipped.push(line);
      continue;
    }
    const type = cols[0].toLowerCase();
    const price = Number(cols[2]);
    const qty = Number(cols[3]);
    if (
      (type !== "buy" && type !== "sell") ||
      !cols[1] ||
      !Number.isFinite(price) ||
      !Number.isFinite(qty)
    ) {
      skipped.push(line);
      continue;
    }
    offers.push({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      type,
      itemName: cols[1],
      price,
      qty,
      trackedAt: Math.floor(Date.now() / 1000),
    });
  }
  return { offers, skipped };
}
