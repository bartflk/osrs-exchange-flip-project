// Minimal pub/sub toast queue -- no external dep, just enough for a "your click did something"
// confirmation (e.g. blocking an item) since actions like that have no other visible feedback
// once the row's icon color updates.
export interface ToastMessage {
  id: number;
  text: string;
  tone: "neutral" | "danger" | "success";
}

type Listener = (toasts: ToastMessage[]) => void;

let toasts: ToastMessage[] = [];
let nextId = 1;
const listeners = new Set<Listener>();

function emit() {
  for (const l of listeners) l([...toasts]);
}

export function subscribeToasts(listener: Listener): () => void {
  listeners.add(listener);
  listener([...toasts]);
  return () => listeners.delete(listener);
}

export function showToast(text: string, tone: ToastMessage["tone"] = "neutral", durationMs = 2200) {
  const id = nextId++;
  toasts = [...toasts, { id, text, tone }];
  emit();
  setTimeout(() => {
    toasts = toasts.filter((t) => t.id !== id);
    emit();
  }, durationMs);
}
