import OpenAI from "openai";

// backend/.env is gitignored and not loaded by anything else in this process --
// load it here, before constructing the client. Harmless if the file doesn't exist
// (e.g. a deploy that sets env vars directly).
try {
  process.loadEnvFile();
} catch {
  // no .env present -- assume env vars are already set some other way
}

// Every major provider (OpenAI, Anthropic, Ollama, Gemini, Grok, ...) now speaks the
// OpenAI-compatible chat completions API, so switching provider is just a base URL + token +
// model swap -- no SDK or request-shape changes. Defaults target a local Ollama instance
// running qwen3:14b (confirmed via `GET /api/tags` against the live local server -- the model
// tag actually pulled, not guessed); override any of the three env vars to point at a different
// provider/model.
const baseURL = process.env.LLM_BASE_URL ?? "http://localhost:11434/v1";
const apiKey = process.env.LLM_API_KEY ?? "ollama"; // Ollama ignores the key but the SDK requires a non-empty string
const model = process.env.LLM_MODEL ?? "qwen3:14b";

const client = new OpenAI({ baseURL, apiKey });

// DESIGN.md §9: "Explain the pick" -- the LLM's first concrete job in this app. The signal
// engine (signals.ts) does all the price math deterministically; the model's value-add here is
// narrating *why* a pick looks good in plain language and flagging risk as a second check, not
// the primary filter -- same "statistical rule first, LLM sanity-checks it" split already used
// by the alert detectors (alerts.ts).
export interface ExplainInput {
  name: string;
  high: number;
  low: number;
  netMargin: number | null;
  roiPct: number | null;
  liquidity: number;
  tax: number | null;
  buyLimit: number | null;
  members: boolean;
}

export interface Explanation {
  rationale: string;
  riskLevel: "low" | "medium" | "high";
  riskNote: string;
}

const SYSTEM_PROMPT = `You are a terse OSRS (Old School RuneScape) Grand Exchange flipping analyst. You're given one item's current market data -- already scored by a deterministic signal engine, not by you. Your job is narrow: explain in plain language why this flip looks worthwhile (or note if it's marginal), and flag the single biggest risk. You are a sanity check on the numbers, not the primary filter -- the item was already selected by the score. Be concrete and specific to the numbers given, not generic. No hedging filler like "as always, do your own research." Assume the reader already knows what GE flipping is.

Respond with ONLY a JSON object matching this exact shape, no markdown fences, no other text:
{"rationale": "1-2 sentences on why this flip looks worthwhile right now", "riskLevel": "low" | "medium" | "high", "riskNote": "1 sentence on the biggest risk to this specific flip, or why there isn't one"}`;

function parseExplanation(raw: string): Explanation {
  // Small local models (e.g. qwen via Ollama) sometimes wrap JSON in markdown fences or add
  // stray text around it despite instructions -- strip fences and grab the outermost {...}
  // rather than trusting the response is bare JSON like larger hosted models reliably give.
  const stripped = raw.replace(/```(?:json)?\s*/g, "").replace(/```\s*$/g, "");
  const match = stripped.match(/\{[\s\S]*\}/);
  const jsonText = match ? match[0] : stripped;
  const parsed = JSON.parse(jsonText) as Partial<Explanation>;
  if (!parsed.rationale || !parsed.riskLevel || !parsed.riskNote) {
    throw new Error("Model response missing required fields");
  }
  return parsed as Explanation;
}

export interface LlmPingResult {
  ok: boolean;
  baseURL: string;
  model: string;
  latencyMs: number;
  reply?: string;
  error?: string;
}

