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
  // Coefficient of variation of the high price over a trailing 24h -- null until 24h of local
  // history has accumulated for this item (§14.12).
  volatility_pct: number | null;
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
  // DESIGN.md §14.22: real next-scheduled-poll timestamp (unix ms) from the backend's actual
  // 60s Wiki-API poll cycle -- not a frontend guess about when data might refresh.
  nextPricePollAt: number | null;
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

// DESIGN.md §14.22: multi-horizon backtest -- the same logged picks, checked at 2/3/6/12/24h
// hold periods instead of just the fixed 4h resolution above.
export interface HorizonResult {
  hours: number;
  resolvedCount: number;
  pendingCount: number;
  noDataCount: number;
  wins: number;
  losses: number;
  winRate: number | null;
  avgNetMargin: number | null;
  avgRoiPct: number | null;
}

export async function fetchTrackRecordHorizons(): Promise<{ horizons: HorizonResult[] }> {
  const res = await fetch("/api/track-record/horizons");
  if (!res.ok) throw new Error(`Failed to fetch track record horizons: ${res.status}`);
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
export interface PieceBreakdown {
  name: string;
  buy: number;
  sell: number;
  tax: number;
}

export interface SetArbitrageResult {
  setName: string;
  pieceNames: string[];
  setBuy: number;
  setSell: number;
  setTax: number;
  pieceCost: number;
  pieceRevenue: number;
  pieces: PieceBreakdown[];
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

// DESIGN.md §14.12: IQR prediction bands -- deterministic quantile forecast (backend/src/forecast.ts),
// not a trained model. Empty `points` means not enough local history has accumulated yet.
export interface ForecastPoint {
  timestamp: number;
  mid: number;
  low: number;
  high: number;
}

export interface ForecastResponse {
  itemId: number;
  points: ForecastPoint[];
  historicalSamples: number;
}

export async function fetchForecast(itemId: number): Promise<ForecastResponse> {
  const res = await fetch(`/api/items/${itemId}/forecast`);
  if (!res.ok) throw new Error(`Failed to fetch forecast: ${res.status}`);
  return res.json();
}

// DESIGN.md §14.12: per-item slice of the app's own track record -- grounded in real resolved
// recommendations, not a black-box "success rate" badge.
export interface ItemTrackRecord {
  resolvedCount: number;
  wins: number;
  losses: number;
  winRate: number | null;
  avgRealizedNetMargin: number | null;
}

export async function fetchItemTrackRecord(itemId: number): Promise<ItemTrackRecord> {
  const res = await fetch(`/api/items/${itemId}/track-record`);
  if (!res.ok) throw new Error(`Failed to fetch item track record: ${res.status}`);
  return res.json();
}

// DESIGN.md §14.13: Wise Old Man player snapshot -- plumbing for the bankstand/session-planner
// feature (Phase 3, message 8). -1 experience/rank/kills are already normalized to 0 server-side.
export interface PlayerSkillLevel {
  level: number;
  experience: number;
}

export interface PlayerBossKills {
  kills: number;
}

export interface PlayerSnapshot {
  username: string;
  displayName: string;
  type: string;
  combatLevel: number;
  updatedAt: string;
  skills: Record<string, PlayerSkillLevel>;
  bosses: Record<string, PlayerBossKills>;
}

export async function fetchPlayerSnapshot(username: string): Promise<PlayerSnapshot> {
  const res = await fetch(`/api/player/${encodeURIComponent(username)}`);
  if (!res.ok) {
    if (res.status === 404) throw new Error(`Player "${username}" not found on Wise Old Man`);
    throw new Error(`Failed to fetch player: ${res.status}`);
  }
  return res.json();
}

// DESIGN.md §14.28: small standalone LLM connectivity smoke test -- decoupled from item scoring,
// exists purely to confirm the configured provider/model is actually reachable and responding.
export interface LlmHealthResponse {
  ok: boolean;
  baseURL: string;
  model: string;
  latencyMs: number;
  reply?: string;
  error?: string;
}

export async function fetchLlmHealth(): Promise<LlmHealthResponse> {
  const res = await fetch("/api/llm/health");
  if (!res.ok) throw new Error(`Failed to reach LLM health endpoint: ${res.status}`);
  return res.json();
}

// DESIGN.md §10 items 36-45 ("More indicators.txt", §14.34): per-item deterministic indicator
// bundle + an LLM-synthesized conclusion grounded in it, and a whole-catalogue sentiment gauge.
export type BuyPressure = "bullish" | "bearish" | "neutral";
export type MeanReversionSignal = "oversold" | "overbought" | "neutral";
export type SupplyDemandShock = "supply_shock" | "demand_shock" | "none";
export type FlipSaturation = "low" | "moderate" | "high" | "unknown";

export interface IntradayEdge {
  bestBuyHourUtc: number | null;
  bestSellHourUtc: number | null;
  sampleDays: number;
}

export interface IndicatorBundle {
  liquidityScore: number;
  buyPressure: BuyPressure;
  buyPressureRatio: number | null;
  spreadStabilityScore: number | null;
  meanReversionZ: number | null;
  meanReversionSignal: MeanReversionSignal;
  supplyDemandShock: SupplyDemandShock;
  flipSaturation: FlipSaturation;
  intradayEdge: IntradayEdge | null;
  opportunityScore: number;
  sampleSize: number;
}

export async function fetchIndicators(itemId: number): Promise<IndicatorBundle> {
  const res = await fetch(`/api/items/${itemId}/indicators`);
  if (!res.ok) throw new Error(`Failed to fetch indicators: ${res.status}`);
  return res.json();
}

export interface MarketIntelligence {
  conclusion: string;
  confidence: "low" | "medium" | "high";
  indicators: IndicatorBundle;
  cached: boolean;
}

export async function fetchMarketIntelligence(itemId: number): Promise<MarketIntelligence> {
  const res = await fetch(`/api/items/${itemId}/intelligence`);
  if (!res.ok) throw new Error(`Failed to fetch market intelligence: ${res.status}`);
  return res.json();
}

export type MarketTemperatureLabel = "hot" | "warm" | "neutral" | "cool" | "cold";

export interface MarketTemperature {
  label: MarketTemperatureLabel;
  avgChangePct: number;
  gainersCount: number;
  losersCount: number;
  flatCount: number;
  totalCount: number;
  gainerPct: number;
}

export async function fetchMarketTemperature(window: TrendWindow): Promise<MarketTemperature> {
  const res = await fetch(`/api/market-temperature?window=${window}`);
  if (!res.ok) throw new Error(`Failed to fetch market temperature: ${res.status}`);
  return res.json();
}

export interface ExtractedGeOffer {
  type: "buy" | "sell";
  itemName: string;
  price: number;
  qty: number;
  filledQty: number;
  slotIndex: number | null;
}

// `imageDataUrl` is a full "data:image/...;base64,..." string (FileReader.readAsDataURL output)
// -- sent as-is, decoded server-side by the vision model call, never written to disk.
// emptySlotIndexes: slots (1-8) the model saw explicitly labeled "Empty" -- lets the caller tell
// "this slot was freed up" apart from "this screenshot just doesn't show that slot."
export async function extractGeOffersFromScreenshot(
  imageDataUrl: string,
): Promise<{ offers: ExtractedGeOffer[]; emptySlotIndexes: number[] }> {
  const res = await fetch("/api/vision/ge-offers", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ image: imageDataUrl }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.error ?? `Failed to read screenshot: ${res.status}`);
  }
  return res.json();
}

