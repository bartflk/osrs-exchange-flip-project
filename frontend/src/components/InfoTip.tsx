import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import { createPortal } from "preact/compat";
import type { ReactNode } from "preact/compat";
import { EXPLANATIONS, type Explanation, type ExplanationId } from "../explanations";

// A hover/focus popover for explaining a calculation, rather than the native `title` attribute
// this app used to lean on everywhere. Three reasons `title` wasn't good enough for formulas:
// it can't render a monospace formula block, it takes ~1s to appear and then times out mid-read,
// and it's invisible to keyboard and touch users entirely.
//
// Positioned `fixed` off the trigger's bounding rect and rendered through a portal to <body>.
// Every table in this app lives inside `overflow-x-auto`, and an absolutely-positioned popover
// inside one is clipped at the scroll container's edge -- which is exactly where the right-hand
// numeric columns that most need explaining happen to sit.

const WIDTH = 320;
const GAP = 8;
const MARGIN = 10; // keep this far clear of the viewport edge

interface Position {
  left: number;
  top: number;
  /** Which side of the trigger we ended up on, so the arrow points the right way. */
  above: boolean;
}

function computePosition(rect: DOMRect, panelHeight: number): Position {
  // Horizontally centred on the trigger, then clamped so a tooltip on a far-right table column
  // slides back into view instead of running off the edge.
  const rawLeft = rect.left + rect.width / 2 - WIDTH / 2;
  const left = Math.min(Math.max(MARGIN, rawLeft), window.innerWidth - WIDTH - MARGIN);

  // Prefer below; flip above when there isn't room, which is the common case for the stat cards
  // and table rows near the bottom of a long page.
  const spaceBelow = window.innerHeight - rect.bottom;
  const above = spaceBelow < panelHeight + GAP + MARGIN && rect.top > panelHeight + GAP + MARGIN;
  const preferred = above ? rect.top - panelHeight - GAP : rect.bottom + GAP;

  // A long explanation (formula + three paragraphs + caveat + source runs ~430px) doesn't fit
  // either side of a trigger sitting mid-screen on a 720px-tall window -- measured live on the
  // Market table's Score header. Neither branch is right, so clamp into the viewport instead of
  // letting it run off the bottom edge: overlapping the trigger by a little beats being unreadable.
  const top = Math.min(Math.max(MARGIN, preferred), window.innerHeight - panelHeight - MARGIN);
  return { left, top, above };
}

export function InfoTip({
  id,
  explanation,
  label,
  children,
  className = "",
}: {
  /** Key into the shared registry -- the normal way to use this. */
  id?: ExplanationId;
  /** One-off explanation for something genuinely local to a single screen. */
  explanation?: Explanation;
  /** Accessible name, defaults to the explanation's title. */
  label?: string;
  /** Custom trigger. Omit for the default small circled "i". */
  children?: ReactNode;
  className?: string;
}) {
  const content = explanation ?? (id ? EXPLANATIONS[id] : undefined);
  const triggerRef = useRef<HTMLSpanElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<Position | null>(null);

  const place = useCallback(() => {
    const el = triggerRef.current;
    if (!el) return;
    // Measure the panel if it's already mounted; otherwise assume a typical height for the first
    // frame and correct on the next one, so the flip-above decision is made against a real
    // height rather than a guess that could put a tall tooltip half off-screen.
    const height = panelRef.current?.offsetHeight ?? 220;
    setPos(computePosition(el.getBoundingClientRect(), height));
  }, []);

  useEffect(() => {
    if (!open) return;
    place();
    // Scrolling or resizing moves the trigger out from under a `fixed` panel, so close rather
    // than chase it -- re-measuring on every scroll frame inside a virtualised table is worse.
    const dismiss = () => setOpen(false);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("scroll", dismiss, true);
    window.addEventListener("resize", dismiss);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("scroll", dismiss, true);
      window.removeEventListener("resize", dismiss);
      window.removeEventListener("keydown", onKey);
    };
  }, [open, place]);

  // Second pass once the panel has a real measured height.
  useEffect(() => {
    if (open && panelRef.current) place();
  }, [open, place]);

  if (!content) return null;

  const name = label ?? content.title;

  return (
    <>
      <span
        ref={triggerRef}
        role="button"
        tabIndex={0}
        aria-label={`Explain: ${name}`}
        aria-expanded={open}
        className={`inline-flex align-middle cursor-help ${className}`}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        // Touch has no hover: tap toggles. stopPropagation so tapping the marker inside a
        // clickable table row doesn't also open the item modal behind it.
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            setOpen((v) => !v);
          }
        }}
      >
        {children ?? (
          <span className="w-3.5 h-3.5 rounded-full border border-white/25 text-[9px] leading-[13px] text-center text-gray-400 font-semibold select-none hover:border-violet-400/60 hover:text-violet-300 transition-colors">
            i
          </span>
        )}
      </span>

      {open &&
        createPortal(
          <div
            ref={panelRef}
            role="tooltip"
            style={{
              position: "fixed",
              left: `${pos?.left ?? 0}px`,
              top: `${pos?.top ?? 0}px`,
              width: `${WIDTH}px`,
              // Backstop for a very short window: the clamp above keeps the panel on screen only
              // while it's shorter than the viewport.
              maxHeight: `calc(100vh - ${MARGIN * 2}px)`,
              overflowY: "auto",
              // Hidden until placed, so it never flashes at 0,0 on the first frame.
              visibility: pos ? "visible" : "hidden",
            }}
            className="z-[100] rounded-xl border border-white/12 bg-[#12131a]/95 backdrop-blur-xl shadow-2xl shadow-black/60 px-3.5 py-3 text-left pointer-events-none"
          >
            <div className="text-[11px] font-semibold uppercase tracking-wider text-violet-300">
              {content.title}
            </div>

            {content.formula && (
              <pre className="mt-2 rounded-lg bg-black/40 border border-white/8 px-2.5 py-2 font-mono text-[10.5px] leading-relaxed text-sky-200 whitespace-pre-wrap break-words">
                {content.formula}
              </pre>
            )}

            {content.body.map((p) => (
              <p key={p} className="mt-2 text-[11.5px] leading-relaxed text-gray-300">
                {p}
              </p>
            ))}

            {content.caveat && (
              <p className="mt-2.5 pl-2 border-l-2 border-amber-400/50 text-[11px] leading-relaxed text-amber-200/90">
                {content.caveat}
              </p>
            )}

            {content.source && (
              <div className="mt-2.5 pt-2 border-t border-white/8 font-mono text-[9.5px] text-gray-600 break-words">
                {content.source}
              </div>
            )}
          </div>,
          document.body,
        )}
    </>
  );
}

// Convenience for the extremely common "label text followed by an info marker" pairing, so
// callers don't repeat the flex wrapper on every stat and column header.
export function LabelWithInfo({
  children,
  id,
  explanation,
  className = "",
}: {
  children: ReactNode;
  id?: ExplanationId;
  explanation?: Explanation;
  className?: string;
}) {
  return (
    <span className={`inline-flex items-center gap-1 ${className}`}>
      {children}
      <InfoTip id={id} explanation={explanation} />
    </span>
  );
}
