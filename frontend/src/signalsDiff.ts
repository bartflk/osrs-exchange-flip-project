// DESIGN.md §10 item 6: "since your last session, these items entered/left the Buy Signals
// list." Purely a localStorage snapshot diff -- no backend, no history table. Deliberately only
// diffs once per page load (the caller snapshots on first render), not on every poll tick, so it
// answers "what changed since I last looked" rather than churning every 15-60s as prices wiggle.
const KEY = "lastSeenBuySignals";

interface Snapshot {
  names: string[];
  at: number;
}

export interface SignalsDiff {
  entered: string[];
  left: string[];
  previousAt: number | null;
}

export function diffAndSnapshotSignals(currentNames: string[]): SignalsDiff {
  let previous: Snapshot | null = null;
  try {
    const raw = localStorage.getItem(KEY);
    previous = raw ? JSON.parse(raw) : null;
  } catch {
    previous = null;
  }

  const prevNames = previous?.names ?? [];
  const prevSet = new Set(prevNames);
  const currSet = new Set(currentNames);
  const entered = currentNames.filter((n) => !prevSet.has(n));
  const left = prevNames.filter((n) => !currSet.has(n));

  localStorage.setItem(KEY, JSON.stringify({ names: currentNames, at: Date.now() } satisfies Snapshot));

  return { entered, left, previousAt: previous?.at ?? null };
}