// DESIGN.md §14.15: bankstand/session planner -- activities filtered to what the player's real
// skill levels unlock, with live GP profit where computable from local GE prices.
export type ActivityAttention = "afk" | "moderate" | "active";

export interface SessionPlanEntry {
  name: string;
  skill: string;
  levelRequired: number;
  playerLevel: number;
  attention: ActivityAttention;
  suggestedMinutes: number;
  description: string;
  profitPerUnit: number | null;
}

// DESIGN.md §10 item 29: a goal axis for the planner, honestly scoped to what real data
// supports (attention level + live GP profit) -- "Questing"/"Collection Log" from the original
// brainstorm aren't buildable without a quest/diary/collection-log dataset this app doesn't have.
export type SessionGoal = "afk" | "profit" | "active";

export interface SessionPlanResponse {
  username: string;
  availableMinutes: number;
  goal: SessionGoal;
  plan: SessionPlanEntry[];
}

export async function fetchSessionPlan(
  username: string,
  minutes: number,
  goal: SessionGoal = "afk",
): Promise<SessionPlanResponse> {
  const res = await fetch(
    `/api/session-plan?username=${encodeURIComponent(username)}&minutes=${minutes}&goal=${goal}`,
  );
  if (!res.ok) {
    if (res.status === 404) throw new Error(`Player "${username}" not found on Wise Old Man`);
    throw new Error(`Failed to fetch session plan: ${res.status}`);
  }
  return res.json();
}

