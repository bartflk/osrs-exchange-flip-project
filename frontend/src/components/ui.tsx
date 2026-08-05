import { useEffect, useState } from "preact/hooks";
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from "preact/compat";

// Shared visual language for the app: consistent buttons, badges, inputs, and chips so every
// tab reads as one product instead of each screen inventing its own control style.

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
type ButtonSize = "sm" | "md";

const VARIANT_CLASSES: Record<ButtonVariant, string> = {
  primary:
    "bg-sky-500/90 text-white hover:bg-sky-400 border border-sky-400/50 shadow-sm shadow-sky-500/20",
  secondary: "bg-white/10 text-gray-100 hover:bg-white/15 border border-white/10",
  ghost:
    "bg-transparent text-gray-400 hover:text-gray-100 hover:bg-white/5 border border-transparent",
  danger: "bg-rose-500/10 text-rose-300 hover:bg-rose-500/20 border border-rose-500/30",
};

const SIZE_CLASSES: Record<ButtonSize, string> = {
  sm: "px-2.5 py-1 text-xs gap-1.5",
  md: "px-3.5 py-2 text-sm gap-2",
};

export function Button({
  variant = "secondary",
  size = "md",
  active,
  className = "",
  children,
  ...rest
}: {
  variant?: ButtonVariant;
  size?: ButtonSize;
  active?: boolean;
} & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      className={`inline-flex items-center justify-center rounded-lg font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${SIZE_CLASSES[size]} ${
        active ? VARIANT_CLASSES.primary : VARIANT_CLASSES[variant]
      } ${className}`}
      {...rest}
    >
      {children}
    </button>
  );
}

export function IconButton({
  active,
  className = "",
  children,
  ...rest
}: { active?: boolean } & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      className={`w-8 h-8 flex items-center justify-center rounded-lg text-base leading-none transition-colors ${
        active ? "bg-white/10 text-white" : "text-gray-400 hover:text-white hover:bg-white/5"
      } ${className}`}
      {...rest}
    >
      {children}
    </button>
  );
}

type BadgeTone = "neutral" | "success" | "danger" | "warning" | "info";

const TONE_CLASSES: Record<BadgeTone, string> = {
  neutral: "bg-white/8 text-gray-300 border-white/10",
  success: "bg-emerald-500/10 text-emerald-300 border-emerald-500/30",
  danger: "bg-rose-500/10 text-rose-300 border-rose-500/30",
  warning: "bg-amber-500/10 text-amber-300 border-amber-500/30",
  info: "bg-sky-500/10 text-sky-300 border-sky-500/30",
};

export function Badge({
  tone = "neutral",
  children,
  className = "",
}: {
  tone?: BadgeTone;
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md border text-[10px] font-medium uppercase tracking-wide leading-none ${TONE_CLASSES[tone]} ${className}`}
    >
      {children}
    </span>
  );
}

export function Input({ className = "", ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={`glass rounded-lg px-3 py-2 text-sm text-gray-100 placeholder:text-gray-500 outline-none focus:border-sky-400/40 focus:ring-1 focus:ring-sky-400/30 transition-colors ${className}`}
      {...rest}
    />
  );
}

// Plain <input type="number" value={n} onChange={e => setN(Number(e.target.value) || 0)}> forces
// the field to "0" the instant it's cleared (Number("") is 0), so you can never backspace and
// retype -- the "0" reappears before the next keystroke lands. This keeps its own draft text
// while focused and only commits (and resyncs from outside changes, e.g. a "clear filters"
// button) once the draft is a real number again.
export function NumberInput({
  value,
  onChange,
  className = "",
  ...rest
}: {
  value: number;
  onChange: (value: number) => void;
} & Omit<InputHTMLAttributes<HTMLInputElement>, "value" | "onChange" | "type">) {
  const [text, setText] = useState(String(value));

  useEffect(() => {
    setText((prev) => (Number(prev) === value ? prev : String(value)));
  }, [value]);

  return (
    <Input
      type="text"
      inputMode="numeric"
      value={text}
      onChange={(e) => {
        const raw = e.target.value;
        if (!/^-?\d*$/.test(raw)) return;
        setText(raw);
        if (raw !== "" && raw !== "-") onChange(Number(raw));
      }}
      onBlur={() => {
        if (text === "" || text === "-") {
          setText(String(value));
        }
      }}
      className={className}
      {...rest}
    />
  );
}

export function Chip({
  active,
  onClick,
  children,
  className = "",
}: {
  active?: boolean;
  onClick?: () => void;
  children: ReactNode;
  className?: string;
}) {
  return (
    <button
      onClick={onClick}
      className={`px-2.5 py-1 rounded-full text-xs font-medium border transition-colors ${
        active
          ? "bg-sky-500/15 border-sky-400/40 text-sky-300"
          : "bg-white/5 border-white/10 text-gray-400 hover:bg-white/10 hover:text-gray-200"
      } ${className}`}
    >
      {children}
    </button>
  );
}

export function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <span className="text-[10px] uppercase tracking-wider text-gray-500 font-medium">
      {children}
    </span>
  );
}

export function EmptyState({ icon, title, hint }: { icon?: string; title: string; hint?: string }) {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-center gap-1">
      {icon && <div className="text-3xl mb-2 opacity-50">{icon}</div>}
      <div className="text-sm text-gray-300 font-medium">{title}</div>
      {hint && <div className="text-xs text-gray-500 max-w-sm">{hint}</div>}
    </div>
  );
}

export function StatCard({
  label,
  value,
  tone = "neutral",
  hint,
}: {
  label: string;
  value: string;
  tone?: "neutral" | "success" | "danger";
  hint?: string;
}) {
  const valueClass =
    tone === "success" ? "text-emerald-400" : tone === "danger" ? "text-rose-400" : "text-white";
  return (
    <div className="glass rounded-xl px-4 py-3">
      <div className="text-[10px] uppercase tracking-wider text-gray-500 font-medium">{label}</div>
      <div className={`font-mono text-lg font-semibold mt-0.5 ${valueClass}`}>{value}</div>
      {hint && <div className="text-[11px] text-gray-500 mt-0.5">{hint}</div>}
    </div>
  );
}
