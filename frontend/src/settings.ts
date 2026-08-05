export interface Settings {
  muteMarketAlerts: boolean;
  muteWatchlistAlerts: boolean;
  refreshIntervalSec: number;
  defaultMinLiquidity: number;
}

export const DEFAULT_SETTINGS: Settings = {
  muteMarketAlerts: false,
  muteWatchlistAlerts: false,
  refreshIntervalSec: 30,
  defaultMinLiquidity: 20,
};

const KEY = "settings";

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? { ...DEFAULT_SETTINGS, ...JSON.parse(raw) } : DEFAULT_SETTINGS;
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export function saveSettings(next: Settings) {
  localStorage.setItem(KEY, JSON.stringify(next));
}
