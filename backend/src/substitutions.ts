import { db } from "./db.js";

// DESIGN.md §10 item 2: cross-item correlation / substitution flags. Some items move together
// (raw vs. cooked variants, ore vs. bar, herb vs. potion) because the same demand driver hits
// both -- when a leader has moved but its substitute hasn't followed proportionally yet, that
// lag is a classic merchanting signal. Every pair below is a real, direct GE-item relationship
// (verified against the local item DB before hardcoding, same discipline as setArbitrage.ts),
// not a guess at what "should" correlate.
export interface SubstitutionPair {
  leader: string;
  follower: string;
  category: string;
}

export const SUBSTITUTION_PAIRS: SubstitutionPair[] = [
  { leader: "Iron ore", follower: "Iron bar", category: "Smithing" },
  { leader: "Silver ore", follower: "Silver bar", category: "Smithing" },
  { leader: "Gold ore", follower: "Gold bar", category: "Smithing" },
  { leader: "Raw shrimps", follower: "Shrimps", category: "Cooking" },
  { leader: "Raw lobster", follower: "Lobster", category: "Cooking" },
  { leader: "Raw swordfish", follower: "Swordfish", category: "Cooking" },
  { leader: "Raw monkfish", follower: "Monkfish", category: "Cooking" },
  { leader: "Raw shark", follower: "Shark", category: "Cooking" },
  { leader: "Raw tuna", follower: "Tuna", category: "Cooking" },
  { leader: "Logs", follower: "Plank", category: "Construction" },
  { leader: "Ranarr potion (unf)", follower: "Prayer potion(4)", category: "Herblore" },
  { leader: "Snapdragon potion (unf)", follower: "Super restore(4)", category: "Herblore" },
];

const WINDOW_SECONDS = 24 * 60 * 60;
const LAG_THRESHOLD = 0.05; // leader must have moved at least 5% to be worth flagging at all
// follower's move counts as "kept up" once it's covered at least 40% of the leader's move in
// the same direction; below that (including moving the opposite way) it's flagged as lagging.
const FOLLOW_RATIO_THRESHOLD = 0.4;

interface PriceChange {
  itemId: number;
  name: string;
  icon: string;
  from: number;
  to: number;
  changePct: number;
}

const nameLookupStmt = db.prepare(`SELECT id, icon FROM items WHERE name = ?`);
const currentPriceStmt = db.prepare(`SELECT high FROM latest_snapshot WHERE item_id = ?`);
// Most recent tick at or before the cutoff -- same "as-of" pattern as trends.ts, well within
// price_history's 3-day raw retention window for a 24h lookback.
const asOfPriceStmt = db.prepare(
  `SELECT high FROM price_history WHERE item_id = ? AND ts <= ? ORDER BY ts DESC LIMIT 1`,
);

function getPriceChange(name: string, cutoffTs: number): PriceChange | null {
  const item = nameLookupStmt.get(name) as { id: number; icon: string } | undefined;
  if (!item) return null;
  const current = currentPriceStmt.get(item.id) as { high: number | null } | undefined;
  const past = asOfPriceStmt.get(item.id, cutoffTs) as { high: number | null } | undefined;
  if (!current?.high || !past?.high || past.high <= 0) return null;
  return {
    itemId: item.id,
    name,
    icon: item.icon,
    from: past.high,
    to: current.high,
    changePct: (current.high - past.high) / past.high,
  };
}

export interface SubstitutionFlag {
  leader: PriceChange;
  follower: PriceChange;
  category: string;
  lagGapPct: number; // leader's changePct minus follower's -- how far behind the follower is
}

export function computeSubstitutionFlags(): SubstitutionFlag[] {
  const cutoff = Math.floor(Date.now() / 1000) - WINDOW_SECONDS;
  const flags: SubstitutionFlag[] = [];

  for (const pair of SUBSTITUTION_PAIRS) {
    const leader = getPriceChange(pair.leader, cutoff);
    const follower = getPriceChange(pair.follower, cutoff);
    if (!leader || !follower) continue;
    if (Math.abs(leader.changePct) < LAG_THRESHOLD) continue;

    const followedRatio = follower.changePct / leader.changePct;
    if (followedRatio < FOLLOW_RATIO_THRESHOLD) {
      flags.push({
        leader,
        follower,
        category: pair.category,
        lagGapPct: leader.changePct - follower.changePct,
      });
    }
  }

  flags.sort((a, b) => Math.abs(b.lagGapPct) - Math.abs(a.lagGapPct));
  return flags;
}
