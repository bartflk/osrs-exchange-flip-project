// DESIGN.md §14.44: small shared statistics helpers.

/**
 * Median of a sample, or null if empty.
 *
 * Used instead of the mean everywhere time-of-day deviations are aggregated, because a single
 * bad print destroys a mean and the OSRS price feed has plenty of them. Found live: Sandworms
 * printed 419gp at 19:00 on one day against a day-mean of 117 (a thin trade, or someone dumping),
 * giving that slot a +259% deviation. Across seven days that one reading pulled the MEAN to
 * +37.1% while the MEDIAN was +0.59% -- and it made Sandworms the single highest-scoring
 * "best item to buy" in the whole app, on the strength of one tick.
 *
 * The mean is the obvious choice here and it is the wrong one. Prices are heavy-tailed; the
 * median is what makes "this is a repeating daily pattern" mean anything.
 */
export function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

export function mean(values: number[]): number | null {
  if (!values.length) return null;
  return values.reduce((s, v) => s + v, 0) / values.length;
}
