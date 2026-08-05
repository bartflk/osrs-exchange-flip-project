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
// running qwen3.5:9b, since that's the model currently in use; override any of the three env
// vars to point at a different provider.
const baseURL = process.env.LLM_BASE_URL ?? "http://localhost:11434/v1";
const apiKey = process.env.LLM_API_KEY ?? "ollama"; // Ollama ignores the key but the SDK requires a non-empty string
const model = process.env.LLM_MODEL ?? "qwen3.5:9b";

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
