import { useEffect, useState } from "preact/hooks";
import { subscribeToasts, type ToastMessage } from "../toast";

const TONE_CLASSES: Record<ToastMessage["tone"], string> = {
  neutral: "border-white/10 text-gray-100",
  danger: "border-rose-500/30 text-rose-200",
  success: "border-emerald-500/30 text-emerald-200",
};

// Mounted once at the app root; anything can push a message via showToast() without prop-drilling
// a callback down through every table/tab that might want to confirm a click did something.
export function ToastHost() {
  const [toasts, setToasts] = useState<ToastMessage[]>([]);

  useEffect(() => subscribeToasts(setToasts), []);

  if (toasts.length === 0) return null;

  return (
    <div className="fixed bottom-5 right-5 z-50 flex flex-col gap-2 pointer-events-none">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={`glass rounded-lg px-3.5 py-2 text-sm font-medium shadow-lg animate-toast-in ${TONE_CLASSES[t.tone]}`}
        >
          {t.text}
        </div>
      ))}
    </div>
  );
}
