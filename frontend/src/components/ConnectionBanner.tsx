import { useEffect, useRef, useState } from "preact/hooks";

// Says out loud when the backend stops answering, instead of leaving the page quietly stale.
//
// Audit finding, from "the application is disconnecting and i have to constantly refresh". When a
// poll failed, the only sign was one line of small red text tucked above the table, and the data
// on screen carried on looking exactly like live data. There is no way to tell a page that is a
// second old from one that is an hour old by looking at it, so the natural move is to refresh, and
// refreshing is what made it feel like a connection problem rather than a stale one.
//
// Three things this adds. It POLLS INDEPENDENTLY of the main data load, so it can tell you the
// backend is back even when nothing else is being fetched. It distinguishes a RESTARTED backend
// from an unreachable one, using the startedAt the status route now returns, because those mean
// different things: a restart means your data is fine and about to reload, unreachable means the
// server is gone. And it RECOVERS ON ITS OWN, so the refresh you used to have to do by hand
// happens without you.

type State =
  | { kind: "ok" }
  | { kind: "down"; since: number; attempts: number }
  | { kind: "restarted" };

const PROBE_MS = 5000;

export function ConnectionBanner({ onReconnect }: { onReconnect: () => void }) {
  const [state, setState] = useState<State>({ kind: "ok" });
  // Held in a ref, not read from props inside the effect. The caller passes a function defined in
  // its own render body, so its identity changes every render; depending on it would tear down and
  // restart this probe loop on every render of the app, which is a busy-loop rather than a poll.
  const onReconnectRef = useRef(onReconnect);
  onReconnectRef.current = onReconnect;
  const startedAtRef = useRef<number | null>(null);
  const failuresRef = useRef(0);
  const downSinceRef = useRef(0);

  useEffect(() => {
    let cancelled = false;
    let timer: number;

    async function probe() {
      try {
        // no-store, or a probe can be answered from cache and report a server that is not there.
        const res = await fetch("/api/status", { cache: "no-store" });
        if (!res.ok) throw new Error(String(res.status));
        const body = (await res.json()) as { startedAt?: number };
        if (cancelled) return;

        const wasDown = failuresRef.current > 0;
        failuresRef.current = 0;

        const seen = startedAtRef.current;
        if (body.startedAt != null && seen != null && body.startedAt !== seen) {
          startedAtRef.current = body.startedAt;
          setState({ kind: "restarted" });
          onReconnectRef.current();
          // The restart notice is information, not a problem, so it clears itself.
          window.setTimeout(() => !cancelled && setState({ kind: "ok" }), 4000);
        } else {
          if (body.startedAt != null) startedAtRef.current = body.startedAt;
          if (wasDown) {
            setState({ kind: "ok" });
            onReconnectRef.current();
          } else {
            setState({ kind: "ok" });
          }
        }
      } catch {
        if (cancelled) return;
        // One failed probe is a hiccup, not an outage. Two in a row, ten seconds apart, is real.
        failuresRef.current += 1;
        if (failuresRef.current === 1) downSinceRef.current = Date.now();
        if (failuresRef.current >= 2) {
          setState({ kind: "down", since: downSinceRef.current, attempts: failuresRef.current });
        }
      } finally {
        if (!cancelled) timer = window.setTimeout(probe, PROBE_MS);
      }
    }

    probe();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // Deliberately empty: this loop owns its own schedule and must not be restarted by a render.
  }, []);

  if (state.kind === "ok") return null;

  if (state.kind === "restarted") {
    return (
      <div className="px-4 py-2 text-xs bg-sky-500/15 border-b border-sky-400/30 text-sky-200">
        The backend restarted. Reloading your data, no need to refresh.
      </div>
    );
  }

  const seconds = Math.round((Date.now() - state.since) / 1000);
  return (
    <div className="px-4 py-2 text-xs bg-rose-500/15 border-b border-rose-400/40 text-rose-200 flex items-center gap-3 flex-wrap">
      <span className="font-medium">The backend is not answering.</span>
      <span className="text-rose-300/80">
        Been trying for about {seconds < 90 ? `${seconds}s` : `${Math.round(seconds / 60)} min`}.
        Everything on screen is frozen at the last good load, so treat the prices as old.
      </span>
      <span className="text-rose-300/60">
        Retrying every {PROBE_MS / 1000}s, and it will reload itself the moment the server is back.
      </span>
    </div>
  );
}
