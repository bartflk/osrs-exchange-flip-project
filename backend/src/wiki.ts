const BASE = "https://prices.runescape.wiki/api/v2/osrs";
const USER_AGENT = "osrs-flip-assistant/0.1 (local prototype; contact: bartekfilik@gmail.com)";

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { "User-Agent": USER_AGENT },
  });
  if (!res.ok) {
    throw new Error(`Wiki API ${path} failed: ${res.status} ${res.statusText}`);
  }
  return res.json() as Promise<T>;
}

export interface ItemMapping {
  id: number;
  name: string;
  examine: string;
  members: boolean;
  lowalch?: number;
  highalch?: number;
  limit?: number;
  value: number;
  icon: string;
}

export interface LatestEntry {
  high: number | null;
  highTime: number | null;
  low: number | null;
  lowTime: number | null;
}

export interface WindowEntry {
  avgHighPrice: number | null;
  highPriceVolume: number;
  avgLowPrice: number | null;
  lowPriceVolume: number;
}

export async function fetchMapping(): Promise<ItemMapping[]> {
  return get<ItemMapping[]>("/mapping");
}

export async function fetchLatest(): Promise<Record<string, LatestEntry>> {
  const data = await get<{ data: Record<string, LatestEntry> }>("/latest");
  return data.data;
}

export async function fetchWindow(step: "5m" | "1h"): Promise<Record<string, WindowEntry>> {
  const data = await get<{ data: Record<string, WindowEntry> }>(`/${step}`);
  return data.data;
}

export interface TimeseriesPoint {
  timestamp: number;
  avgHighPrice: number | null;
  avgLowPrice: number | null;
  highPriceVolume: number;
  lowPriceVolume: number;
}

export type Lookback = "6h" | "24h" | "7d" | "30d" | "6m" | "1y" | "all";

export async function fetchTimeseries(
  itemId: number,
  lookback: Lookback,
): Promise<TimeseriesPoint[]> {
  // Note: the actual granularity ("timestep") returned for a given lookback is chosen by
  // the API server and isn't guaranteed/selectable -- only `lookback` is a valid param.
  const data = await get<{ data: TimeseriesPoint[] }>(
    `/timeseries?id=${itemId}&lookback=${lookback}`,
  );
  return data.data;
}

// DESIGN.md §14.43: granularity actually returned per lookback, probed live against v2 so the
// time-of-day analysis (tradingHours.ts) had a verified basis rather than an assumed one:
//
//   lookback=24h -> 288 points,  5min step, 24/24 hours of day, but only ~2 calendar days
//   lookback=7d  -> 168 points, 60min step, 24/24 hours of day, 7 calendar days   <- hourly work
//   lookback=30d -> 120 points,  6h  step,  4/24 hours of day                      <- unusable
//
// So 7d is the only *v2 lookback* that gives full hour-of-day coverage over multiple days.
//
// v1 exposes a `timestep` parameter instead, and the two versions reject each other's params
// (`timestep` on v2 -> HTTP 400, `lookback` on v1 -> HTTP 400). v1's timesteps, also probed live:
//
//   timestep=5m  -> 365 points,  5min step, 1.3 days
//   timestep=30m -> 365 points, 30min step, 7.6 days   <- finest resolution available over a week
//   timestep=1h  -> 365 points, 60min step, 15.2 days
//   timestep=15m -> HTTP 400, not a valid timestep
//
// Every request is capped at 365 points whichever version you use, so there is no way to get four
// weeks at 30-minute resolution from this API at all -- longer coverage can only be accumulated
// locally over time (see item_slot_profile in db.ts).
//
// This matters because local price_history CANNOT answer "what time of day is this cheapest":
// the backend only records while it's running, so its hour coverage reflects when the app was
// open, not the market. Measured on this install: 10 of 24 hours, identically for every item --
// the tell that it's an artefact of uptime rather than anything about the items.
const V1_BASE = "https://prices.runescape.wiki/api/v1/osrs";

export type Timestep = "5m" | "30m" | "1h" | "6h" | "24h";

export async function fetchTimeseriesByStep(
  itemId: number,
  timestep: Timestep,
): Promise<TimeseriesPoint[]> {
  const res = await fetch(`${V1_BASE}/timeseries?id=${itemId}&timestep=${timestep}`, {
    headers: { "User-Agent": USER_AGENT },
  });
  if (!res.ok) {
    throw new Error(`Wiki v1 timeseries (${itemId}, ${timestep}) failed: ${res.status}`);
  }
  const json = (await res.json()) as { data: TimeseriesPoint[] };
  return json.data ?? [];
}

// weirdgloop (run by the OSRS Wiki team, same operators as the Real-time Prices API above)
// keeps the *full* GE price history back to each item's release, daily granularity -- this is
// the only source for anything beyond the Real-time Prices API's confirmed 1y cap (probed
// directly: lookback=5y and lookback=all on /timeseries both 400 with "lookback must be a
// valid value"). It only ever tracked one blended daily price though, no buy/sell split, and
// volume tracking only starts partway through the series (null before RuneLite-sourced data
// began) -- both reflected in the return type below.
const WEIRDGLOOP_BASE = "https://api.weirdgloop.org/exchange/history/osrs";

interface WeirdglooPoint {
  id: string;
  price: number;
  volume: number | null;
  timestamp: number; // ms
}

export interface LongRangePoint {
  timestamp: number; // seconds, to match TimeseriesPoint's convention
  price: number;
  volume: number | null;
}

export async function fetchAllTimeHistory(itemId: number): Promise<LongRangePoint[]> {
  const res = await fetch(`${WEIRDGLOOP_BASE}/all?id=${itemId}`, {
    headers: { "User-Agent": USER_AGENT },
  });
  if (!res.ok) {
    throw new Error(`weirdgloop history fetch failed: ${res.status} ${res.statusText}`);
  }
  const data = (await res.json()) as Record<string, WeirdglooPoint[]>;
  const points = data[String(itemId)] ?? [];
  return points.map((p) => ({
    timestamp: Math.round(p.timestamp / 1000),
    price: p.price,
    volume: p.volume,
  }));
}
