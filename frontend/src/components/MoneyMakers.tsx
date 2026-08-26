import { useEffect, useMemo, useState } from "preact/hooks";
import {
  fetchBestGear,
  fetchMoneyMakers,
  type GearResponse,
  type MoneyMakerRow,
} from "../api";
import { formatGp } from "../format";
import { loadSettings } from "../settings";
import { Badge, Button, EmptyState, Field, GpInput, Input, Panel, Toolbar } from "./ui";

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

const RELIABILITY_NOTE: Record<MoneyMakerRow["reliability"], string> = {
  exact: "Every input and output priced.",
  floor: "An output could not be priced, so the real figure is HIGHER than shown.",
  overstated:
    "A cost line could not be priced, so this is missing an expense and the real figure is LOWER.",
};

function ProfitCell({ row }: { row: MoneyMakerRow }) {
  const tone =
    row.reliability === "overstated"
      ? "text-amber-300"
      : row.profitPerHour >= 0
        ? "text-emerald-400"
        : "text-rose-400";
  return (
    <span className={`font-mono font-semibold tabular-nums ${tone}`} title={RELIABILITY_NOTE[row.reliability]}>
      {row.reliability === "floor" ? "≥" : row.reliability === "overstated" ? "≤?" : ""}
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
  const [hideOverstated, setHideOverstated] = useState(true);
  const [expanded, setExpanded] = useState<string | null>(null);

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

  const visible = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return rows.filter((r) => {
      if (needle && !r.activity.toLowerCase().includes(needle)) return false;
      // "Overstated" means a cost line is missing, so the profit is inflated by an unknown amount.
      // Hidden by default rather than mixed in: a number that is wrong in a known direction should
      // not sit in a sorted list pretending to be comparable.
      if (hideOverstated && r.reliability === "overstated") return false;
      if (onlyDoable) {
        if (r.requirementsMet === false) return false;
        if (r.affordable === false) return false;
      }
      return true;
    });
  }, [rows, search, onlyDoable, hideOverstated]);

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
        <Field label="Filters">
          <Button size="sm" active={onlyDoable} onClick={() => setOnlyDoable((v) => !v)}>
            I can do this
          </Button>
          <Button size="sm" active={hideOverstated} onClick={() => setHideOverstated((v) => !v)}>
            Hide unpriced costs
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
                  <th className="px-4 py-2 font-medium">Activity</th>
                  <th className="px-3 py-2 font-medium text-right">Profit/hr</th>
                  <th className="px-3 py-2 font-medium text-right">Supplies/hr</th>
                  <th className="px-3 py-2 font-medium text-right">Per hour</th>
                  <th className="px-3 py-2 font-medium">Requirements</th>
                </tr>
              </thead>
              <tbody>
                {visible.slice(0, 120).map((r) => {
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
                          {r.requirementsMet === null ? (
                            <span className="text-[10px] text-gray-600">unknown</span>
                          ) : r.requirementsMet ? (
                            <Badge tone="success">met</Badge>
                          ) : (
                            <span className="text-[10px] text-amber-300">
                              {r.missingRequirements
                                .map((m) => `${m.skill} ${m.have}/${m.needed}`)
                                .join(", ")}
                            </span>
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
