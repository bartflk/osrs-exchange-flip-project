export function formatGp(value: number | null | undefined): string {
  if (value == null) return "—";
  const sign = value < 0 ? "-" : "";
  const abs = Math.abs(value);
  if (abs >= 1_000_000_000) return `${sign}${(abs / 1_000_000_000).toFixed(2)}b`;
  if (abs >= 1_000_000) return `${sign}${(abs / 1_000_000).toFixed(2)}m`;
  if (abs >= 1_000) return `${sign}${(abs / 1_000).toFixed(1)}k`;
  return `${sign}${Math.round(abs)}`;
}

// Compact shorthand for an *input* field (10000000 -> "10m", 15500000 -> "15.5m") -- unlike
// formatGp (always 2 decimals, for read-only display), this trims trailing zeros so re-typing
// what's already on screen doesn't fight the field ("10.00m" back to "10m" on blur would be
// annoying to edit around).
export function formatGpCompact(value: number): string {
  if (value === 0) return "0";
  const sign = value < 0 ? "-" : "";
  const abs = Math.abs(value);
  const trim = (n: number) => n.toFixed(2).replace(/\.?0+$/, "");
  if (abs >= 1_000_000_000) return `${sign}${trim(abs / 1_000_000_000)}b`;
  if (abs >= 1_000_000) return `${sign}${trim(abs / 1_000_000)}m`;
  if (abs >= 1_000) return `${sign}${trim(abs / 1_000)}k`;
  return `${sign}${Math.round(abs)}`;
}

// Parses OSRS-style shorthand ("10m", "500k", "1.5b", plain "43254231", with optional commas)
// back into a raw gp number. Returns null for unparseable/empty input so callers can decide
// whether to keep the user's in-progress text rather than guessing.
export function parseGpShorthand(input: string): number | null {
  const trimmed = input.trim().toLowerCase().replace(/,/g, "");
  if (trimmed === "" || trimmed === "-" || trimmed === ".") return null;
  const match = trimmed.match(/^(-?\d*\.?\d+)([kmb])?$/);
  if (!match) return null;
  const num = Number(match[1]);
  if (!Number.isFinite(num)) return null;
  const mult = match[2] === "k" ? 1_000 : match[2] === "m" ? 1_000_000 : match[2] === "b" ? 1_000_000_000 : 1;
  return Math.round(num * mult);
}

// Exact gp value with thousands separators (e.g. "43,254,231") -- formatGp's "43.25m" is fine
// for scanning a dense table, but rounds off enough real gp to matter when you're about to
// actually place that buy/sell order on the GE.
export function formatGpFull(value: number | null | undefined): string {
  if (value == null) return "—";
  return `${Math.round(value).toLocaleString()}gp`;
}

export function formatPct(value: number | null | undefined): string {
  if (value == null) return "—";
  return `${(value * 100).toFixed(2)}%`;
}

export function formatAgo(unixSeconds: number | null | undefined): string {
  if (!unixSeconds) return "—";
  const diffMs = Date.now() - unixSeconds * 1000;
  const diffSec = Math.floor(diffMs / 1000);
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  return `${diffHr}h ago`;
}
