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
  // Execution Edge (§10 item 46): a more realistic buy/sell pair than the raw low/high (nudged
  // to jump the fill queue) and the margin actually clearable at those prices. See signals.ts.
  execution_buy_price: number | null;
  execution_sell_price: number | null;
  execution_margin: number | null;
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
  // realized ÷ projected avg net margin across resolved picks, clamped [0, 1.5]. Null until
  // enough picks have resolved to trust it (see backend/src/scorekeeping.ts). Multiply a
  // "projected profit" figure by this for a number already discounted by real-world track record.
  realizationRatio: number | null;
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

// DESIGN.md §10 item 45: rank items by how much a patch moved their price, before/after.
export interface UpdateSensitivityEntry {
  itemId: number;
  name: string;
  icon: string;
  beforePrice: number;
  afterPrice: number;
  changePct: number;
}

export interface UpdateSensitivityResult {
  eventDate: string;
  beforeDate: string;
  afterDate: string;
  windowDays: number;
  gainers: UpdateSensitivityEntry[];
  losers: UpdateSensitivityEntry[];
  itemsCompared: number;
}

// DESIGN.md §10 item 57: events already linked to this item (eventItemLinking.ts).
export interface ItemMention {
  id: number;
  eventDate: string;
  title: string;
  summary: string;
  source: string;
  link: string | null;
}

export async function fetchItemMentions(itemId: number): Promise<{ events: ItemMention[] }> {
  const res = await fetch(`/api/items/${itemId}/mentions`);
  if (!res.ok) throw new Error(`Failed to fetch item mentions: ${res.status}`);
  return res.json();
}

