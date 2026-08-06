import { useEffect, useState } from "preact/hooks";
import { fetchSessionPlan, type SessionPlanEntry, type ActivityAttention } from "../api";
import { formatGp } from "../format";
import { NumberInput, Badge } from "./ui";

// DESIGN.md §14.15 / message 8 "Session Planner": while a flip is filling, suggest something to
// do that fits the wait and your actual unlocked skills -- sourced from a curated,
// Wiki-verified activity list (backend/src/activities.ts), not invented.

const ATTENTION_TONE: Record<ActivityAttention, "success" | "warning" | "danger"> = {
  afk: "success",
  moderate: "warning",
  active: "danger",
};

const ATTENTION_LABEL: Record<ActivityAttention, string> = {
  afk: "AFK",
  moderate: "Moderate",
  active: "Active",
};

function ActivityRow({ entry }: { entry: SessionPlanEntry }) {
  return (
    <div className="flex items-center justify-between gap-3 py-2 border-b border-white/5 last:border-b-0">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm text-gray-100">{entry.name}</span>
          <Badge tone={ATTENTION_TONE[entry.attention]}>{ATTENTION_LABEL[entry.attention]}</Badge>
        </div>
        <p className="text-xs text-gray-500 mt-0.5">{entry.description}</p>
        <p className="text-[11px] text-gray-600 mt-0.5">
          {entry.skill} {entry.levelRequired}+ (you: {entry.playerLevel}) · ~
          {entry.suggestedMinutes}
          min
        </p>
      </div>
      {entry.profitPerUnit != null && (
        <span
          className={`font-mono text-sm text-right shrink-0 ${entry.profitPerUnit >= 0 ? "text-emerald-400" : "text-rose-400"}`}
        >
          {formatGp(entry.profitPerUnit)}/ea
        </span>
      )}
    </div>
  );
}

export function SessionPlanner({ username }: { username: string }) {
  const [minutes, setMinutes] = useState(30);
  const [plan, setPlan] = useState<SessionPlanEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!username.trim()) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchSessionPlan(username, minutes)
      .then((res) => !cancelled && setPlan(res.plan))
      .catch((err) => !cancelled && setError(err instanceof Error ? err.message : "Failed to load"))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [username, minutes]);

  if (!username.trim()) {
    return (
      <section>
        <h3 className="text-sm font-medium text-gray-300 mb-2">While you wait</h3>
        <div className="glass rounded-xl p-6 text-center text-gray-500 text-sm">
          Set your OSRS username in Settings to get activity suggestions that fit your unlocked
          skills while a flip fills.
        </div>
      </section>
    );
  }

  return (
    <section>
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-sm font-medium text-gray-300">While you wait</h3>
        <label className="text-xs text-gray-500 flex items-center gap-2">
          Wait length (min)
          <NumberInput value={minutes} onChange={setMinutes} className="w-16" />
        </label>
      </div>
      <p className="text-xs text-gray-500 mb-3">
        Filtered to what your current skill levels actually unlock. Profit shown where computable
        from live GE prices (gem cutting, Herblore potions) — pure-XP activities show no figure
        rather than a fabricated one.
      </p>
      {loading && <p className="text-xs text-gray-500 py-2">Loading…</p>}
      {error && <p className="text-xs text-rose-400 py-2">{error}</p>}
      {!loading && !error && plan.length === 0 && (
        <div className="glass rounded-xl p-6 text-center text-gray-500 text-sm">
          Nothing in the curated list matches your current skill levels yet.
        </div>
      )}
      {plan.length > 0 && (
        <div className="glass rounded-xl px-4">
          {plan.map((entry) => (
            <ActivityRow key={entry.name} entry={entry} />
          ))}
        </div>
      )}
    </section>
  );
}
