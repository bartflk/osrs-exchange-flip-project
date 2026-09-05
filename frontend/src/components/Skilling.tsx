import { useEffect, useMemo, useState } from "preact/hooks";
import {
  fetchPlayerSnapshot,
  fetchSessionPlan,
  fetchTrainingMethods,
  type ActivityAttention,
  type PlayerSnapshot,
  type SessionGoal,
  type SessionPlanEntry,
  type TrainingMethod,
} from "../api";
import { formatGp } from "../format";
import { loadSettings, saveSettings } from "../settings";
import { Badge, Chip, EmptyState, Field, Input, Panel, PanelHeader, Select, Toolbar } from "./ui";

// What to do that is not flipping: the bankstand list, and every trainable action in the game
// priced against live Grand Exchange data.
//
// Two panels because they answer two different questions. "A buy offer is sitting there for the
// next forty minutes, what can I do meanwhile" is a question about ATTENTION and time, and it is
// answered by a small curated list of activities checked against your actual levels. "What is the
// cheapest way to get Herblore up" is a question about COST, and it needs every method in the
// game rather than a curated dozen, because the cheapest one is usually not the famous one.
//
// The training table comes from Module:Skill calc, the data behind the wiki's own calculators, so
// membership keeps up with the game on its own. What it cannot supply is a speed: there is no
// actions-per-hour field anywhere in that data. Rates therefore only appear on methods where a
// training guide states one, quoted on the row, and everything else says so instead of guessing.

const SKILL_ICON: Record<string, string> = {
  Agility: "Agility_icon.png",
  Construction: "Construction_icon.png",
  Cooking: "Cooking_icon.png",
  Crafting: "Crafting_icon.png",
  Farming: "Farming_icon.png",
  Firemaking: "Firemaking_icon.png",
  Fishing: "Fishing_icon.png",
  Fletching: "Fletching_icon.png",
  Herblore: "Herblore_icon.png",
  Hunter: "Hunter_icon.png",
  Magic: "Magic_icon.png",
  Mining: "Mining_icon.png",
  Prayer: "Prayer_icon.png",
  Runecraft: "Runecraft_icon.png",
  Smithing: "Smithing_icon.png",
  Thieving: "Thieving_icon.png",
  Woodcutting: "Woodcutting_icon.png",
};

function wikiImage(file: string | null): string | null {
  if (!file) return null;
  return `https://oldschool.runescape.wiki/images/${encodeURIComponent(file.replace(/ /g, "_"))}`;
}

/**
 * Fixed box around every sprite.
 *
 * Tailwind preflight sets `img { height: auto }`, which overrides the HTML height attribute, so
 * icons of different native sizes render ragged unless the BOX is sized and the image told to fit
 * inside it. Same fix as the money makers list, and the same reason: a column of icons that do
 * not line up reads as broken long before anyone works out why.
 */
function Icon({ file, alt, size = 20 }: { file: string | null; alt: string; size?: number }) {
  const src = wikiImage(file);
  if (!src) return null;
  return (
    <span
      className="inline-flex items-center justify-center shrink-0"
      style={{ width: size, height: size }}
      title={alt}
    >
      <img src={src} alt={alt} className="max-w-full max-h-full object-contain" loading="lazy" />
    </span>
  );
}

// --- bankstanding -------------------------------------------------------------------------

