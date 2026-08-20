import { readFileSync, readdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

// DESIGN.md §14.47: bank value history from RuneLite's Bank Value Tracker plugin.
//
// The Bank tab already charts net worth, but only from *manual* Bank Memory pastes -- so in
// practice it sat at one saved import and the chart never rendered. This plugin has been quietly
// recording a timestamped bank value on every bank visit: 17 whole-bank snapshots over 16.8 days
// on this install, for free, with no user action.
//
// Read-only file access, like runeliteImport.ts -- the game client is not involved.
//
// IMPORTANT: bank value is NOT net worth, and the gap is large for anyone actually flipping.
// Coins and items committed to Grand Exchange offers are not in the bank, so an active trader's
// bank value falls as they deploy capital. Measured on this install: 523m (Aug 4) -> 57.7m
// (Aug 20) while ~308m was in play. Charting that alone would read as catastrophic losses.
// combineNetWorth() below adds the GE side back so the series means something.

const BANK_TRACKER_DIR = path.join(homedir(), ".runelite", "bank-value-tracker");

// Shape written by the plugin: { pricesMap: { "<ISO timestamp>": { tab, bankValue } } }.
// `tab` 0 is the whole bank; higher numbers are individual bank tabs, which would double-count
// if mixed into the same series.
interface BankTrackerFile {
  pricesMap?: Record<string, { tab?: number; bankValue?: number }>;
}

export interface BankValuePoint {
  /** Unix seconds. */
  timestamp: number;
  bankValue: number;
  account: string;
}

export function bankValueTrackerAvailable(): boolean {
  return existsSync(BANK_TRACKER_DIR);
}

/**
 * Whole-bank value snapshots, oldest first, across every account file the plugin has written.
 *
 * Returns [] rather than throwing when the plugin isn't installed -- this is additive, and the
 * Bank tab's manual-import path has to keep working on its own.
 */
export function readBankValueHistory(): BankValuePoint[] {
  if (!bankValueTrackerAvailable()) return [];

  let files: string[];
  try {
    files = readdirSync(BANK_TRACKER_DIR).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }

  const out: BankValuePoint[] = [];
  for (const file of files) {
    let parsed: BankTrackerFile;
    try {
      parsed = JSON.parse(readFileSync(path.join(BANK_TRACKER_DIR, file), "utf8"));
    } catch {
      continue; // a half-written file mid-flush is expected; skip it
    }
    const account = path.basename(file, ".json");
    for (const [rawTs, entry] of Object.entries(parsed.pricesMap ?? {})) {
      if (!entry || entry.tab !== 0 || typeof entry.bankValue !== "number") continue;
      // Timestamps are local-time ISO with sub-millisecond precision and no zone suffix
      // ("2026-08-20T20:37:13.600715900"). Date can't parse 9 fractional digits, so trim to 3.
      const ms = Date.parse(rawTs.replace(/(\.\d{3})\d+$/, "$1"));
      if (!Number.isFinite(ms)) continue;
      out.push({ timestamp: Math.floor(ms / 1000), bankValue: entry.bankValue, account });
    }
  }

  return out.sort((a, b) => a.timestamp - b.timestamp);
}

export interface NetWorthPoint extends BankValuePoint {
  /** Bank value plus what is currently tied up on the GE. Only the newest point can have this. */
  netWorth: number | null;
}

/**
 * Attach the GE side to the most recent bank reading.
 *
 * Only the latest point can be corrected: the GE position is known *now*, and there is no
 * historical record of what was on the Exchange at each past bank visit. Older points are left
 * as bank value alone and flagged as such, rather than back-filling today's GE position across
 * history and inventing a smooth line that never existed.
 */
export function combineNetWorth(
  history: BankValuePoint[],
  geValueNow: number,
): { points: NetWorthPoint[]; geValueNow: number } {
  const points: NetWorthPoint[] = history.map((p, i) => ({
    ...p,
    netWorth: i === history.length - 1 ? p.bankValue + geValueNow : null,
  }));
  return { points, geValueNow };
}