// DESIGN.md §10 item 9 / §14.17: multi-window trend leaderboards -- browsable ranked movers,
// distinct from alerts.ts's event-triggered crash/spike detector.
export type TrendWindow = "1h" | "4h" | "12h" | "24h" | "7d" | "30d";

export interface TrendEntry {
  itemId: number;
  name: string;
  icon: string;
  fromPrice: number;
  toPrice: number;
  changePct: number;
}

export async function fetchTrends(window: TrendWindow): Promise<{ entries: TrendEntry[] }> {
  const res = await fetch(`/api/trends?window=${window}`);
  if (!res.ok) throw new Error(`Failed to fetch trends: ${res.status}`);
  return res.json();
}

// DESIGN.md §10 item 20 / §14.33: sector/basket indices -- a curated item-group's average price
// change over a window, for spotting sector-wide moves a single-item view would miss.
export interface SectorIndex {
  key: string;
  label: string;
  itemCount: number;
  totalItems: number;
  avgChangePct: number | null;
}

export async function fetchSectors(window: TrendWindow): Promise<{ sectors: SectorIndex[] }> {
  const res = await fetch(`/api/sectors?window=${window}`);
  if (!res.ok) throw new Error(`Failed to fetch sectors: ${res.status}`);
  return res.json();
}

// DESIGN.md §10 item 2 / §14.18: cross-item correlation / substitution flags -- when a leader
// item has moved but its substitute (raw/cooked, ore/bar, herb/potion) hasn't followed
// proportionally yet, a classic merchanting lag signal.
export interface SubstitutionPriceChange {
  itemId: number;
  name: string;
  icon: string;
  from: number;
  to: number;
  changePct: number;
}

export interface SubstitutionFlag {
  leader: SubstitutionPriceChange;
  follower: SubstitutionPriceChange;
  category: string;
  lagGapPct: number;
}

export async function fetchSubstitutionFlags(): Promise<{ flags: SubstitutionFlag[] }> {
  const res = await fetch("/api/substitutions");
  if (!res.ok) throw new Error(`Failed to fetch substitution flags: ${res.status}`);
  return res.json();
}

// DESIGN.md §10 item 34: daily/weekly research digest -- Track Record + trend leaderboard +
// tiered alerts synthesized into readable prose by the local LLM (llm.ts's generateDigest()).
export type ReportPeriod = "daily" | "weekly";

export interface ResearchReport {
  period: ReportPeriod;
  generatedAt: number;
  narrative: string;
  data: {
    trackRecord: TrackRecordSummary;
    topGainers: { name: string; changePct: number }[];
    topLosers: { name: string; changePct: number }[];
    majorAlerts: { name: string; direction: string; changePct: number }[];
  };
}

export async function fetchResearchReport(
  period: ReportPeriod,
  refresh = false,
): Promise<ResearchReport> {
  const res = await fetch(`/api/research-report?period=${period}${refresh ? "&refresh=true" : ""}`);
  if (!res.ok) throw new Error(`Failed to generate research report: ${res.status}`);
  return res.json();
}
