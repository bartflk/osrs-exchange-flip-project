import { useEffect, useMemo, useState } from "preact/hooks";
import {
  fetchBestGear,
  fetchMoneyMakers,
  type GearResponse,
  type MoneyMakerRow,
} from "../api";
import { formatGp } from "../format";
import { loadSettings } from "../settings";
import { Badge, Button, EmptyState, Field, GpInput, Input, Panel, Select, Toolbar } from "./ui";

// What to do with your time, priced with the same live market data as everything else.
//
// The OSRS Wiki publishes a gp/hr on each money-making guide, but it is baked in whenever the page
// was last edited. What the guides really provide is the RECIPE -- items consumed and produced per
// hour -- and multiplying that by prices this app already polls every minute gives a figure that
// is current, which the wiki's own number is not.
//
// Three things are then layered on that only this app can answer: whether YOUR levels meet the
// requirements (Wise Old Man), whether YOUR bankroll covers the supplies, and what the best gear
// YOUR money can buy for the boss actually is.

type SortKey = "activity" | "profit" | "supplies" | "revenue" | "skill";

const RELIABILITY_NOTE: Record<MoneyMakerRow["reliability"], string> = {
  exact: "Every input and output priced.",
  floor: "An output could not be priced, so the real figure is HIGHER than shown.",
  overstated:
    "A cost line could not be priced, so this is missing an expense and the real figure is LOWER.",
};

function SortHeader({
  label,
  k,
  sortKey,
  dir,
  onSort,
  align,
  className = "",
}: {
  label: string;
  k: SortKey;
  sortKey: SortKey;
  dir: 1 | -1;
  onSort: (k: SortKey) => void;
  align?: "right";
  className?: string;
}) {
  const active = sortKey === k;
  return (
    <th
      onClick={() => onSort(k)}
      className={`py-2 font-medium select-none cursor-pointer hover:text-gray-200 transition-colors ${
        align === "right" ? "text-right px-3" : "px-3"
      } ${className}`}
    >
      {label}{" "}
      <span className={active ? "text-violet-400" : "text-gray-700"}>
        {active ? (dir === 1 ? "\u2191" : "\u2193") : "\u2195"}
      </span>
    </th>
  );
}

function ProfitCell({ row }: { row: MoneyMakerRow }) {
  const tone =
    row.reliability === "overstated"
      ? "text-amber-300"
      : row.profitPerHour >= 0
        ? "text-emerald-400"
        : "text-rose-400";
  return (
    <span className={`font-mono font-semibold tabular-nums ${tone}`} title={RELIABILITY_NOTE[row.reliability]}>
      {row.reliability === "floor" ? "≥" : row.reliability === "overstated" ? "≤" : ""}
      {formatGp(row.profitPerHour)}
    </span>
  );
}

