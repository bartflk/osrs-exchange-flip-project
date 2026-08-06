// DESIGN.md §14.15 / message 8 "Session Planner": while a flip is filling, suggest something to
// do that fits the wait and the player's actual unlocked skills. Every skill/level requirement
// below was pulled from the OSRS Wiki (money making guide, Birdhouse run, High level alchemy,
// Herblore training, Dragon dart, Amethyst, Gem cutting), not invented -- same discipline as
// setArbitrage.ts's SET_DEFINITIONS. `skill` matches Wise Old Man's metric names exactly, so a
// player snapshot's `skills[activity.skill].level` can be compared directly.
//
// `attention` is an honest assessment, not a marketing label -- several of these (High Level
// Alchemy, Herblore potions, Dragon darts) are explicitly NOT AFK per the Wiki's own guidance,
// included anyway because they're real, common "half-attention while bankstanding" activities,
// just correctly labeled so the planner doesn't oversell them.
export type Attention = "afk" | "moderate" | "active";

// Present only on activities where profit can be computed live from local GE prices (buy
// input(s), sell output, tax-adjusted) -- gem cutting and Herblore potions. Pure-XP activities
// (birdhouses, darts) have no recipe; the planner lists them without a profit figure rather than
// fabricating one.
export interface ActivityRecipe {
  inputs: string[]; // exact GE item names, bought at low
  output: string; // exact GE item name, sold at high (taxed)
  outputsPerInputSet: number; // e.g. 1 cut gem per uncut gem
}

export interface ActivityDefinition {
  name: string;
  skill: string; // Wise Old Man metric name
  levelRequired: number;
  attention: Attention;
  // Typical session length this activity suits, in minutes -- e.g. a birdhouse run's ~50min
  // AFK wait, or "any" for continuous click-and-repeat activities like gem cutting.
  suggestedMinutes: number;
  description: string;
  recipe?: ActivityRecipe;
}

