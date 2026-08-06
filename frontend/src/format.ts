export function formatGp(value: number | null | undefined): string {
  if (value == null) return "—";
  const sign = value < 0 ? "-" : "";
  const abs = Math.abs(value);
  if (abs >= 1_000_000_000) return `${sign}${(abs / 1_000_000_000).toFixed(2)}b`;
  if (abs >= 1_000_000) return `${sign}${(abs / 1_000_000).toFixed(2)}m`;
  if (abs >= 1_000) return `${sign}${(abs / 1_000).toFixed(1)}k`;
  return `${sign}${Math.round(abs)}`;
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
