export interface Settings {
  muteMarketAlerts: boolean;
  muteWatchlistAlerts: boolean;
  refreshIntervalSec: number;
  defaultMinLiquidity: number;
  // DESIGN.md §14.13: which OSRS account to look up via Wise Old Man -- plumbing for the
  // bankstand/session-planner feature (Phase 3), empty means "not configured yet."
  womUsername: string;
}

export const DEFAULT_SETTINGS: Settings = {
  muteMarketAlerts: false,
  muteWatchlistAlerts: false,
  refreshIntervalSec: 30,
  defaultMinLiquidity: 0,
  womUsername: "",
};

const KEY = "settings";

// One-time migration: defaultMinLiquidity used to ship hardcoded at 20 gp/hr, so anyone who
// installed before this changed already has {defaultMinLiquidity: 20} sitting in their saved
// settings -- changing DEFAULT_SETTINGS above doesn't touch that, since loadSettings merges the
// saved raw value OVER the default. Reset it to the new default exactly once per browser profile
// (flagged so re-running this doesn't clobber someone who deliberately dials it back to 20 later).
const MIN_LIQ_MIGRATION_KEY = "settings_migrated_min_liq_v1";

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return DEFAULT_SETTINGS;
    const parsed = { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
    if (parsed.defaultMinLiquidity === 20 && !localStorage.getItem(MIN_LIQ_MIGRATION_KEY)) {
      parsed.defaultMinLiquidity = 0;
      saveSettings(parsed);
      localStorage.setItem(MIN_LIQ_MIGRATION_KEY, "1");
    }
    return parsed;
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export function saveSettings(next: Settings) {
  localStorage.setItem(KEY, JSON.stringify(next));
}