export const ACTIVITY_DEFINITIONS: ActivityDefinition[] = [
  // Birdhouse run -- Hunter-gated, ~50min fully passive wait after a ~70s active setup
  // (OSRS Wiki: "The player then has to wait around 50 minutes for the bird houses to
  // passively fill with birds"). Three representative tiers of the nine that exist.
  {
    name: "Birdhouse run (Regular)",
    skill: "hunter",
    levelRequired: 5,
    attention: "afk",
    suggestedMinutes: 50,
    description: "Place, wait ~50min, collect. Fully passive once placed.",
  },
  {
    name: "Birdhouse run (Yew)",
    skill: "hunter",
    levelRequired: 60,
    attention: "afk",
    suggestedMinutes: 50,
    description: "Higher Hunter XP than regular. Place, wait ~50min, collect.",
  },
  {
    name: "Birdhouse run (Redwood)",
    skill: "hunter",
    levelRequired: 89,
    attention: "afk",
    suggestedMinutes: 50,
    description: "Best Hunter XP/hour of the passive-wait tiers.",
  },

  // Gem cutting -- OSRS Wiki: "highly AFK and bankable... requires only a chisel and uncut
  // gems... can cut gems continuously without any bank trips." Live profit computed from local
  // GE prices (buy uncut, sell cut, taxed).
  {
    name: "Gem cutting (Sapphire)",
    skill: "crafting",
    levelRequired: 20,
    attention: "afk",
    suggestedMinutes: 15,
    description: "Chisel + uncut gems, no bank trips needed once stocked.",
    recipe: { inputs: ["Uncut sapphire"], output: "Sapphire", outputsPerInputSet: 1 },
  },
  {
    name: "Gem cutting (Emerald)",
    skill: "crafting",
    levelRequired: 27,
    attention: "afk",
    suggestedMinutes: 15,
    description: "Chisel + uncut gems, no bank trips needed once stocked.",
    recipe: { inputs: ["Uncut emerald"], output: "Emerald", outputsPerInputSet: 1 },
  },
  {
    name: "Gem cutting (Ruby)",
    skill: "crafting",
    levelRequired: 34,
    attention: "afk",
    suggestedMinutes: 15,
    description: "Chisel + uncut gems, no bank trips needed once stocked.",
    recipe: { inputs: ["Uncut ruby"], output: "Ruby", outputsPerInputSet: 1 },
  },
  {
    name: "Gem cutting (Diamond)",
    skill: "crafting",
    levelRequired: 43,
    attention: "afk",
    suggestedMinutes: 15,
    description: "Chisel + uncut gems, no bank trips needed once stocked.",
    recipe: { inputs: ["Uncut diamond"], output: "Diamond", outputsPerInputSet: 1 },
  },
  {
    name: "Gem cutting (Dragonstone)",
    skill: "crafting",
    levelRequired: 55,
    attention: "afk",
    suggestedMinutes: 15,
    description: "Chisel + uncut gems, no bank trips needed once stocked.",
    recipe: { inputs: ["Uncut dragonstone"], output: "Dragonstone", outputsPerInputSet: 1 },
  },
  {
    name: "Gem cutting (Onyx)",
    skill: "crafting",
    levelRequired: 67,
    attention: "afk",
    suggestedMinutes: 15,
    description: "Chisel + uncut gems, no bank trips needed once stocked.",
    recipe: { inputs: ["Uncut onyx"], output: "Onyx", outputsPerInputSet: 1 },
  },
  {
    name: "Gem cutting (Zenyte)",
    skill: "crafting",
    levelRequired: 89,
    attention: "afk",
    suggestedMinutes: 15,
    description: "Chisel + uncut gems, no bank trips needed once stocked.",
    recipe: { inputs: ["Uncut zenyte"], output: "Zenyte", outputsPerInputSet: 1 },
  },

  // Herblore potions -- OSRS Wiki: "None of these are particularly AFK; all require active
  // ingredient combination at reasonable banking intervals" -- labeled "moderate", not "afk".
  {
    name: "Making Prayer potions",
    skill: "herblore",
    levelRequired: 38,
    attention: "moderate",
    suggestedMinutes: 20,
    description:
      "Ranarr potion (unf) + Snape grass. Active ingredient combining at bank intervals.",
    recipe: {
      inputs: ["Ranarr potion (unf)", "Snape grass"],
      output: "Prayer potion(4)",
      outputsPerInputSet: 1,
    },
  },
  {
    name: "Making Super restores",
    skill: "herblore",
    levelRequired: 63,
    attention: "moderate",
    suggestedMinutes: 20,
    description:
      "Snapdragon potion (unf) + Red spiders' eggs. Active ingredient combining at bank intervals.",
    recipe: {
      inputs: ["Snapdragon potion (unf)", "Red spiders' eggs"],
      output: "Super restore(4)",
      outputsPerInputSet: 1,
    },
  },

  // High Level Alchemy -- OSRS Wiki: "not particularly AFK-friendly... demands consistent
  // attention." No recipe (profit depends entirely on which item you alch, a per-item decision
  // the app's own Market tab already supports better than a fixed "activity" could).
  {
    name: "High Level Alchemy",
    skill: "magic",
    levelRequired: 55,
    attention: "active",
    suggestedMinutes: 15,
    description:
      "~1,200 casts/hour at optimal clicking. Requires consistent attention, not passive.",
  },

  // Amethyst dart tips -- OSRS Wiki confirms Crafting 89 for dart tips (60 base for other
  // amethyst products); AFK-ness not confirmed by the Wiki, labeled "moderate" rather than
  // claiming AFK without a source.
  {
    name: "Amethyst dart tips",
    skill: "crafting",
    levelRequired: 89,
    attention: "moderate",
    suggestedMinutes: 20,
    description: "Cut amethyst into dart tips with a chisel. 60 XP per amethyst.",
  },

  // Dragon darts -- OSRS Wiki: "not very AFK or bankable-friendly... requires active clicking
  // for each fletching action."
  {
    name: "Fletching Dragon darts",
    skill: "fletching",
    levelRequired: 95,
    attention: "active",
    suggestedMinutes: 15,
    description: "Dragon dart tips + feathers. ~3,600/hour, requires active clicking throughout.",
  },
];
