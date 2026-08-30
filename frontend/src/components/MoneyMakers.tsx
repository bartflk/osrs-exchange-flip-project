import { useEffect, useMemo, useState } from "preact/hooks";
import {
  fetchBestGear,
  fetchMoneyMakers,
  type GearResponse,
  type MoneyMakerRow,
} from "../api";
import { formatGp } from "../format";
import { loadSettings } from "../settings";
import { StrategySetupPanel } from "./StrategySetup";
import { Badge, Button, EmptyState, Field, GpInput, Input, Panel, Select, Toolbar } from "./ui";

// What to do with your time, with the wiki's own hourly profit as the headline and this app's
// live recomputation beside it.
//
// That ordering is a correction. This page used to lead with the recomputed figure on the belief
// that the wiki's was a stale snapshot baked in at edit time. It is not -- the wiki prices its
// table from current Grand Exchange data on every render -- and the recomputation was carrying
// five separate parser bugs that put "Crafting sunfire runes" at 64.95m/hr against a real 4.14m
// and "Dismantling bracelets of ethereum" at 147m/hr when it is actually a 2.3m/hr LOSS.
//
// Both numbers are kept, because they answer different questions. The wiki's is right by
// construction, since the template that computes it is the same one the guide authors write
// against. This app's is fresher, priced from a poll that runs every minute rather than the
// wiki's cache. Where they agree, the live one is the better number; where they disagree by a
// lot, the row is telling you not to trust it, and that is worth seeing rather than hiding.
//
// Three things are then layered on that only this app can answer: whether YOUR levels meet the
// requirements (Wise Old Man), whether YOUR bankroll covers the supplies, and what the best gear
// YOUR money can buy for the boss actually is.

type SortKey = "activity" | "profit" | "supplies" | "revenue" | "skill" | "session";

const INTENSITY_TONE: Record<string, string> = {
  low: "border-emerald-400/30 bg-emerald-500/10 text-emerald-300",
  moderate: "border-amber-400/30 bg-amber-500/10 text-amber-300",
  high: "border-rose-400/30 bg-rose-500/10 text-rose-300",
  "very high": "border-rose-400/50 bg-rose-500/20 text-rose-200",
};

/**
 * The image for an item: the GE catalogue's icon, else the wiki thumbnail the backend resolved.
 *
 * The fallback matters more than it sounds. Untradeables and set names ("Elite Void Knight
 * equipment", "Cheap food", "Mokhaiotl cloth") have no GE icon at all, and every one of them was
 * rendering as a bare "?" -- the Doom of Mokhaiotl showed seven question marks in its gear row and
 * three more against its biggest income lines.
 */
function itemImage(item: { icon: string | null; imageUrl?: string | null }): string | null {
  if (item.icon) {
    return `https://oldschool.runescape.wiki/images/${encodeURIComponent(item.icon.replace(/ /g, "_"))}`;
  }
  return item.imageUrl ?? null;
}

