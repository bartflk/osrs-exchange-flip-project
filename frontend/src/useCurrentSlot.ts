import { useEffect, useState } from "preact/hooks";
import { currentSlotNow, msUntilNextSlot } from "./timeSlots";

// §14.50: keeps the "now" half-hour slot live.
//
// Scheduled to fire just after each half-hour boundary rather than polling on a fixed interval:
// a 30s poll would show a stale slot for up to 30 seconds after every rollover, and there is
// nothing to check in between -- the value only ever changes at :00 and :30.
export function useCurrentSlot(): number {
  const [slot, setSlot] = useState(currentSlotNow);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    function schedule() {
      timer = setTimeout(() => {
        setSlot(currentSlotNow());
        schedule();
      }, msUntilNextSlot());
    }
    schedule();
    // Waking from sleep or switching back to the tab can skip the timer entirely, so re-sync on
    // visibility change as well.
    function onVisible() {
      if (!document.hidden) setSlot(currentSlotNow());
    }
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  return slot;
}