const GOALS: { key: SessionGoal; label: string }[] = [
  { key: "afk", label: "AFK first" },
  { key: "profit", label: "Max profit" },
  { key: "active", label: "Active grinding" },
];

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
      <div className="min-w-0 flex items-start gap-2">
        <Icon file={SKILL_ICON[capitalise(entry.skill)] ?? null} alt={entry.skill} size={18} />
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm text-gray-100">{entry.name}</span>
            <Badge tone={ATTENTION_TONE[entry.attention]}>{ATTENTION_LABEL[entry.attention]}</Badge>
          </div>
          <p className="text-xs text-gray-500 mt-0.5">{entry.description}</p>
          <p className="text-[11px] text-gray-600 mt-0.5">
            {capitalise(entry.skill)} {entry.levelRequired}+ (you have {entry.playerLevel}) ·
            about {entry.suggestedMinutes} min
          </p>
        </div>
      </div>
      {entry.profitPerUnit != null && (
        <div className="text-right shrink-0">
          <span
            className={`font-mono text-sm ${
              entry.profitPerUnit >= 0 ? "text-emerald-400" : "text-rose-400"
            }`}
            title="Profit for one made item, after GE tax, at today's prices."
          >
            {formatGp(entry.profitPerUnit)}/ea
          </span>
          {/* The arithmetic, not just its answer. A bare profit figure is unfalsifiable at a
              glance, which is how "Prayer potions, 2.2k each" sat here being wrong: the recipe
              named the four-dose potion and the action makes a three-dose one. Buy price and sell
              price side by side is the smallest thing that makes that visible. */}
          {entry.inputCost != null && entry.outputRevenue != null && (
            <div className="text-[10px] text-gray-600 font-mono mt-0.5">
              buy {formatGp(entry.inputCost)}
              <span className="text-gray-700"> to sell </span>
              {formatGp(entry.outputRevenue)}
              <span className="text-gray-700"> after tax</span>
            </div>
          )}
          {entry.output && (
            <div className="text-[10px] text-gray-600 mt-0.5" title={entry.inputs.join(" + ")}>
              {entry.inputs.join(" + ")} → {entry.output}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function Bankstanding({
  username,
  onUsernameChange,
}: {
  username: string;
  onUsernameChange: (next: string) => void;
}) {
  const [minutes, setMinutes] = useState(30);
  const [goal, setGoal] = useState<SessionGoal>(
    () => (localStorage.getItem("sessionPlannerGoal") as SessionGoal | null) ?? "afk",
  );
  const [plan, setPlan] = useState<SessionPlanEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!username.trim()) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchSessionPlan(username, minutes, goal)
      .then((res) => !cancelled && setPlan(res.plan))
      .catch((err) => !cancelled && setError(err instanceof Error ? err.message : "Failed to load"))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [username, minutes, goal]);

  function updateGoal(next: SessionGoal) {
    setGoal(next);
    localStorage.setItem("sessionPlannerGoal", next);
  }

  return (
    <Panel className="mb-4">
      <PanelHeader
        title="While a buy offer sits there"
        meta="bankstanding and short activities you have the levels for"
        right={
          <div className="flex items-center gap-3 flex-wrap">
            <Field label="Your OSRS name">
              <Input
                value={username}
                placeholder="Wise Old Man name"
                onInput={(e) => onUsernameChange((e.target as HTMLInputElement).value)}
                className="w-40"
              />
            </Field>
            <Field label="Time free">
              <Select
                value={String(minutes)}
                onChange={(e) => setMinutes(Number((e.target as HTMLSelectElement).value))}
              >
                <option value="10">10 min</option>
                <option value="30">30 min</option>
                <option value="60">1 hour</option>
                <option value="120">2 hours</option>
              </Select>
            </Field>
            <div className="flex gap-1 self-end pb-0.5">
              {GOALS.map((g) => (
                <Chip key={g.key} active={goal === g.key} onClick={() => updateGoal(g.key)}>
                  {g.label}
                </Chip>
              ))}
            </div>
          </div>
        }
      />

      {!username.trim() ? (
        <p className="text-xs text-gray-500">
          Set your OSRS name in Settings to fill this in. The list is filtered by your real skill
          levels from Wise Old Man, so without a name there is nothing honest to show.
        </p>
      ) : error ? (
        <p className="text-xs text-rose-400">{error}</p>
      ) : loading && plan.length === 0 ? (
        <p className="text-xs text-gray-500">Checking what you can do…</p>
      ) : plan.length === 0 ? (
        <p className="text-xs text-gray-500">Nothing in the list matches your levels yet.</p>
      ) : (
        <div>
          {plan.map((entry) => (
            <ActivityRow key={entry.name} entry={entry} />
          ))}
        </div>
      )}
      <p className="text-[10px] text-gray-600 mt-2">
        A short, hand-checked list, every entry sourced from the wiki. Profit is recomputed from
        live prices rather than quoted, so it moves with the market; activities with no recipe are
        pure experience and show no figure instead of a made-up one.
      </p>
    </Panel>
  );
}

// --- training methods ---------------------------------------------------------------------

type Sort = "cheapest" | "fastest" | "profit" | "level";

const SORTS: { key: Sort; label: string; hint: string }[] = [
  {
    key: "cheapest",
    label: "Cheapest xp",
    hint: "Lowest gp burnt per experience point. The headline number for a buyable skill.",
  },
  {
    key: "fastest",
    label: "Fastest xp",
    hint: "Highest experience per hour, among methods where the wiki states an hourly rate.",
  },
  {
    key: "profit",
    label: "Pays you",
    hint: "Methods that make money while training, best first.",
  },
  { key: "level", label: "Level", hint: "Highest level requirement first." },
];

/** Skills where the cost axis means something, because the materials are bought. */
const BUYABLE = [
  "Herblore",
  "Fletching",
  "Crafting",
  "Cooking",
  "Smithing",
  "Prayer",
  "Construction",
  "Magic",
  "Runecraft",
  "Firemaking",
  "Farming",
];

/**
 * Below this the product barely trades, so its price is whatever the last two traders agreed on.
 *
 * Not a hidden filter: the toggle is on screen and the volume is on the row. It defaults to on
 * because without it the "pays you" list is topped by fried mushrooms at 96k profit a cook, which
 * is true of the price and false of the market.
 */
const THIN_MARKET_VOLUME = 100;

function gpPerXpTone(v: number | null): string {
  if (v == null) return "text-gray-600";
  if (v < 0) return "text-emerald-400";
  if (v < 5) return "text-gray-200";
  if (v < 50) return "text-amber-300";
  return "text-rose-400";
}

function MethodRow({
  method,
  playerLevel,
  expanded,
  onToggle,
}: {
  method: TrainingMethod;
  playerLevel: number | null;
  expanded: boolean;
  onToggle: () => void;
}) {
  const locked = playerLevel != null && playerLevel < method.level;
  const thin =
    method.outputVolume != null && method.outputVolume < THIN_MARKET_VOLUME && !method.consumesOutput;

  return (
    <>
      <tr
        className={`border-b border-white/5 hover:bg-white/[0.03] cursor-pointer ${
          locked ? "opacity-45" : ""
        }`}
        onClick={onToggle}
      >
        <td className="py-1.5 pl-2 pr-3">
          <div className="flex items-center gap-2 min-w-0">
            <Icon file={method.outputIcon ?? method.materials[0]?.icon ?? null} alt={method.name} />
            <div className="min-w-0">
              <div className="text-[13px] text-gray-100 truncate">{method.title}</div>
              <div className="text-[10px] text-gray-600 truncate">
                {method.type}
                {method.members ? "" : " · free to play"}
                {thin && " · thin market"}
              </div>
            </div>
          </div>
        </td>
        <td className="py-1.5 px-2">
          <span className="flex items-center gap-1.5 text-[11px] text-gray-400">
            <Icon file={SKILL_ICON[method.skill] ?? null} alt={method.skill} size={14} />
            {method.skill}
          </span>
        </td>
        <td className="py-1.5 px-2 text-right font-mono text-[11px] tabular-nums text-gray-400">
          {method.level}
        </td>
        <td className="py-1.5 px-2 text-right font-mono text-[11px] tabular-nums text-gray-400">
          {method.xp.toLocaleString()}
        </td>
        <td
          className={`py-1.5 px-2 text-right font-mono text-[13px] tabular-nums ${gpPerXpTone(method.gpPerXp)}`}
        >
          {method.gpPerXp == null ? "n/a" : method.gpPerXp.toFixed(2)}
        </td>
        <td className="py-1.5 px-2 text-right font-mono text-[11px] tabular-nums text-gray-400">
          {method.costPerAction == null ? "n/a" : formatGp(Math.round(method.costPerAction))}
        </td>
        <td className="py-1.5 px-2 text-right font-mono text-[11px] tabular-nums">
          {method.xpPerHour == null ? (
            <span className="text-gray-700" title="No hourly rate is stated on the wiki for this method, so none is shown.">
              no rate
            </span>
          ) : (
            <span className="text-sky-300" title={method.rateNote ?? undefined}>
              {Math.round(method.xpPerHour).toLocaleString()}
            </span>
          )}
        </td>
        <td className="py-1.5 px-2 pr-2 text-right font-mono text-[11px] tabular-nums">
          {method.gpPerHour == null ? (
            <span className="text-gray-700">n/a</span>
          ) : (
            <span className={method.gpPerHour >= 0 ? "text-emerald-400" : "text-rose-400"}>
              {formatGp(Math.round(method.gpPerHour))}
            </span>
          )}
        </td>
      </tr>

      {expanded && (
        <tr className="border-b border-white/5 bg-black/20">
          <td colSpan={8} className="px-3 py-3">
            <div className="flex flex-wrap items-start gap-x-8 gap-y-3">
              <div>
                <div className="text-[10px] uppercase tracking-wider text-gray-500 mb-1">
                  You buy
                </div>
                <div className="flex flex-wrap items-center gap-3">
                  {method.materials.length === 0 && (
                    <span className="text-[11px] text-gray-500">Nothing, this one is gathered.</span>
                  )}
                  {method.materials.map((m) => (
                    <span key={m.name} className="flex items-center gap-1.5">
                      <Icon file={m.icon} alt={m.name} size={22} />
                      <span className="text-[11px] text-gray-300">
                        {m.name}
                        <span className="text-gray-600">
                          {" "}
                          ×{m.quantity < 1 ? m.quantity.toFixed(4) : m.quantity}
                        </span>
                        <span className="block font-mono text-[10px] text-gray-500">
                          {m.unitPrice == null ? "not on the GE" : `${formatGp(m.unitPrice)} ea`}
                        </span>
                      </span>
                    </span>
                  ))}
                </div>
              </div>

              <div>
                <div className="text-[10px] uppercase tracking-wider text-gray-500 mb-1">
                  You get back
                </div>
                {method.consumesOutput ? (
                  <p className="text-[11px] text-gray-500 max-w-xs">
                    Nothing sellable. This skill consumes what it touches, so the cost is the
                    materials in full.
                  </p>
                ) : (
                  <div className="flex items-center gap-2">
                    <Icon file={method.outputIcon} alt={method.name} size={22} />
                    <span className="text-[11px] text-gray-300">
                      {method.name}
                      {method.outputQuantity > 1 && (
                        <span className="text-gray-600"> ×{method.outputQuantity}</span>
                      )}
                      <span className="block font-mono text-[10px] text-emerald-400/80">
                        {formatGp(Math.round(method.outputValue))} after tax
                      </span>
                      {method.outputVolume != null && (
                        <span className="block font-mono text-[10px] text-gray-600">
                          {Math.round(method.outputVolume).toLocaleString()} traded/hr
                        </span>
                      )}
                    </span>
                  </div>
                )}
              </div>

              <div className="max-w-md">
                <div className="text-[10px] uppercase tracking-wider text-gray-500 mb-1">
                  Speed
                </div>
                <p className="text-[11px] text-gray-400">
                  {method.rateNote ??
                    "No training guide states an hourly rate for this method, so this app does not invent one. The cost per experience point above is still exact."}
                </p>
                {method.actionsPerHour != null && (
                  <p className="text-[11px] text-gray-500 mt-1 font-mono">
                    {method.actionsPerHour.toLocaleString()} actions/hr × {method.xp} xp ={" "}
                    {Math.round(method.xpPerHour ?? 0).toLocaleString()} xp/hr
                  </p>
                )}
                {method.unpricedMaterials.length > 0 && (
                  <p className="text-[11px] text-amber-400/80 mt-1">
                    No live price for {method.unpricedMaterials.join(", ")}, so this row has no
                    cost. Untradeable materials never will.
                  </p>
                )}
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

function TrainingMethods({ levels }: { levels: Record<string, number> | null }) {
  const [methods, setMethods] = useState<TrainingMethod[] | null>(null);
  const [failed, setFailed] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [skill, setSkill] = useState("buyable");
  const [sort, setSort] = useState<Sort>("cheapest");
  const [search, setSearch] = useState("");
  const [canDo, setCanDo] = useState(true);
  const [membersOnly, setMembersOnly] = useState(false);
  const [hideThin, setHideThin] = useState(true);
  const [expanded, setExpanded] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchTrainingMethods()
      .then((res) => {
        if (cancelled) return;
        setMethods(res.methods);
        setFailed(res.failed);
      })
      .catch((e) => !cancelled && setError(e instanceof Error ? e.message : "failed"));
    return () => {
      cancelled = true;
    };
  }, []);

  const skills = useMemo(
    () => [...new Set((methods ?? []).map((m) => m.skill))].sort(),
    [methods],
  );

  const rows = useMemo(() => {
    if (!methods) return [];
    const needle = search.trim().toLowerCase();
    let list = methods.filter((m) => {
      if (skill === "buyable" ? !BUYABLE.includes(m.skill) : skill !== "all" && m.skill !== skill) {
        return false;
      }
      if (membersOnly && !m.members) return false;
      if (needle && !m.title.toLowerCase().includes(needle) && !m.type.toLowerCase().includes(needle)) {
        return false;
      }
      if (canDo && levels) {
        const have = levels[m.skill.toLowerCase()];
        if (have != null && have < m.level) return false;
      }
      if (
        hideThin &&
        !m.consumesOutput &&
        m.outputVolume != null &&
        m.outputVolume < THIN_MARKET_VOLUME
      ) {
        return false;
      }
      return true;
    });

    // Sorting drops rows the sort cannot rank rather than parking them at the bottom: a "fastest
    // experience" list whose tail is a thousand methods with no rate is not a list of the fastest
    // anything, it is the whole table with a misleading heading on it.
    if (sort === "cheapest") {
      list = list.filter((m) => m.gpPerXp != null).sort((a, b) => a.gpPerXp! - b.gpPerXp!);
    } else if (sort === "fastest") {
      list = list.filter((m) => m.xpPerHour != null).sort((a, b) => b.xpPerHour! - a.xpPerHour!);
    } else if (sort === "profit") {
      list = list
        .filter((m) => m.gpPerXp != null && m.gpPerXp < 0)
        .sort((a, b) => a.gpPerXp! - b.gpPerXp!);
    } else {
      list = [...list].sort((a, b) => b.level - a.level);
    }
    return list.slice(0, 250);
  }, [methods, skill, sort, search, canDo, membersOnly, hideThin, levels]);

  const active = SORTS.find((s) => s.key === sort);

  return (
    <Panel>
      <PanelHeader
        title="Training methods"
        meta={
          methods
            ? `${methods.length.toLocaleString()} actions from the wiki's calculators, priced live`
            : "loading"
        }
      />

      <Toolbar className="!mb-3">
        <Field label="Skill">
          <Select
            value={skill}
            onChange={(e) => setSkill((e.target as HTMLSelectElement).value)}
            className="min-w-44"
          >
            <option value="buyable">Skills you buy</option>
            <option value="all">Every skill</option>
            {skills.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </Select>
        </Field>

        <Field label="Search">
          <Input
            type="search"
            value={search}
            placeholder="potion, dart, bones…"
            onInput={(e) => setSearch((e.target as HTMLInputElement).value)}
          />
        </Field>

        <Field label="Rank by">
          <div className="flex gap-1 flex-wrap">
            {SORTS.map((s) => (
              <Chip key={s.key} active={sort === s.key} onClick={() => setSort(s.key)}>
                {s.label}
              </Chip>
            ))}
          </div>
        </Field>

        <Field label="Filters">
          <div className="flex items-center gap-4 h-9">
            <label className="flex items-center gap-1.5 text-xs text-gray-400 cursor-pointer">
              <input
                type="checkbox"
                checked={canDo}
                disabled={!levels}
                onChange={(e) => setCanDo((e.target as HTMLInputElement).checked)}
              />
              I can do this
            </label>
            <label className="flex items-center gap-1.5 text-xs text-gray-400 cursor-pointer">
              <input
                type="checkbox"
                checked={membersOnly}
                onChange={(e) => setMembersOnly((e.target as HTMLInputElement).checked)}
              />
              Members only
            </label>
            <label
              className="flex items-center gap-1.5 text-xs text-gray-400 cursor-pointer"
              title={`Hides methods whose product trades fewer than ${THIN_MARKET_VOLUME} units an hour. Their prices are set by a handful of trades and read as enormous profits that do not exist.`}
            >
              <input
                type="checkbox"
                checked={hideThin}
                onChange={(e) => setHideThin((e.target as HTMLInputElement).checked)}
              />
              Hide thin markets
            </label>
          </div>
        </Field>
      </Toolbar>

      {active && <p className="text-[11px] text-gray-500 mb-2">{active.hint}</p>}
      {error && <p className="text-xs text-rose-400">{error}</p>}
      {failed.length > 0 && (
        <p className="text-[11px] text-amber-400/80 mb-2">
          Could not load {failed.join(", ")} from the wiki, so those skills are missing from this
          list rather than partly wrong.
        </p>
      )}
      {!methods && !error && <p className="text-xs text-gray-500">Loading every trainable action…</p>}

      {methods && rows.length === 0 && (
        <EmptyState
          title="Nothing matches"
          hint="The rank is dropping rows it cannot score. Cheapest needs a live price for every material; fastest needs an hourly rate the wiki actually states."
        />
      )}

      {methods && rows.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="text-[10px] uppercase tracking-wider text-gray-500 border-b border-white/10">
                <th className="py-1.5 pl-2 pr-3 font-medium">Method</th>
                <th className="py-1.5 px-2 font-medium">Skill</th>
                <th className="py-1.5 px-2 font-medium text-right">Lvl</th>
                <th className="py-1.5 px-2 font-medium text-right">XP</th>
                <th
                  className="py-1.5 px-2 font-medium text-right"
                  title="Gp burnt for one experience point, after GE tax on whatever you sell. Negative means the method pays you."
                >
                  Gp/xp
                </th>
                <th className="py-1.5 px-2 font-medium text-right">Cost/action</th>
                <th
                  className="py-1.5 px-2 font-medium text-right"
                  title="Only shown where a training guide states an hourly rate. The rate and its source are on the expanded row."
                >
                  XP/hr
                </th>
                <th className="py-1.5 px-2 pr-2 font-medium text-right">Gp/hr</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((m) => (
                <MethodRow
                  key={m.id}
                  method={m}
                  playerLevel={levels?.[m.skill.toLowerCase()] ?? null}
                  expanded={expanded === m.id}
                  onToggle={() => setExpanded((cur) => (cur === m.id ? null : m.id))}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="text-[10px] text-gray-600 mt-3 max-w-4xl">
        Costs are computed from live prices: materials bought at the current bid, product sold at
        the current ask minus the 2% GE tax. Experience per hour appears only where a wiki training
        guide states a rate for that kind of method, and the sentence it came from is on the
        expanded row. Methods with no stated rate still have an exact cost, which is the number
        that decides what to train, and the rate only decides how long it takes.
      </p>
    </Panel>
  );
}

// --- page ----------------------------------------------------------------------------------

export function Skilling() {
  const [username, setUsername] = useState(() => loadSettings().womUsername);
  const [player, setPlayer] = useState<PlayerSnapshot | null>(null);

  // Saved back to settings rather than held locally. The money makers page keeps its copy of this
  // field in component state, so a name typed there is gone on the next render of anything else,
  // which is the kind of small betrayal that makes a filter look broken.
  function updateUsername(next: string) {
    setUsername(next);
    saveSettings({ ...loadSettings(), womUsername: next });
  }

  useEffect(() => {
    if (!username.trim()) return;
    let cancelled = false;
    fetchPlayerSnapshot(username)
      .then((p) => !cancelled && setPlayer(p))
      .catch(() => {
        /* the panels below each say what they cannot do without levels */
      });
    return () => {
      cancelled = true;
    };
  }, [username]);

  const levels = useMemo(() => {
    if (!player) return null;
    const out: Record<string, number> = {};
    for (const [name, s] of Object.entries(player.skills)) out[name.toLowerCase()] = s.level;
    return out;
  }, [player]);

  return (
    <div>
      <Bankstanding username={username} onUsernameChange={updateUsername} />
      <TrainingMethods levels={levels} />
    </div>
  );
}