/** Item icon with its name as the tooltip, falling back to a short label when there is no image. */
function ItemChip({
  item,
  sub,
  tone = "",
}: {
  item: { name: string; icon: string | null; imageUrl?: string | null };
  sub?: string;
  tone?: string;
}) {
  const url = itemImage(item);
  return (
    <span
      title={sub ? `${item.name} — ${sub}` : item.name}
      className={`inline-flex items-center gap-1 px-1.5 py-1 rounded border border-white/10 bg-white/5 ${tone}`}
    >
      {url ? (
        <img src={url} alt="" width={20} height={20} className="shrink-0 object-contain" loading="lazy" />
      ) : (
        // The name, truncated, rather than a "?" -- a question mark says only that something is
        // missing, while three letters at least say WHICH thing.
        <span className="text-[9px] text-gray-500 px-0.5 max-w-[3.5rem] truncate">{item.name}</span>
      )}
      {sub && <span className="text-[10px] font-mono text-gray-400 tabular-nums">{sub}</span>}
    </span>
  );
}

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
  const headline = row.headlineProfitPerHour;
  const tone = headline >= 0 ? "text-emerald-400" : "text-rose-400";
  // Only flagged past 25%. Below that the gap is ordinary price drift between the wiki's cache
  // and this app's poll, which is not a defect and should not be dressed up as one.
  const disputed = row.divergence != null && row.divergence > 0.25;
  return (
    <div className="leading-tight">
      <div
        className={`font-mono font-semibold tabular-nums ${tone}`}
        title={
          row.headlineSource === "wiki"
            ? "The wiki's own figure, priced from current GE data by the same template the guide is written in."
            : `Not listed in the wiki's table, so this is this app's own live recomputation. ${RELIABILITY_NOTE[row.reliability]}`
        }
      >
        {row.headlineSource === "live" && row.reliability === "floor" ? "≥" : ""}
        {row.headlineSource === "live" && row.reliability === "overstated" ? "≤" : ""}
        {formatGp(headline)}
      </div>
      {row.wikiProfitPerHour != null ? (
        <div
          className={`text-[10px] font-mono tabular-nums ${disputed ? "text-amber-400" : "text-gray-600"}`}
          title={
            disputed
              ? "This app's live recomputation disagrees with the wiki by more than 25%. One of the two is wrong, so treat this row's number as unverified."
              : "This app's own recomputation from live prices, for comparison."
          }
        >
          {disputed ? "⚠ live " : "live "}
          {formatGp(row.profitPerHour)}
        </div>
      ) : (
        // Without a wiki figure there is nothing to check this against, and the recomputation
        // has a known tail of bad rows. Saying so is the difference between a number the reader
        // can calibrate and one they cannot -- an unlabelled figure here would look exactly as
        // authoritative as the corroborated ones sitting above and below it.
        <div
          className="text-[10px] text-gray-600"
          title="This guide is not listed in the wiki's overview table, so there is no second figure to check this against. It is this app's own recomputation only."
        >
          unverified
        </div>
      )}
    </div>
  );
}

/**
 * Profit with rare drops stripped out: what a two-hour session actually pays.
 *
 * An hourly average quietly promises you a slice of a drop you will usually not see. At 30
 * kills/hr a 1/1000 drop lands once every 33 hours, yet it is folded into "gp/hr" as though it
 * arrived evenly. Both numbers are true; only one of them describes tonight.
 */
function SessionCell({ row }: { row: MoneyMakerRow }) {
  if (row.profitPerHourNoUniques == null) {
    return <span className="text-[10px] text-gray-700">n/a</span>;
  }
  const share = row.rareShare ?? 0;
  return (
    <div className="leading-tight">
      <div
        className={`font-mono tabular-nums ${row.profitPerHourNoUniques >= 0 ? "text-gray-300" : "text-rose-400"}`}
        title="Hourly profit with every drop you expect less than once an hour removed. This is what a short session pays if you do not hit the jackpot."
      >
        {formatGp(row.profitPerHourNoUniques)}
      </div>
      {share > 0.05 && (
        <div
          className="text-[10px] text-violet-400 tabular-nums"
          title={`${Math.round(share * 100)}% of this activity's gross income comes from drops you expect less than once an hour.`}
        >
          {Math.round(share * 100)}% uniques
        </div>
      )}
    </div>
  );
}

/**
 * The expanded row: the kit, the hour's consumables, and the drop table split by rarity.
 *
 * Laid out as three named blocks rather than a two-column dump of every line. The supplies list IS
 * the inventory setup -- "100 cheap food, 15 super restores, 2.5 antivenom per hour" is exactly
 * what you pack -- and showing it as icons with quantities reads as a loadout instead of a
 * spreadsheet.
 */
