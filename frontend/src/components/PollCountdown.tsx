import { useEffect, useState } from "preact/hooks";

// The "data in 12s" countdown, owning its own clock.
//
// This was a `nowTick` state variable in App, updated by a setInterval once a second. Preact does
// not memoize anything, so every one of those ticks re-rendered the ENTIRE app: the header, the
// filter bar, and the market table with its 1,100 rows, each row carrying three tooltip components
// and a sparkline whose path is rebuilt from scratch. Sixty full renders of that tree per minute.
//
// Measured in the live page, that allocated about 20MB a second. The tab climbed from 274MB to
// over 3GB in four minutes and Chrome killed it at the 4.2GB heap limit, which is the
// out-of-memory report this fixes. It is not a leak in the usual sense: nothing was being retained
// forever, the collector simply never got far enough ahead of a tree being rebuilt every second.
//
// Pulling the clock into its own component means a tick re-renders one <span> instead of the
// application. Everything else on this page changes on the poll cycle, which is measured in tens
// of seconds, not on a wall clock.

export function PollCountdown({ nextPollAt }: { nextPollAt: number | null }) {
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    if (nextPollAt == null) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [nextPollAt]);

  if (nextPollAt == null) return null;
  const seconds = Math.max(0, Math.round((nextPollAt - now) / 1000));

  return (
    <>
      <span className="text-gray-600">·</span>
      <span title="Time until the backend's next real 60s Wiki API poll">data in {seconds}s</span>
    </>
  );
}