function GearPanel({ monster, bankroll, username }: { monster: string; bankroll: number; username?: string }) {
  const [data, setData] = useState<GearResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setData(null);
    setError(null);
    fetchBestGear({ monster, bankroll, username })
      .then((d) => !cancelled && setData(d))
      .catch((e) => !cancelled && setError(e instanceof Error ? e.message : "failed"));
    return () => {
      cancelled = true;
    };
  }, [monster, bankroll, username]);

  if (error) return <p className="text-xs text-gray-500 mt-2">No gear data: {error}</p>;
  if (!data) return <div className="h-24 mt-2 rounded-lg bg-white/[0.03] animate-pulse" />;

  return (
    <div className="mt-3">
      <div className="flex items-baseline gap-2 flex-wrap mb-2">
        <span className="text-xs text-gray-300 font-medium">
          Best gear for {data.monster.name} on {formatGp(data.budget)}
        </span>
        <span className="text-[10px] text-gray-500">
          {data.monster.hp} hp · {data.monster.defence} def
          {data.monster.attributes.length > 0 && ` · ${data.monster.attributes.join(", ")}`}
        </span>
        {!data.levelsKnown && <Badge tone="warning">assuming 99s</Badge>}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-2">
        {data.loadouts.map((lo, idx) => (
          <div
            key={lo.style}
            className={`rounded-lg border p-2.5 ${
              idx === 0 ? "border-emerald-400/40 bg-emerald-500/[0.06]" : "border-white/8 bg-black/20"
            }`}
          >
            <div className="flex items-baseline justify-between mb-1">
              <span className="text-[11px] uppercase tracking-wider font-semibold text-gray-200">
                {lo.style}
              </span>
              <span className="font-mono text-sm font-semibold text-gray-100 tabular-nums">
                {lo.dps.dps.toFixed(2)} dps
              </span>
            </div>
            <div className="text-[10px] text-gray-500 mb-1.5">
              max {lo.dps.maxHit} · {(lo.dps.accuracy * 100).toFixed(0)}% acc ·{" "}
              {Number.isFinite(lo.dps.timeToKill) ? `${lo.dps.timeToKill.toFixed(0)}s kill` : "—"} ·{" "}
              {formatGp(lo.totalCost)}
            </div>
            {lo.dps.effects.map((e) => (
              <div key={e} className="text-[10px] text-violet-300">
                {e}
              </div>
            ))}
            <div className="mt-1.5 space-y-0.5">
              {lo.items.map((i) => (
                <div key={i.slot} className="flex justify-between gap-2 text-[10px]">
                  <span className="text-gray-400 truncate">{i.name}</span>
                  <span className="font-mono text-gray-600 shrink-0">{formatGp(i.price)}</span>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>

      {/* Stated on screen, not just in the code. The wiki's own calculator spends 100KB on the
          special cases this model skips, and a DPS figure that looks authoritative while ignoring
          special attacks and gear passives is exactly the kind of confident wrong number this app
          keeps having to dig out. */}
      <p className="text-[10px] text-gray-600 mt-2 leading-relaxed">
        Estimate. Models effective levels, the accuracy roll, max hit, attack speed, and the gear
        effects that change the answer (dragon-hunter weapons, salve, void, slayer helm). Does not
        model special attacks, defence reduction, multi-phase fights, or supplies. {data.assumedPrayers}.
        Ranged setups that rely on ammunition are currently under-ranked.
      </p>
    </div>
  );
}

export function MoneyMakers() {
  const [rows, setRows] = useState<MoneyMakerRow[]>([]);
  const [player, setPlayer] = useState<string | null>(null);
  const [levelsKnown, setLevelsKnown] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [bankroll, setBankroll] = useState(() => {
    const raw = localStorage.getItem("bankroll");
    const n = raw ? Number(raw) : NaN;
    return Number.isFinite(n) ? n : 10_000_000;
  });
  const [username, setUsername] = useState(() => loadSettings().womUsername ?? "");
  const [search, setSearch] = useState("");
  const [onlyDoable, setOnlyDoable] = useState(false);
  // Shown by default. These were hidden, and hiding them removed every modern boss from the
  // list -- the Doom of Mokhaiotl computes 9.86m/hr but carries a few unpriceable supply lines
  // (spell costs, {{Cheap food}}), and a guide is not unusable because one line of its shopping
  // list has no GE price. The flag stays; the concealment does not.
  const [hideOverstated, setHideOverstated] = useState(true);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>("profit");
  const [sortDir, setSortDir] = useState<1 | -1>(-1);
  const [category, setCategory] = useState<string>("all");

  function toggleSort(key: SortKey) {
    if (key === sortKey) {
      setSortDir((d) => (d === 1 ? -1 : 1));
    } else {
      setSortKey(key);
      setSortDir(key === "activity" ? 1 : -1);
    }
  }

  useEffect(() => {
    let cancelled = false;
    fetchMoneyMakers({ username: username || undefined, bankroll })
      .then((d) => {
        if (cancelled) return;
        setRows(d.guides);
        setPlayer(d.player);
        setLevelsKnown(d.levelsKnown);
      })
      .catch((e) => !cancelled && setError(e instanceof Error ? e.message : "failed"));
    return () => {
      cancelled = true;
    };
  }, [username, bankroll]);

  const categories = useMemo(() => {
    const set = new Set<string>();
    for (const r of rows) if (r.category) set.add(r.category);
    return [...set].sort();
  }, [rows]);

  const visible = useMemo(() => {
    const needle = search.trim().toLowerCase();
    const filtered = rows.filter((r) => {
      if (needle && !r.activity.toLowerCase().includes(needle)) return false;
      if (category !== "all" && r.category !== category) return false;
      // Only guides with NO counted cost are hidden by default, not everything flagged. Hiding
      // all flagged rows removed every modern boss; hiding none let pure-revenue rows (147m/hr
      // with a zero cost side) sit at the top of a sorted list as if comparable.
      if (hideOverstated && r.costsUnknown) return false;
      if (onlyDoable) {
        if (r.requirementsMet === false) return false;
        if (r.affordable === false) return false;
      }
      return true;
    });

    const value = (r: MoneyMakerRow): number | string => {
      switch (sortKey) {
        case "activity":
          return r.activity.toLowerCase();
        case "profit":
          return r.profitPerHour;
        case "supplies":
          return r.inputCost;
        case "revenue":
          return r.outputRevenue;
        case "skill":
          // Sorted by the HIGHEST level the activity demands -- the one that actually gates it.
          // An average would rank a guide needing 99 Slayer and 1 Cooking below one needing 60 of
          // each, which is backwards for "can I do this yet".
          return r.requirements.reduce((max, q) => Math.max(max, q.level), 0);
      }
    };

    return [...filtered].sort((a, b) => {
      const av = value(a);
      const bv = value(b);
      if (typeof av === "string" || typeof bv === "string") {
        return String(av) < String(bv) ? -sortDir : String(av) > String(bv) ? sortDir : 0;
      }
      return (av - bv) * sortDir;
    });
  }, [rows, search, onlyDoable, hideOverstated, category, sortKey, sortDir]);

  return (
    <div>
      <Toolbar
        aside={
          <>
            gp/hr computed from this app&apos;s live prices and the wiki&apos;s per-hour recipe, not
            the figure printed on the guide. Requirements come from your Wise Old Man profile.
          </>
        }
      >
        <Field label="Bankroll">
          <GpInput
            value={bankroll}
            onChange={(v) => {
              setBankroll(v);
              localStorage.setItem("bankroll", String(v));
            }}
            className="w-36"
          />
        </Field>
        <Field label="RuneScape name" hint={levelsKnown ? `levels from ${player}` : "levels unknown"}>
          <Input
            value={username}
            onInput={(e) => setUsername((e.target as HTMLInputElement).value)}
            placeholder="your username"
            className="w-40"
          />
        </Field>
        <Field label="Search">
          <Input
            value={search}
            onInput={(e) => setSearch((e.target as HTMLInputElement).value)}
            placeholder="boss or activity…"
            className="w-44"
          />
        </Field>
        <Field label="Category">
          <Select value={category} onChange={(e) => setCategory((e.target as HTMLSelectElement).value)}>
            <option value="all">All categories</option>
            {categories.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Filters">
          <Button size="sm" active={onlyDoable} onClick={() => setOnlyDoable((v) => !v)}>
            I can do this
          </Button>
          <Button size="sm" active={hideOverstated} onClick={() => setHideOverstated((v) => !v)}>
            Hide zero-cost
          </Button>
        </Field>
      </Toolbar>

      {error && <p className="text-xs text-rose-400 mb-3">{error}</p>}

      <Panel padded={false}>
        <div className="px-4 py-3 flex items-baseline justify-between flex-wrap gap-2">
          <h3 className="text-sm font-semibold text-gray-100">
            Money makers
            <span className="ml-2 text-[11px] font-normal text-gray-500">
              {visible.length} shown of {rows.length} · ranked by live gp/hr
            </span>
          </h3>
        </div>

        {visible.length === 0 ? (
          <EmptyState
            title="Nothing to show"
            hint="If the list is empty the guides may not be scraped yet — POST /api/money-makers/refresh."
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-[10px] uppercase tracking-wider text-gray-500 text-left border-b border-white/8">
                  <SortHeader label="Activity" k="activity" sortKey={sortKey} dir={sortDir} onSort={toggleSort} className="px-4" />
                  <SortHeader label="Profit/hr" k="profit" sortKey={sortKey} dir={sortDir} onSort={toggleSort} align="right" />
                  <SortHeader label="Supplies/hr" k="supplies" sortKey={sortKey} dir={sortDir} onSort={toggleSort} align="right" />
                  <SortHeader label="Income/hr" k="revenue" sortKey={sortKey} dir={sortDir} onSort={toggleSort} align="right" />
                  <SortHeader label="Skills" k="skill" sortKey={sortKey} dir={sortDir} onSort={toggleSort} />
                </tr>
              </thead>
              <tbody>
                {visible.slice(0, 300).map((r) => {
                  const open = expanded === r.title;
                  return (
                    <>
                      <tr
                        key={r.title}
                        onClick={() => setExpanded(open ? null : r.title)}
                        className="border-t border-white/5 hover:bg-white/[0.04] cursor-pointer"
                      >
                        <td className="px-4 py-2">
                          <div className="text-gray-100">{r.activity}</div>
                          <div className="text-[10px] text-gray-600">
                            {r.members ? "members" : "F2P"}
                            {r.kph != null && ` · ${r.kph.toLocaleString()}/hr`}
                            {r.gear.length > 0 && ` · ${r.gear.length} gear items listed`}
                          </div>
                        </td>
                        <td className="px-3 py-2 text-right">
                          <ProfitCell row={r} />
                        </td>
                        <td className="px-3 py-2 text-right font-mono text-gray-400 tabular-nums">
                          {formatGp(r.inputCost)}
                          {r.affordable === false && (
                            <div className="text-[10px] text-rose-400">over budget</div>
                          )}
                        </td>
                        <td className="px-3 py-2 text-right font-mono text-gray-500 tabular-nums">
                          {formatGp(r.outputRevenue)}
                        </td>
                        <td className="px-3 py-2">
                          {r.requirements.length === 0 ? (
                            <span className="text-[10px] text-gray-600">none</span>
                          ) : (
                            <div className="flex flex-wrap gap-1">
                              {r.requirements.slice(0, 5).map((q) => {
                                const miss = r.missingRequirements.find((m) => m.skill === q.skill);
                                return (
                                  <span
                                    key={q.skill + q.level}
                                    title={miss ? `you have ${miss.have}` : undefined}
                                    className={`px-1.5 py-0.5 rounded text-[10px] font-mono border ${
                                      miss
                                        ? "border-amber-400/40 bg-amber-500/10 text-amber-300"
                                        : r.requirementsMet
                                          ? "border-emerald-400/30 bg-emerald-500/10 text-emerald-300"
                                          : "border-white/10 bg-white/5 text-gray-400"
                                    }`}
                                  >
                                    {q.skill.slice(0, 4)} {q.level}
                                  </span>
                                );
                              })}
                            </div>
                          )}
                        </td>
                      </tr>
                      {open && (
                        <tr key={`${r.title}-detail`} className="bg-black/25">
                          <td colSpan={5} className="px-4 py-3">
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                              <div>
                                <div className="text-[10px] uppercase tracking-wider text-gray-500 mb-1">
                                  Costs per hour
                                </div>
                                {r.inputs.length === 0 && (
                                  <div className="text-[11px] text-gray-600">none</div>
                                )}
                                {r.inputs.map((i) => (
                                  <div key={i.name} className="flex justify-between gap-2 text-[11px]">
                                    <span className="text-gray-400 truncate">
                                      {i.name} ×{i.qtyPerHour.toLocaleString(undefined, {
                                        maximumFractionDigits: 1,
                                      })}
                                    </span>
                                    <span className="font-mono shrink-0 text-rose-300">
                                      {i.unitPrice == null ? "not priced" : formatGp(i.value)}
                                    </span>
                                  </div>
                                ))}
                              </div>
                              <div>
                                <div className="text-[10px] uppercase tracking-wider text-gray-500 mb-1">
                                  Income per hour (after tax)
                                </div>
                                {[...r.outputs]
                                  .sort((a, b) => b.value - a.value)
                                  .slice(0, 10)
                                  .map((o) => (
                                    <div key={o.name} className="flex justify-between gap-2 text-[11px]">
                                      <span className="text-gray-400 truncate">
                                        {o.name} ×{o.qtyPerHour.toLocaleString(undefined, {
                                          maximumFractionDigits: 1,
                                        })}
                                      </span>
                                      <span className="font-mono shrink-0 text-emerald-300">
                                        {o.unitPrice == null ? "not priced" : formatGp(o.value)}
                                      </span>
                                    </div>
                                  ))}
                              </div>
                            </div>

                            <p className="text-[10px] text-gray-600 mt-2">
                              {RELIABILITY_NOTE[r.reliability]}
                            </p>

                            {/* Gear is only asked for on activities that name a monster -- there is
                                nothing to optimise a loadout against for a farming run. */}
                            {/^(Killing|Fighting) /i.test(r.activity) && (
                              <GearPanel
                                monster={r.activity.replace(/^(Killing|Fighting)\s+/i, "").split(/ using | with |,/)[0].trim()}
                                bankroll={bankroll}
                                username={username || undefined}
                              />
                            )}
                          </td>
                        </tr>
                      )}
                    </>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </div>
  );
}
