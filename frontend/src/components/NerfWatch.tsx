import { useEffect, useMemo, useState } from "preact/hooks";
import { fetchNerfWatch, type MarketItem, type NerfWatchMatch } from "../api";
import type { HoldingEntry } from "../bankHoldings";
import { formatGp } from "../format";

// Patch notes that name something you are holding.
//
// The request was "an alert when official news says an item is getting nerfed and you hold it",
// and that is what the top of this panel is for. The rest of it exists because of what six weeks
// of real patch notes turned out to contain: mostly mentions whose direction the changelog never
// states. Those are still worth surfacing -- "the last update talks about a thing you own, here is
// the sentence" is a real prompt to go and look -- but they are not warnings, and rendering them
// as though they were would make the panel cry wolf until it got ignored.
//
// So the two are separated visually and by default: directional calls are always open, bare
// mentions are folded away behind a count. Nothing is hidden, and nothing quiet is dressed up as
// urgent.

const DISMISS_KEY = "nerfWatchDismissed";

function loadDismissed(): Set<string> {
  try {
    const raw = localStorage.getItem(DISMISS_KEY);
    return new Set(raw ? (JSON.parse(raw) as string[]) : []);
  } catch {
    return new Set();
  }
}

function saveDismissed(ids: Set<string>) {
  try {
    localStorage.setItem(DISMISS_KEY, JSON.stringify([...ids]));
  } catch {
    // A full or blocked localStorage must not take the panel down with it -- the alert still
    // works for this session, it just forgets what was dismissed.
  }
}

/** One row per item per article, so an item named in two updates is two things to read. */
function matchKey(m: NerfWatchMatch): string {
  return `${m.eventId}:${m.itemId}`;
}

const IMPACT_STYLE: Record<string, { label: string; chip: string; rail: string }> = {
  nerf: {
    label: "Likely nerf",
    chip: "bg-rose-500/15 text-rose-300 border-rose-400/40",
    rail: "border-l-rose-400/60",
  },
  buff: {
    label: "Likely buff",
    chip: "bg-emerald-500/15 text-emerald-300 border-emerald-400/40",
    rail: "border-l-emerald-400/60",
  },
  unclear: {
    label: "Mentioned",
    chip: "bg-white/5 text-gray-400 border-white/10",
    rail: "border-l-white/15",
  },
};

function Row({
  match,
  exposure,
  onOpen,
  onDismiss,
}: {
  match: NerfWatchMatch;
  exposure: number | null;
  onOpen: () => void;
  onDismiss: () => void;
}) {
  const style = IMPACT_STYLE[match.impact] ?? IMPACT_STYLE.unclear;
  return (
    <div className={`border-l-2 ${style.rail} pl-3 py-2 flex flex-col gap-1`}>
      <div className="flex items-center gap-2 flex-wrap">
        <span
          className={`px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wide border ${style.chip}`}
        >
          {style.label}
        </span>
        <button
          onClick={onOpen}
          className="text-sm text-gray-100 font-medium hover:text-white hover:underline"
        >
          {match.itemName}
        </button>
        {/* What it would cost you, not just that it happened. A nerf to 200gp of feathers and a
            nerf to 300m of bows are the same row without this. */}
        {exposure != null && exposure > 0 && (
          <span className="text-[11px] text-gray-500">
            you hold <span className="font-mono text-gray-300">{formatGp(exposure)}</span>
          </span>
        )}
        <span className="text-[11px] text-gray-600 ml-auto shrink-0">{match.eventDate}</span>
        <button
          onClick={onDismiss}
          title="Dismiss this one"
          className="text-gray-600 hover:text-gray-300 text-xs leading-none px-1"
        >
          ×
        </button>
      </div>

      {/* The sentence, verbatim, always. The label above it is keyword matching on patch-note
          prose and it will sometimes be wrong; this is how you overrule it in one glance, and it
          is the reason the panel can afford to guess at all. */}
      <p className="text-[11px] text-gray-400 leading-relaxed">"{match.quote}"</p>

      <div className="flex items-center gap-2 text-[10px] text-gray-600 flex-wrap">
        <span>{match.basis}</span>
        <span>·</span>
        {match.link ? (
          <a
            href={match.link}
            target="_blank"
            rel="noreferrer"
            className="text-violet-400 hover:text-violet-300"
          >
            {match.title}
          </a>
        ) : (
          <span>{match.title}</span>
        )}
      </div>
    </div>
  );
}

