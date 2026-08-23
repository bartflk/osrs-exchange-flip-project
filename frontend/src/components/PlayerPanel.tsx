import { useEffect, useState } from "preact/hooks";
import { fetchPlayerSnapshot, type PlayerSnapshot } from "../api";

// DESIGN.md §14.13: compact display for the Wise Old Man integration -- mainly plumbing for the
// bankstand/session-planner feature (Phase 3, message 8), which will use the fetched skill
// levels server-side to filter which activities a player can actually do. This panel exists so
// the integration is visible/verifiable on its own before Phase 3 depends on it.
const KEY_SKILLS = [
  "woodcutting",
  "fishing",
  "mining",
  "farming",
  "herblore",
  "cooking",
  "firemaking",
  "crafting",
  "smithing",
  "fletching",
  "construction",
];

export function PlayerPanel({ username }: { username: string }) {
  const [snapshot, setSnapshot] = useState<PlayerSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Debounced -- this fires on every keystroke while typing a username in Settings, and
  // WOM lookups on half-typed names would just flash "not found" errors while typing.
  useEffect(() => {
    if (!username.trim()) {
      setSnapshot(null);
      setError(null);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      setLoading(true);
      setError(null);
      fetchPlayerSnapshot(username)
        .then((res) => !cancelled && setSnapshot(res))
        .catch(
          (err) => !cancelled && setError(err instanceof Error ? err.message : "Failed to load"),
        )
        .finally(() => !cancelled && setLoading(false));
    }, 500);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [username]);

  if (!username.trim()) {
    return (
      <p className="text-xs text-gray-500 py-2">
        Enter your OSRS username above to pull skill levels from Wise Old Man, used by the upcoming
        session planner to suggest activities you can actually do.
      </p>
    );
  }

  if (loading) return <p className="text-xs text-gray-500 py-2">Looking up {username}…</p>;
  if (error) return <p className="text-xs text-rose-400 py-2">{error}</p>;
  if (!snapshot) return null;

  return (
    <div className="py-2">
      <div className="flex items-center justify-between mb-2">
        <span className="text-sm text-gray-200">{snapshot.displayName}</span>
        <span className="text-xs text-gray-500">
          Combat {snapshot.combatLevel} · {snapshot.type}
        </span>
      </div>
      <div className="grid grid-cols-3 gap-x-3 gap-y-1 text-xs">
        {KEY_SKILLS.map((skill) => {
          const entry = snapshot.skills[skill];
          return (
            <div key={skill} className="flex items-center justify-between">
              <span className="text-gray-500 capitalize">{skill}</span>
              <span className="font-mono text-gray-200">{entry?.level ?? "-"}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