function GuideDetail({ row }: { row: MoneyMakerRow }) {
  // The guide's `Item` list is prose ("Food and potions", "Elite Void Knight equipment"), so when
  // the wiki has a real loadout for this boss the list is strictly worse information sitting
  // directly beneath a strictly better version of it. On the Doom of Mokhaiotl it rendered as
  // seven unresolvable chips and a 1.76b total covering 2 of its 9 entries.
  const [hasSetup, setHasSetup] = useState(false);
  const outputs = [...row.outputs].sort((a, b) => b.value - a.value);
  const common = outputs.filter((o) => !o.rare);
  const rare = outputs.filter((o) => o.rare);
  const qty = (n: number) =>
    n >= 10
      ? Math.round(n).toLocaleString()
      : n.toLocaleString(undefined, { maximumFractionDigits: 2 });

  return (
    <div className="flex flex-col gap-4">
      {/* The wiki's real loadout comes first when there is one: it supersedes the guide's prose
          gear list, which says things like "Food and potions". Renders nothing for the ~90% of
          activities that are not bosses with a Strategies page. */}
      <StrategySetupPanel activity={row.activity} onResolved={setHasSetup} />

      {row.gear.length > 0 && !hasSetup && (
        <div>
          <DetailHeading
            label="Gear the guide names"
            note={
              row.gearPricedCount > 0
                ? `${formatGp(row.gearCost)} for the ${row.gearPricedCount} of ${row.gear.length} pieces that are GE items, a floor since untradeables and set names carry no price`
                : "none of these resolved to a tradeable GE item"
            }
          />
          <div className="flex flex-wrap gap-1">
            {row.gear.map((g) => (
              <ItemChip
                key={g.name}
                item={g}
                sub={g.price == null ? undefined : formatGp(g.price)}
              />
            ))}
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div>
          <DetailHeading
            label="Supplies per hour"
            note={`${formatGp(row.inputCost)} total, this is the inventory you pack`}
          />
          {row.inputs.length === 0 ? (
            <div className="text-[11px] text-gray-600">none</div>
          ) : (
            <div className="flex flex-wrap gap-1">
              {row.inputs.map((i) => (
                <ItemChip
                  key={i.name}
                  item={i}
                  sub={qty(i.qtyPerHour)}
                  tone={i.unitPrice == null ? "border-amber-400/40" : ""}
                />
              ))}
            </div>
          )}
          {row.inputs.some((i) => i.unitPrice == null) && (
            <p className="text-[10px] text-amber-400/80 mt-1">
              Amber-outlined supplies have no GE price, so their cost is missing from the total.
            </p>
          )}
        </div>

        <div>
          <DetailHeading label="Income per hour" note="after GE tax, biggest first" />
          {common.slice(0, 8).map((o) => (
            <LineRow key={o.name} line={o} qty={qty} />
          ))}
          {common.length > 8 && (
            <div className="text-[10px] text-gray-600 mt-0.5">
              +{common.length - 8} smaller lines
            </div>
          )}
        </div>
      </div>

      {rare.length > 0 && (
        <div>
          <DetailHeading
            label="Rare drops"
            note={`expected less than once an hour, holding ${Math.round((row.rareShare ?? 0) * 100)}% of gross income you will usually not see in a session`}
          />
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6">
            {rare.map((o) => (
              <LineRow key={o.name} line={o} qty={qty} rate />
            ))}
          </div>
        </div>
      )}

      <p className="text-[10px] text-gray-600">
        {row.headlineSource === "wiki"
          ? "Headline is the wiki's own figure. The breakdown here is this app's live recomputation, which is why the two can differ."
          : `Not in the wiki's overview table, so the headline is this app's own figure. ${RELIABILITY_NOTE[row.reliability]}`}
      </p>
    </div>
  );
}

function DetailHeading({ label, note }: { label: string; note?: string }) {
  return (
    <div className="text-[10px] uppercase tracking-wider text-gray-500 mb-1.5">
      {label}
      {note && <span className="normal-case tracking-normal text-gray-600"> &middot; {note}</span>}
    </div>
  );
}

function LineRow({
  line,
  qty,
  rate,
}: {
  line: MoneyMakerRow["outputs"][number];
  qty: (n: number) => string;
  rate?: boolean;
}) {
  // A drop rate reads far better as "1 in 1,000" than as the 0.001-per-kill the guide stores.
  const oneIn = rate && line.perAction ? Math.round(1 / line.perAction) : null;
  // "1/20" alone hides how long that actually takes. The Doom of Mokhaiotl runs at 2.5 kills an
  // hour, so its 1-in-20 drops are one every NINETEEN hours -- which is the fact that decides
  // whether they count as income, and it is invisible in the rate alone.
  const hours = rate && line.qtyPerHour > 0 ? 1 / line.qtyPerHour : null;
  return (
    <div className="flex items-center justify-between gap-2 text-[11px] py-0.5">
      <span className="flex items-center gap-1.5 min-w-0">
        <ItemChip item={line} />
        <span className="text-gray-400 truncate">{line.name}</span>
        <span className="text-gray-600 shrink-0">
          {oneIn ? `1/${oneIn.toLocaleString()}` : `\u00d7${qty(line.qtyPerHour)}`}
          {hours != null && (
            <span className="text-gray-700">
              {" "}
              &middot; ~{hours >= 1 ? `${Math.round(hours)}h` : `${Math.round(hours * 60)}min`} each
            </span>
          )}
        </span>
      </span>
      <span className="font-mono shrink-0 text-emerald-300 tabular-nums">
        {line.unitPrice == null ? "not priced" : formatGp(line.value)}
      </span>
    </div>
  );
}

/** The monster a "Killing X ..." activity is about, with method and scope suffixes removed. */
function monsterNameFrom(activity: string): string {
  return activity
    .replace(/^(Killing|Fighting)\s+/i, "")
    .split(/ using | with |,/)[0]
    .replace(/\s*\([^)]*\)\s*$/, "")
    .replace(/^The\s+/i, "")
    .trim();
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

  // Silent on failure. This panel is a bonus -- the wiki's own setup is shown above it and is the
  // better answer -- so an unmatched monster name is a reason to show nothing, not to print
  // "No gear data: no monster named ..." underneath a perfectly good loadout, which is what the
  // Doom of Mokhaiotl row was doing.
  if (error) return null;
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
  const [hideDisputed, setHideDisputed] = useState(false);
  const [bossOnly, setBossOnly] = useState(false);

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
      // Only guides with NO counted cost are hidden, and only when the headline is OUR figure.
      //
      // That second condition matters and was missing at first. `costsUnknown` describes this
      // app's recomputation, so once the wiki's own figure became the headline it stopped being
      // a reason to hide anything: Nex (Duo) at 11.10m and the Theatre of Blood at 9.73m were
      // both dropped off the board despite their displayed number coming from the wiki and being
      // perfectly sound. The flag now gates only the rows it actually describes.
      if (hideOverstated && r.costsUnknown && r.headlineSource === "live") return false;
      if (hideDisputed && r.divergence != null && r.divergence > 0.25) return false;
      // "Boss" is taken from the guide's own wording rather than a curated list: a guide whose
      // activity starts with Killing/Fighting and whose drops include something rarer than
      // 1-in-100 is a boss for the purpose of "what does this pay without the jackpot".
      if (bossOnly && r.profitPerHourNoUniques == null) return false;
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
          // Ranked on the HEADLINE, so the list is ordered by the same number it displays.
          // Sorting by the live recomputation while showing the wiki's put rows in an order the
          // page appeared to contradict.
          return r.headlineProfitPerHour;
        case "session":
          return r.profitPerHourNoUniques ?? r.headlineProfitPerHour;
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
  }, [rows, search, onlyDoable, hideOverstated, hideDisputed, bossOnly, category, sortKey, sortDir]);

  return (
    <div>
      <Toolbar
        aside={
          <>
            Headline gp/hr is the wiki&apos;s own figure, which it prices from current GE data.
            This app&apos;s independent recomputation from live prices sits underneath it, and a
            row is flagged when the two disagree by more than 25%. &ldquo;No uniques&rdquo; strips
            drops you expect less than once an hour, so it is what a short session pays without a
            jackpot.
            Requirements come from your Wise Old Man profile.
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
          <Button
            size="sm"
            active={bossOnly}
            onClick={() => setBossOnly((v) => !v)}
            title="Only activities with per-kill drop tables, where the without-uniques figure means something"
          >
            Bosses
          </Button>
          <Button
            size="sm"
            active={hideDisputed}
            onClick={() => setHideDisputed((v) => !v)}
            title="Hide rows where this app's live recomputation and the wiki disagree by more than 25%"
          >
            Hide disputed
          </Button>
        </Field>
      </Toolbar>

      {error && <p className="text-xs text-rose-400 mb-3">{error}</p>}

      <Panel padded={false}>
        <div className="px-4 py-3 flex items-baseline justify-between flex-wrap gap-2">
          <h3 className="text-sm font-semibold text-gray-100">
            Money makers
            <span className="ml-2 text-[11px] font-normal text-gray-500">
              {visible.length} shown of {rows.length} · headline gp/hr from the wiki, cross-checked
              against live prices
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
                  <SortHeader label="No uniques" k="session" sortKey={sortKey} dir={sortDir} onSort={toggleSort} align="right" />
                  <SortHeader label="Supplies/hr" k="supplies" sortKey={sortKey} dir={sortDir} onSort={toggleSort} align="right" />
                  <th className="px-3 py-2 font-medium">Kit</th>
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
                          <div className="text-[10px] text-gray-600 flex items-center gap-1.5 flex-wrap mt-0.5">
                            {r.intensity && (
                              <span
                                title={`Click intensity: ${r.intensity}. How much attention the method demands, from the guide itself.`}
                                className={`px-1.5 py-0.5 rounded border text-[9px] uppercase tracking-wide ${
                                  INTENSITY_TONE[r.intensity.toLowerCase()] ??
                                  "border-white/10 bg-white/5 text-gray-400"
                                }`}
                              >
                                {r.intensity}
                              </span>
                            )}
                            <span>{r.members ? "members" : "F2P"}</span>
                            {r.kph != null && <span>· {r.kph.toLocaleString()}/hr</span>}
                            {r.category && <span>· {r.category}</span>}
                          </div>
                        </td>
                        <td className="px-3 py-2 text-right">
                          <ProfitCell row={r} />
                        </td>
                        <td className="px-3 py-2 text-right">
                          <SessionCell row={r} />
                        </td>
                        <td className="px-3 py-2 text-right font-mono text-gray-400 tabular-nums">
                          {formatGp(r.inputCost)}
                          {r.affordable === false && (
                            <div className="text-[10px] text-rose-400">over budget</div>
                          )}
                        </td>
                        <td className="px-3 py-2">
                          {/* The gear the guide names, as icons. Six is where the row stops being
                              a row; the rest are in the expanded panel. */}
                          <div className="flex items-center gap-0.5 flex-wrap">
                            {r.gear.slice(0, 6).map((g) => (
                              <ItemChip key={g.name} item={g} />
                            ))}
                            {r.gear.length > 6 && (
                              <span className="text-[10px] text-gray-600 ml-0.5">
                                +{r.gear.length - 6}
                              </span>
                            )}
                            {r.gear.length === 0 && (
                              <span className="text-[10px] text-gray-700">none listed</span>
                            )}
                          </div>
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
                          <td colSpan={6} className="px-4 py-3">
                            <GuideDetail row={r} />

                            {/* Gear is only asked for on activities that name a monster -- there is
                                nothing to optimise a loadout against for a farming run. The
                                parenthetical scope has to come off too: "The Doom of Mokhaiotl
                                (Delve 1-16)" is not a monster name, and looking it up as one is
                                how that row ended up reporting a failure. */}
                            {/^(Killing|Fighting) /i.test(r.activity) && (
                              <GearPanel
                                monster={monsterNameFrom(r.activity)}
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