export function NerfWatch({
  holdings,
  items,
  onSelectItem,
}: {
  holdings: Record<number, HoldingEntry>;
  items: MarketItem[];
  onSelectItem: (item: MarketItem) => void;
}) {
  const [matches, setMatches] = useState<NerfWatchMatch[]>([]);
  const [dismissed, setDismissed] = useState<Set<string>>(loadDismissed);
  const [showMentions, setShowMentions] = useState(false);

  // Sorted and joined so the dependency is the SET of held ids, not the holdings object. Bank
  // values are rewritten on every valuation refresh, so keying on the object itself would refetch
  // constantly while the actual question -- which items do I own -- had not changed.
  const heldKey = useMemo(
    () =>
      Object.keys(holdings)
        .map(Number)
        .sort((a, b) => a - b)
        .join(","),
    [holdings],
  );

  useEffect(() => {
    let cancelled = false;
    const ids = heldKey ? heldKey.split(",").map(Number) : [];
    if (ids.length === 0) {
      setMatches([]);
      return;
    }
    fetchNerfWatch(ids)
      .then((res) => !cancelled && setMatches(res.matches))
      .catch(() => !cancelled && setMatches([])); // additive: the app is fine without it
    return () => {
      cancelled = true;
    };
  }, [heldKey]);

  function dismiss(key: string) {
    setDismissed((prev) => {
      const next = new Set(prev).add(key);
      saveDismissed(next);
      return next;
    });
  }

  const visible = matches.filter((m) => !dismissed.has(matchKey(m)));
  const directional = visible.filter((m) => m.impact !== "unclear");
  const mentions = visible.filter((m) => m.impact === "unclear");

  if (visible.length === 0) return null;

  function exposureOf(m: NerfWatchMatch): number | null {
    return holdings[m.itemId]?.netValue ?? null;
  }

  function open(m: NerfWatchMatch) {
    const item = items.find((i) => i.id === m.itemId);
    if (item) onSelectItem(item);
  }

  return (
    <div className="panel rounded-xl p-4 mb-4">
      <div className="flex items-center gap-2 mb-1 flex-wrap">
        <h3 className="text-sm font-medium text-gray-200">Patch notes on your holdings</h3>
        <span
          className="text-[10px] text-gray-600"
          title="Official changelogs from the last 45 days, matched against your imported bank by exact item name. Podcasts, community posts and rewards blogs are not scanned: a blog proposes, a changelog records."
        >
          official changelogs, last 45 days
        </span>
      </div>

      {directional.length > 0 ? (
        <div className="flex flex-col gap-2 mt-2">
          {directional.map((m) => (
            <Row
              key={matchKey(m)}
              match={m}
              exposure={exposureOf(m)}
              onOpen={() => open(m)}
              onDismiss={() => dismiss(matchKey(m))}
            />
          ))}
        </div>
      ) : (
        <p className="text-[11px] text-gray-500 mt-1">
          Nothing in recent patch notes reads as a nerf or a buff to anything you hold.
        </p>
      )}

      {mentions.length > 0 && (
        <div className="mt-3 pt-3 border-t border-white/[0.06]">
          <button
            onClick={() => setShowMentions((v) => !v)}
            className="text-[11px] text-gray-500 hover:text-gray-300"
          >
            {showMentions ? "Hide" : "Show"} {mentions.length} item
            {mentions.length === 1 ? "" : "s"} named without a stated direction
          </button>
          {showMentions && (
            <div className="flex flex-col gap-2 mt-2">
              {mentions.map((m) => (
                <Row
                  key={matchKey(m)}
                  match={m}
                  exposure={exposureOf(m)}
                  onOpen={() => open(m)}
                  onDismiss={() => dismiss(matchKey(m))}
                />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
