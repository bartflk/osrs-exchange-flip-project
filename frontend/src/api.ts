export interface MarketItem {
  id: number;
  name: string;
  members: number;
  buy_limit: number | null;
  icon: string;
  high: number | null;
  low: number | null;
  // Nullable, not just 0-or-positive: /api/lookup (used by GlobalSearch, and item detail
  // opened from a lookup result) LEFT JOINs latest_snapshot, so items with no recent trade
  // data come back with these genuinely null -- found live via a real crash opening
  // "Corrupted twisted bow" (a rarely-traded item) in the item detail modal, see ItemDetailModal.tsx.
  vol_high_5m: number | null;
  vol_low_5m: number | null;
  vol_high_1h: number | null;
  vol_low_1h: number | null;
  updated_at: number | null;
  net_margin: number | null;
  roi_pct: number | null;
  liquidity: number;
  limit_adjusted_profit: number | null;
  score: number;
  tax: number | null;
}

export interface ItemsResponse {
  count: number;
  items: MarketItem[];
}

export async function fetchItems(
  params: { minVolume?: number; search?: string; ids?: number[]; membersOnly?: boolean } = {},
): Promise<ItemsResponse> {
  const qs = new URLSearchParams();
  if (params.minVolume) qs.set("minVolume", String(params.minVolume));
  if (params.search) qs.set("search", params.search);
  if (params.ids && params.ids.length) qs.set("ids", params.ids.join(","));
  if (params.membersOnly === false) qs.set("membersOnly", "false");
  const res = await fetch(`/api/items?${qs.toString()}`);
  if (!res.ok) throw new Error(`Failed to fetch items: ${res.status}`);
  return res.json();
}

export interface StatusResponse {
  itemCount: number;
  lastUpdate: number | null;
}

export async function fetchStatus(): Promise<StatusResponse> {
  const res = await fetch("/api/status");
  if (!res.ok) throw new Error(`Failed to fetch status: ${res.status}`);
  return res.json();
}

export type Lookback = "6h" | "24h" | "7d" | "30d" | "6m" | "1y" | "all";

export interface TimeseriesPoint {
  timestamp: number;
  avgHighPrice: number | null;
  avgLowPrice: number | null;
  highPriceVolume: number;
  lowPriceVolume: number;
}

export interface TimeseriesResponse {
  itemId: number;
  lookback: Lookback;
  points: TimeseriesPoint[];
  // true for lookback=all: sourced from weirdgloop's long-range history (back to the item's
  // GE release), which only ever tracked one blended daily price, not a real buy/sell spread --
  // avgHighPrice and avgLowPrice will be equal for every point. The chart renders this as a
  // single line instead of pretending there's a spread.
  blended?: boolean;
}

export async function fetchTimeseries(
  itemId: number,
  lookback: Lookback,
): Promise<TimeseriesResponse> {
  const res = await fetch(`/api/items/${itemId}/timeseries?lookback=${lookback}`);
  if (!res.ok) throw new Error(`Failed to fetch timeseries: ${res.status}`);
  return res.json();
}

export async function lookupItems(q: string): Promise<{ items: MarketItem[] }> {
  if (q.trim().length < 2) return { items: [] };
  const res = await fetch(`/api/lookup?q=${encodeURIComponent(q)}`);
  if (!res.ok) throw new Error(`Failed to look up items: ${res.status}`);
  return res.json();
}

export interface BankValueItem {
  id: number;
  name: string;
  icon: string;
  qty: number;
  unitValue: number;
  value: number;
  // Tax-adjusted (2% GE tax, capped at 5m/item, waived under 50gp): what you'd actually
  // walk away with if you instant-sold this stack right now.
  netUnitValue: number;
  netValue: number;
  priced: boolean;
  estimated?: boolean;
  note?: string;
  highAlch: number | null;
  highAlchValue: number | null;
}

export interface BankValueResponse {
  totalValue: number;
  totalNetValue: number;
  items: BankValueItem[];
}

export async function postBankValue(
  entries: { id: number; qty: number; name?: string }[],
): Promise<BankValueResponse> {
  const res = await fetch("/api/bank/value", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ entries }),
  });
  if (!res.ok) throw new Error(`Failed to value bank: ${res.status}`);
  return res.json();
}

export interface BankImportResponse extends BankValueResponse {
  importId: number;
  importedAt: number;
}

export async function saveBankImport(
  entries: { id: number; qty: number; name?: string }[],
): Promise<BankImportResponse> {
  const res = await fetch("/api/bank/import", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ entries }),
  });
  if (!res.ok) throw new Error(`Failed to save bank import: ${res.status}`);
  return res.json();
}

export interface BankImportSummary {
  id: number;
  imported_at: number;
  total_value: number;
  item_count: number;
}

