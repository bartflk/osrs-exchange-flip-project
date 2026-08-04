export interface MarketItem {
  id: number;
  name: string;
  members: number;
  buy_limit: number | null;
  icon: string;
  high: number | null;
  low: number | null;
  vol_high_5m: number;
  vol_low_5m: number;
  vol_high_1h: number;
  vol_low_1h: number;
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
  params: { minVolume?: number; search?: string; ids?: number[] } = {}
): Promise<ItemsResponse> {
  const qs = new URLSearchParams();
  if (params.minVolume) qs.set("minVolume", String(params.minVolume));
  if (params.search) qs.set("search", params.search);
  if (params.ids && params.ids.length) qs.set("ids", params.ids.join(","));
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

export async function fetchTimeseries(itemId: number, lookback: Lookback): Promise<TimeseriesResponse> {
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
  // Tax-adjusted (1% GE tax, capped at 5m/item, waived under 100gp): what you'd actually
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
  entries: { id: number; qty: number; name?: string }[]
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
  entries: { id: number; qty: number; name?: string }[]
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