export async function fetchUpdateSensitivity(
  eventDate: string,
  windowDays?: number,
): Promise<UpdateSensitivityResult> {
  const qs = new URLSearchParams({ eventDate });
  if (windowDays != null) qs.set("windowDays", String(windowDays));
  const res = await fetch(`/api/update-sensitivity?${qs.toString()}`);
  if (!res.ok) throw new Error(`Failed to fetch update sensitivity: ${res.status}`);
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

export interface IndicatorBundle {
  liquidityScore: number;
  buyPressure: BuyPressure;
  buyPressureRatio: number | null;
  spreadStabilityScore: number | null;
  meanReversionZ: number | null;
  meanReversionSignal: MeanReversionSignal;
  supplyDemandShock: SupplyDemandShock;
  flipSaturation: FlipSaturation;
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

export interface MacdResult {
  macd: number;
  signal: number | null;
  histogram: number | null;
}

export interface BollingerBands {
  mid: number;
  upper: number;
  lower: number;
}

export interface CalendarFlags {
  hourUtc: number;
  dayOfWeekUtc: number;
  isWeekendUtc: boolean;
  isUpdateDayUtc: boolean;
}

export interface TechnicalIndicators {
  daysAvailable: number;
  sma5: number | null;
  sma20: number | null;
  ema12: number | null;
  ema26: number | null;
  macd: MacdResult | null;
  rsi14: number | null;
  bollinger20: BollingerBands | null;
  atr14: number | null;
  velocityPct: number | null;
  accelerationPct: number | null;
  trendSlopePctPerDay: number | null;
  buyLimitUtilization: number | null;
  daysSinceCrash: number | null;
  daysSinceSpike: number | null;
  calendar: CalendarFlags;
}

export async function fetchTechnicalIndicators(itemId: number): Promise<TechnicalIndicators> {
  const res = await fetch(`/api/items/${itemId}/technicals`);
  if (!res.ok) throw new Error(`Failed to fetch technical indicators: ${res.status}`);
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

// DESIGN.md §14.40: GE trade ledger -- real positions and flips derived from the transaction
// data RuneLite plugins write to local disk, as opposed to the app's own predictions
// (TrackRecord) or the hand-entered offers/fills this replaces.

export interface Position {
  itemId: number;
  name: string;
  icon: string | null;
  quantity: number;
  avgBuyPrice: number;
  costBasis: number;
  marketPrice: number | null;
  marketValue: number | null;
  unrealizedProfit: number | null;
  unrealizedRoiPct: number | null;
}

export interface GeSlot {
  slot: number;
  itemId: number;
  name: string;
  icon: string | null;
  type: "buy" | "sell";
  state: string;
  price: number;
  totalQuantity: number;
  quantitySold: number;
  remaining: number;
  spent: number;
  committedGp: number;
  marketPrice: number | null;
}

// DESIGN.md §14.41: how much of each item's 4h GE buy limit is already spent, so the Capital
// Allocator can size against real headroom instead of the catalogue limit.
export interface BuyLimitUsage {
  itemId: number;
  name: string;
  limit: number | null;
  boughtInWindow: number;
  remaining: number | null;
  oldestBuyInWindow: number | null;
}

export interface PortfolioResponse {
  positions: Position[];
  slots: GeSlot[];
  buyLimits: BuyLimitUsage[];
  totals: {
    assetsValue: number;
    cashInBuyOffers: number;
    unrealizedProfit: number;
    uniqueItems: number;
    slotsUsed: number;
    freeSlots: number;
  };
  sources: { copilot: boolean; flippingUtilities: boolean };
  captureStartedAt: number | null;
}

export type FlipStatus = "BUYING" | "SELLING" | "FINISHED";

export interface Flip {
  itemId: number;
  name: string;
  icon: string | null;
  firstBuyTime: number | null;
  lastSellTime: number | null;
  status: FlipStatus;
  bought: number;
  sold: number;
  avgBuyPrice: number;
  avgSellPrice: number;
  tax: number;
  profit: number;
  profitEach: number;
  roiPct: number | null;
  transactionCount?: number;
  transactions?: GeTransaction[];
}

export interface GeTransaction {
  id: number;
  item_id: number;
  type: "buy" | "sell";
  quantity: number;
  price: number;
  spent: number;
  slot: number | null;
  occurred_at: number;
  source: string;
  name?: string | null;
  icon?: string | null;
}

export interface SessionStats {
  since: number;
  realizedProfit: number;
  unrealizedProfit: number;
  flipsFinished: number;
  transactions: number;
  taxPaid: number;
  turnover: number;
  roiPct: number | null;
  gpPerHour: number | null;
  elapsedSeconds: number;
  positionsValue: number;
  captureStartedAt: number | null;
  excludedUnmatchedFlips: number;
  excludedUnmatchedRevenue: number;
}

export async function fetchPortfolio(): Promise<PortfolioResponse> {
  const res = await fetch("/api/portfolio");
  if (!res.ok) throw new Error(`Failed to load portfolio: ${res.status}`);
  return res.json();
}

export async function fetchFlips(
  status?: FlipStatus,
): Promise<{ flips: Flip[]; total: number; captureStartedAt: number | null }> {
  const res = await fetch(`/api/flips${status ? `?status=${status}` : ""}`);
  if (!res.ok) throw new Error(`Failed to load flips: ${res.status}`);
  return res.json();
}

export async function fetchFlipsForItem(itemId: number): Promise<{ flips: Flip[] }> {
  const res = await fetch(`/api/flips/${itemId}`);
  if (!res.ok) throw new Error(`Failed to load flip: ${res.status}`);
  return res.json();
}

export async function fetchTransactions(since = 0): Promise<{ transactions: GeTransaction[] }> {
  const res = await fetch(`/api/transactions?since=${since}`);
  if (!res.ok) throw new Error(`Failed to load transactions: ${res.status}`);
  return res.json();
}

export async function fetchSession(since?: number): Promise<SessionStats> {
  const res = await fetch(`/api/session${since ? `?since=${since}` : ""}`);
  if (!res.ok) throw new Error(`Failed to load session: ${res.status}`);
  return res.json();
}

export async function fetchMissedFlips(): Promise<{
  unmatchedSells: Flip[];
  stalled: Flip[];
  captureStartedAt: number | null;
}> {
  const res = await fetch("/api/missed-flips");
  if (!res.ok) throw new Error(`Failed to load missed flips: ${res.status}`);
  return res.json();
}

// DESIGN.md §14.43: time-of-day trading pattern for one item, from the Wiki API's 7d hourly
// series (the only lookback with full 24-hour coverage across multiple days).
export interface HourProfile {
  hourUtc: number;
  buyDeviation: number | null;
  sellDeviation: number | null;
  buyPrice: number | null;
  sellPrice: number | null;
  volume: number;
  days: number;
}

export interface TradingHours {
  itemId: number;
  hours: HourProfile[];
  bestBuyHourUtc: number | null;
  bestSellHourUtc: number | null;
  timingEdgePct: number | null;
  holdHours: number | null;
  busiestHourUtc: number | null;
  quietestHourUtc: number | null;
  daysCovered: number;
  hoursCovered: number;
  reliable: boolean;
  caveat: string | null;
}

export async function fetchTradingHours(itemId: number): Promise<TradingHours> {
  const res = await fetch(`/api/items/${itemId}/trading-hours`);
  if (!res.ok) throw new Error(`Failed to load trading hours: ${res.status}`);
  return res.json();
}

export async function fetchTradingHoursSummary(
  itemId: number,
  refresh = false,
): Promise<{ summary: string }> {
  const res = await fetch(
    `/api/items/${itemId}/trading-hours/summary${refresh ? "?refresh=true" : ""}`,
  );
  if (!res.ok) throw new Error(`Failed to generate summary: ${res.status}`);
  return res.json();
}

// DESIGN.md §14.44: "best item to buy" for a half-hour slot of the UTC day, across the market.
export interface HourlyPick {
  itemId: number;
  name: string;
  icon: string | null;
  slot: number;
  slotLabel: string;
  buyDeviation: number;
  bestSellSlot: number | null;
  bestSellSlotLabel: string | null;
  sellDeviation: number | null;
  timingEdgePct: number | null;
  // §14.45: the gp behind the percentage, so it can be checked rather than trusted.
  buyPrice: number | null;
  sellPrice: number | null;
  profitPerUnit: number | null;
  // §14.51: the sample behind profitPerUnit -- days where BOTH slots had a reading, and how many
  // of them the trade actually profited. The same number from 4 days and from 7 are different
  // claims, and only one column separates them.
  pairedDays: number;
  winDays: number;
  /** Calendar days those paired readings span -- 4 days over 51 is not a weekly rhythm. */
  pairedSpanDays: number;
  /** Range behind the median, per unit after tax -- the worst day is what a sleeping position risks. */
  worstDayProfit: number;
  bestDayProfit: number;
  holdSlots: number | null;
  holdHours: number | null;
  volume: number;
  days: number;
  price: number | null;
  buyLimit: number | null;
  projectedProfitPerLimit: number | null;
  // §14.46: what your bankroll actually buys and earns, not a percentage.
  deployableUnits: number;
  capitalUsed: number;
  cycleProfit: number;
  fillShare: number | null;
  score: number;
}

export interface ItemOfTheHourResponse {
  slot: number;
  slotLabel: string;
  currentSlot: number;
  picks: HourlyPick[];
  itemsProfiled: number;
  lastRun: number | null;
}

export async function fetchItemOfTheHour(
  slot?: number,
  bankroll?: number,
): Promise<ItemOfTheHourResponse> {
  const qs = new URLSearchParams();
  if (slot != null) qs.set("slot", String(slot));
  if (bankroll != null) qs.set("bankroll", String(bankroll));
  const res = await fetch(`/api/item-of-the-hour?${qs.toString()}`);
  if (!res.ok) throw new Error(`Failed to load item of the hour: ${res.status}`);
  return res.json();
}

// Overnight Trading, Phase 1: same slot-profile method as Item of the Hour, but the sell-slot
// search is capped to an actual overnight hold window instead of the whole day.
export interface OvernightPicksResponse {
  bedtimeSlot: number;
  bedtimeSlotLabel: string;
  currentSlot: number;
  maxHoldHours: number;
  picks: HourlyPick[];
  bankroll: number;
  itemsProfiled: number;
  lastRun: number | null;
}

export async function fetchOvernightPicks(
  bedtimeSlot?: number,
  maxHoldHours?: number,
  limit?: number,
  bankroll?: number,
): Promise<OvernightPicksResponse> {
  const qs = new URLSearchParams();
  if (bedtimeSlot != null) qs.set("bedtimeSlot", String(bedtimeSlot));
  if (maxHoldHours != null) qs.set("maxHoldHours", String(maxHoldHours));
  if (limit != null) qs.set("limit", String(limit));
  if (bankroll != null) qs.set("bankroll", String(bankroll));
  const res = await fetch(`/api/overnight-picks?${qs.toString()}`);
  if (!res.ok) throw new Error(`Failed to load overnight picks: ${res.status}`);
  return res.json();
}

// DESIGN.md §14.47: bank value history from RuneLite's Bank Value Tracker plugin, plus the GE
// side added back on the newest point. Bank value alone badly understates an active flipper's
// worth -- coins and stock committed to the Exchange aren't in the bank.
export interface NetWorthPoint {
  timestamp: number;
  bankValue: number;
  account: string;
  netWorth: number | null;
}

export interface BankHistoryResponse {
  points: NetWorthPoint[];
  geValueNow: number;
  assetsValue: number;
  cashInBuyOffers: number;
  available: boolean;
}

export async function fetchBankHistory(): Promise<BankHistoryResponse> {
  const res = await fetch("/api/bank-history");
  if (!res.ok) throw new Error(`Failed to load bank history: ${res.status}`);
  return res.json();
}


// The stored shape behind one pick: the item's whole 48-slot day plus the day-by-day outcomes of
// a specific buy->sell pair. Served straight from SQLite (no Wiki request), so fetching one per
// visible slot card is cheap.
export interface SlotProfilePoint {
  slot: number;
  slotLabel: string;
  buyPrice: number | null;
  sellPrice: number | null;
  volume: number;
  days: number;
}

export interface PairedDay {
  day: string;
  buy: number;
  sell: number;
  profit: number;
}

export interface SlotProfileResponse {
  itemId: number;
  updatedAt: number | null;
  slots: SlotProfilePoint[];
  buySlot: number | null;
  sellSlot: number | null;
  paired: PairedDay[];
  pairedDays: number;
  winDays: number;
  spanDays: number;
  medianProfit: number | null;
}

export async function fetchSlotProfile(
  itemId: number,
  buySlot?: number,
  sellSlot?: number,
): Promise<SlotProfileResponse> {
  const q = new URLSearchParams();
  if (buySlot != null) q.set("buySlot", String(buySlot));
  if (sellSlot != null) q.set("sellSlot", String(sellSlot));
  const res = await fetch(`/api/items/${itemId}/slot-profile?${q}`);
  if (!res.ok) throw new Error(`slot profile failed: ${res.status}`);
  return res.json();
}