export async function listBankImports(): Promise<{ imports: BankImportSummary[] }> {
  const res = await fetch("/api/bank/imports");
  if (!res.ok) throw new Error(`Failed to list bank imports: ${res.status}`);
  return res.json();
}

export async function getBankImport(id: number): Promise<BankImportResponse> {
  const res = await fetch(`/api/bank/imports/${id}`);
  if (!res.ok) throw new Error(`Failed to load bank import: ${res.status}`);
  return res.json();
}

export async function deleteBankImport(id: number): Promise<void> {
  const res = await fetch(`/api/bank/imports/${id}`, { method: "DELETE" });
  if (!res.ok) throw new Error(`Failed to delete bank import: ${res.status}`);
}

// DESIGN.md §11.3 items 5-6 -- market-wide crash/spike detection (kind: "price") and
// manipulation/bot-activity volume anomaly detection (kind: "volume"), not just Watchlist-pinned
// items, and not just price moves.
export type AlertDirection = "crash" | "spike";
export type AlertKind = "price" | "volume";
export type AlertSeverity = "notable" | "major";

export interface PriceAlert {
  id: string;
  itemId: number;
  name: string;
  icon: string;
  kind: AlertKind;
  direction: AlertDirection;
  severity: AlertSeverity;
  changePct: number;
  fromPrice: number;
  toPrice: number;
  windowMinutes: number;
  triggeredAt: number;
  zScore?: number;
}

export async function fetchAlerts(): Promise<{ alerts: PriceAlert[] }> {
  const res = await fetch("/api/alerts");
  if (!res.ok) throw new Error(`Failed to fetch alerts: ${res.status}`);
  return res.json();
}

// DESIGN.md §10 item 1 -- recommendation scorekeeping: the app logs its own top Buy Signals
// periodically and checks back 4h later against real prices, so "is this thing actually good"
// has an answer beyond gut feel.
export interface TrackRecordSummary {
  resolvedCount: number;
  pendingCount: number;
  wins: number;
  losses: number;
  winRate: number | null;
  avgNetMargin: number | null;
  avgRoiPct: number | null;
}

export type TrackRecordOutcome = "win" | "loss" | "flat" | null;

export interface TrackRecordEntry {
  id: number;
  itemId: number;
  name: string;
  icon: string;
  takenAt: number;
  rank: number;
  score: number;
  buyPrice: number;
  sellPrice: number;
  netMargin: number;
  roiPct: number;
  resolveAt: number;
  resolvedAt: number | null;
  resolvedHigh: number | null;
  realizedNetMargin: number | null;
  realizedRoiPct: number | null;
  outcome: TrackRecordOutcome;
}

export async function fetchTrackRecord(): Promise<{
  summary: TrackRecordSummary;
  recent: TrackRecordEntry[];
}> {
  const res = await fetch("/api/track-record");
  if (!res.ok) throw new Error(`Failed to fetch track record: ${res.status}`);
  return res.json();
}

// DESIGN.md §6.4 -- official OSRS news feed. Reddit sentiment and Claude's item-linking aren't
// wired in yet (Reddit needs app pre-approval, Claude is blocked on Anthropic API billing --
// §14.8), so every entry is currently source: "official" with no item tags.
export interface NewsEvent {
  id: number;
  eventDate: string;
  title: string;
  summary: string;
  source: string;
  link: string | null;
  tags: string | null;
}

export async function fetchNews(): Promise<{ events: NewsEvent[] }> {
  const res = await fetch("/api/news");
  if (!res.ok) throw new Error(`Failed to fetch news: ${res.status}`);
  return res.json();
}

// DESIGN.md §10 items 15-16: Set Conversion Arbitrage and Barrows Repair Flip -- fully
// deterministic against data already local, no new external source.
export interface SetArbitrageResult {
  setName: string;
  pieceNames: string[];
  setBuy: number;
  setSell: number;
  pieceCost: number;
  pieceRevenue: number;
  combineProfit: number;
  decombineProfit: number;
  bestDirection: "combine" | "decombine";
  bestProfit: number;
}

export async function fetchSetArbitrage(): Promise<{ sets: SetArbitrageResult[] }> {
  const res = await fetch("/api/sets/arbitrage");
  if (!res.ok) throw new Error(`Failed to fetch set arbitrage: ${res.status}`);
  return res.json();
}

export interface BarrowsRepairResult {
  degradedName: string;
  repairedName: string;
  degradedBuy: number;
  repairCost: number;
  repairedSell: number;
  profit: number;
}

export async function fetchBarrowsRepair(): Promise<{ flips: BarrowsRepairResult[] }> {
  const res = await fetch("/api/sets/barrows-repair");
  if (!res.ok) throw new Error(`Failed to fetch barrows repair flips: ${res.status}`);
  return res.json();
}
