import { db } from "./db.js";
import { geTax } from "./signals.js";
import { ACTIVITY_DEFINITIONS, type Attention } from "./activities.js";

// DESIGN.md §14.15: filters the curated activity list (activities.ts) down to what a specific
// player can actually do, and computes real live profit for the recipe-based ones from local GE
// prices -- same buy-low/sell-high/tax-once shape as setArbitrage.ts, not a stale wiki GP/hour
// figure (those go out of date the moment GE prices move; this app already has live prices).

interface PriceRow {
  high: number | null;
  low: number | null;
}

const priceStmt = db.prepare(`
  SELECT s.high AS high, s.low AS low
  FROM items i JOIN latest_snapshot s ON s.item_id = i.id
  WHERE i.name = ?
`);

function lookupPrice(name: string): PriceRow | undefined {
  return priceStmt.get(name) as PriceRow | undefined;
}

export interface SessionPlanEntry {
  name: string;
  skill: string;
  levelRequired: number;
  playerLevel: number;
  attention: Attention;
  suggestedMinutes: number;
  description: string;
  // Profit per output unit, tax-adjusted -- null when the activity has no recipe (pure XP, e.g.
  // birdhouses/darts/HLA) or when a required item's price isn't currently available locally.
  profitPerUnit: number | null;
}

// DESIGN.md §10 item 29: a "goal" axis for the planner, honestly scoped to what real data
// supports -- no quest/diary/collection-log dataset exists in this app, so "Questing" and
// "Collection Log" goals from the original brainstorm aren't buildable without fabricating
// data. These three map to axes the planner actually has: attention level and live GP profit.
export type SessionGoal = "afk" | "profit" | "active";

export function computeSessionPlan(
  skills: Record<string, { level: number }>,
  availableMinutes: number,
  goal: SessionGoal = "afk",
): SessionPlanEntry[] {
  const eligible = ACTIVITY_DEFINITIONS.filter(
    (a) => (skills[a.skill]?.level ?? 1) >= a.levelRequired,
  );

  const entries: SessionPlanEntry[] = eligible.map((activity) => {
    let profitPerUnit: number | null = null;

    if (activity.recipe) {
      const outputPrice = lookupPrice(activity.recipe.output);
      let inputCost = 0;
      let pricesFound = true;
      for (const inputName of activity.recipe.inputs) {
        const p = lookupPrice(inputName);
        if (!p || p.low == null) {
          pricesFound = false;
          break;
        }
        inputCost += p.low;
      }
      if (pricesFound && outputPrice?.high != null) {
        const revenue =
          (outputPrice.high - geTax(outputPrice.high)) * activity.recipe.outputsPerInputSet;
        profitPerUnit = revenue - inputCost;
      }
    }

    return {
      name: activity.name,
      skill: activity.skill,
      levelRequired: activity.levelRequired,
      playerLevel: skills[activity.skill]?.level ?? 1,
      attention: activity.attention,
      suggestedMinutes: activity.suggestedMinutes,
      description: activity.description,
      profitPerUnit,
    };
  });

  // Goal changes the ranking, not just a filter -- "profit" always ranks by GP regardless of
  // time available (a player who explicitly wants max GP shouldn't get an AFK activity with no
  // profit figure ranked above a profitable one); "active" flips the attention bias instead of
  // defaulting to passive; "afk" (default) keeps the original time-aware behavior.
  entries.sort((a, b) => {
    if (goal === "profit") {
      return (b.profitPerUnit ?? -Infinity) - (a.profitPerUnit ?? -Infinity);
    }
    if (goal === "active") {
      const aActive = a.attention === "active" ? 2 : a.attention === "moderate" ? 1 : 0;
      const bActive = b.attention === "active" ? 2 : b.attention === "moderate" ? 1 : 0;
      if (aActive !== bActive) return bActive - aActive;
      return (b.profitPerUnit ?? -Infinity) - (a.profitPerUnit ?? -Infinity);
    }
    const aAfk = a.attention === "afk" ? 1 : 0;
    const bAfk = b.attention === "afk" ? 1 : 0;
    if (availableMinutes >= 30 && aAfk !== bAfk) return bAfk - aAfk;
    return (b.profitPerUnit ?? -Infinity) - (a.profitPerUnit ?? -Infinity);
  });

  return entries;
}