// Small standalone smoke test, decoupled from item scoring -- exists so the LLM connection
// (base URL, model tag, provider reachability) can be checked in one click without needing a
// real item id or worrying about the explain-endpoint's 15min cache. Surfaced via the Settings
// modal's "Test LLM" button.
export async function pingLlm(): Promise<LlmPingResult> {
  const startedAt = Date.now();
  try {
    const response = await client.chat.completions.create({
      model,
      messages: [
        { role: "user", content: 'Reply with exactly one word: "pong".' },
      ],
    });
    const reply = response.choices[0]?.message?.content?.trim();
    return { ok: true, baseURL, model, latencyMs: Date.now() - startedAt, reply };
  } catch (err) {
    return {
      ok: false,
      baseURL,
      model,
      latencyMs: Date.now() - startedAt,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function explainItem(input: ExplainInput): Promise<Explanation> {
  const response = await client.chat.completions.create({
    model,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: JSON.stringify(input) },
    ],
  });

  const text = response.choices[0]?.message?.content;
  if (!text) {
    throw new Error("Empty response from model");
  }

  return parseExplanation(text);
}

// DESIGN.md §10 item 34: daily/weekly research digest. Every number the model sees is already
// real (Track Record, trend leaderboard, tiered alerts -- all deterministic, already built) --
// the model's only job here is turning bullet facts into readable prose under fixed headings, the
// same "narrate, don't invent" split as explainItem() above. Plain markdown text back, not JSON --
// more forgiving for a small local model than strict structured output, and the frontend just
// renders it as-is.
const DIGEST_SYSTEM_PROMPT = `You are a terse OSRS Grand Exchange research analyst writing a periodic digest for a solo flipper. You are given real, already-computed data -- track record stats, price movers, and alerts. Your only job is to turn these numbers into short, readable prose under the given headings. Use ONLY the numbers provided. Never invent a price, percentage, or item that isn't in the data. If a section's data is empty, write one honest sentence saying so rather than inventing content. No preamble, no closing disclaimer, no markdown fences -- just the sections.`;

export interface DigestSection {
  heading: string;
  facts: unknown;
}

export async function generateDigest(
  period: "daily" | "weekly",
  sections: DigestSection[],
): Promise<string> {
  const prompt = `Write a ${period} OSRS GE flipping research digest with exactly these section headings, each as a markdown "## Heading" line followed by 1-3 sentences:\n\n${sections
    .map((s) => `## ${s.heading}\nData: ${JSON.stringify(s.facts)}`)
    .join("\n\n")}`;

  const response = await client.chat.completions.create({
    model,
    messages: [
      { role: "system", content: DIGEST_SYSTEM_PROMPT },
      { role: "user", content: prompt },
    ],
  });

  const text = response.choices[0]?.message?.content?.trim();
  if (!text) {
    throw new Error("Empty response from model");
  }
  return text;
}

// DESIGN.md §10 item 45 ("More indicators.txt" item 20, "AI Confidence"): instead of "buy," give
// a confidence read grounded in the actual computed indicator bundle (indicatorBundle.ts) --
// liquidity, buy/sell pressure, spread stability, mean reversion, supply/demand shock, flip
// saturation, opportunity score. Same "narrate real numbers, never invent" split as every other
// LLM call in this file -- the model never sees raw price ticks, only the already-computed,
// already-labeled indicators, so it can't hallucinate a number that isn't there.
export interface MarketIntelligenceInput {
  name: string;
  netMargin: number | null;
  roiPct: number | null;
  indicators: Record<string, unknown>;
}

export interface MarketIntelligence {
  conclusion: string;
  confidence: "low" | "medium" | "high";
}

const INTELLIGENCE_SYSTEM_PROMPT = `You are an OSRS Grand Exchange market analyst. You're given one item's net margin/ROI and a bundle of already-computed indicators (liquidity score, buy/sell pressure, spread stability, mean reversion signal, supply/demand shock, flip saturation, an overall opportunity score). All numbers are real and already calculated -- you do not compute anything, you only synthesize what they mean together into one concrete conclusion. Reference at least two specific indicators by name in your reasoning. Be direct, not hedgy. No "as always, do your own research."

Respond with ONLY a JSON object, no markdown fences, no other text:
{"conclusion": "2-3 sentences synthesizing what the indicators together suggest about this item right now", "confidence": "low" | "medium" | "high"}`;

function parseMarketIntelligence(raw: string): MarketIntelligence {
  const stripped = raw.replace(/```(?:json)?\s*/g, "").replace(/```\s*$/g, "");
  const match = stripped.match(/\{[\s\S]*\}/);
  const jsonText = match ? match[0] : stripped;
  const parsed = JSON.parse(jsonText) as Partial<MarketIntelligence>;
  if (!parsed.conclusion || !parsed.confidence) {
    throw new Error("Model response missing required fields");
  }
  return parsed as MarketIntelligence;
}

export async function generateMarketIntelligence(
  input: MarketIntelligenceInput,
): Promise<MarketIntelligence> {
  const response = await client.chat.completions.create({
    model,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: INTELLIGENCE_SYSTEM_PROMPT },
      { role: "user", content: JSON.stringify(input) },
    ],
  });

  const text = response.choices[0]?.message?.content;
  if (!text) {
    throw new Error("Empty response from model");
  }
  return parseMarketIntelligence(text);
}
