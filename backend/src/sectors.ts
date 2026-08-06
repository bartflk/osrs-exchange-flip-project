import { computeAllTrendEntries, type TrendWindow } from "./trends.js";

// DESIGN.md §10 item 20: sector/basket indices -- group items by theme and chart the combined
// price movement as a single number, useful for spotting sector-wide moves (e.g. "raid drops are
// all up this week") a single-item view would miss. Every item name below was verified against
// the live local item DB via /api/lookup before hardcoding, same discipline as setArbitrage.ts's
// SET_DEFINITIONS -- not guessed from memory.
export interface SectorDefinition {
  key: string;
  label: string;
  itemNames: string[];
}

export const SECTOR_DEFINITIONS: SectorDefinition[] = [
  {
    key: "raid-uniques",
    label: "Raid uniques",
    itemNames: [
      "Twisted bow",
      "Ghrazi rapier",
      "Kodai insignia",
      "Ancestral hat",
      "Sanguinesti staff (uncharged)",
      "Tumeken's shadow (uncharged)",
      "Osmumten's fang",
      "Elidinis' ward",
      "Masori mask",
    ],
  },
  {
    key: "barrows",
    label: "Barrows equipment",
    itemNames: [
      "Ahrim's hood",
      "Dharok's helm",
      "Guthan's helm",
      "Karil's coif",
      "Torag's helm",
      "Verac's helm",
    ],
  },
  {
    key: "herblore",
    label: "Herblore supplies",
    itemNames: [
      "Ranarr potion (unf)",
      "Snapdragon potion (unf)",
      "Torstol",
      "Red spiders' eggs",
      "Prayer potion(4)",
      "Super restore(4)",
      "Saradomin brew(4)",
    ],
  },
  {
    key: "combat-food",
    label: "Combat food",
    itemNames: ["Shark", "Anglerfish", "Manta ray", "Dark crab"],
  },
  {
    key: "god-wars",
    label: "God Wars armor",
    itemNames: [
      "Bandos chestplate",
      "Bandos tassets",
      "Armadyl chestplate",
      "Armadyl chainskirt",
      "Saradomin sword",
      "Zamorakian spear",
    ],
  },
  {
    key: "dragon-equipment",
    label: "Dragon equipment",
    itemNames: [
      "Dragon claws",
      "Dragon warhammer",
      "Dragon pickaxe",
      "Dragon scimitar",
      "Dragon boots",
    ],
  },
];

export interface SectorIndex {
  key: string;
  label: string;
  itemCount: number; // how many of the sector's items had current trend data
  totalItems: number; // how many items the sector definition has
  avgChangePct: number | null; // null if no items in the sector currently have data
}

export async function computeSectorIndices(window: TrendWindow): Promise<SectorIndex[]> {
  const trend = await computeAllTrendEntries(window);
  const changeByName = new Map(trend.map((t) => [t.name.toLowerCase(), t.changePct]));

  return SECTOR_DEFINITIONS.map((sector) => {
    const changes = sector.itemNames
      .map((name) => changeByName.get(name.toLowerCase()))
      .filter((c): c is number => c != null);

    const avgChangePct =
      changes.length > 0 ? changes.reduce((sum, c) => sum + c, 0) / changes.length : null;

    return {
      key: sector.key,
      label: sector.label,
      itemCount: changes.length,
      totalItems: sector.itemNames.length,
      avgChangePct,
    };
  });
}
