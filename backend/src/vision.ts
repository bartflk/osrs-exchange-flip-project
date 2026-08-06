import OpenAI from "openai";

// Same OpenAI-compatible-everywhere trick as llm.ts, but pointed at a vision-capable model --
// qwen3:14b (llm.ts's default) is text-only, so screenshot reading needs a separate model tag.
// Deliberately a second client/model pair rather than reusing llm.ts's, since a user may want a
// different provider/size for vision vs text (e.g. a smaller vision model to leave more VRAM
// headroom -- see the GE-offers-from-screenshot feature discussion).
try {
  process.loadEnvFile();
} catch {
  // no .env present -- assume env vars are already set some other way
}

const baseURL = process.env.VISION_LLM_BASE_URL ?? process.env.LLM_BASE_URL ?? "http://localhost:11434/v1";
const apiKey = process.env.VISION_LLM_API_KEY ?? process.env.LLM_API_KEY ?? "ollama";
const model = process.env.VISION_LLM_MODEL ?? "qwen2.5vl:7b";

const client = new OpenAI({ baseURL, apiKey });

export interface ExtractedOffer {
  type: "buy" | "sell";
  itemName: string;
  price: number;
  qty: number;
  // How many of `qty` have already gone through, read off the slot's progress bar/fraction
  // (e.g. a bar 3/5 full, or text like "3 / 5"). 0 if the offer shows no progress yet.
  filledQty: number;
  // Which of the 8 physical GE slots this is (1-8, left-to-right then top-to-bottom, matching
  // the game's own grid). The one identifier that's still unique even when the SAME item is
  // sitting in several slots at once (e.g. one buy + three sell offers on the same item) -- name
  // + type alone can't tell those apart on a re-screenshot, this can. Null if the screenshot is
  // cropped tight enough that slot position can't be determined.
  slotIndex: number | null;
}

export interface ExtractedGeState {
  offers: ExtractedOffer[];
  // Slots (1-8) visibly labeled "Empty" in this screenshot -- i.e. confirmed to have no offer,
  // not just "not mentioned." This is what lets the app tell "you freed up this slot" (it was
  // tracked, now the screenshot shows it Empty -- safe to stop tracking it) apart from "this
  // screenshot just doesn't happen to show that slot" (say nothing, don't touch it).
  emptySlotIndexes: number[];
}

const SYSTEM_PROMPT = `You are reading a screenshot of the Old School RuneScape Grand Exchange interface, which shows up to 8 trade slots arranged in a 4-wide, 2-row grid (slot 1 = top-left, slot 4 = top-right, slot 5 = bottom-left, slot 8 = bottom-right).

Each slot with an active offer has this EXACT layout, top to bottom -- read each piece from the specific spot described, don't guess or infer numbers from elsewhere in the slot:

1. A header row: the word "Buy" (shown in blue) or "Sell" (shown in orange/yellow) on the left, and a "HH:MM:SS" elapsed-time counter on the right. IGNORE the timer completely -- it's how long the offer has been open, not a price or quantity.
2. Below that: the item's icon on the left with the item's name as text next to it. Look at the icon closely -- there is a SMALL number badge overlaid in the icon's upper-left corner, in a different (usually yellow/gold) color from the surrounding art. That small badge number is the offer's TOTAL QUANTITY (qty). It is easy to miss because it's small and sits on top of the icon artwork, not in its own labeled row -- look for it specifically, don't confuse it with anything else in the slot.
3. Below the icon/name: a horizontal progress bar (a dark rounded rectangle, partially filled with a solid color from the left). The FRACTION of the bar's width that is filled represents how much of qty has gone through so far. Estimate filledQty as round(qty * fill_fraction) by eye. A bar with zero fill (or a slot showing no bar at all) means filledQty is 0.
4. Below the progress bar: a single number formatted like "17,845,157 coins". This is the PRICE PER ITEM in gp -- NOT a total, NOT the player's overall coin balance. (You can sanity-check this: price × qty for a slot should be consistent with amounts elsewhere in the interface, e.g. the Grand Exchange window's title-bar total when only one offer is open.)

A slot with no offer shows only the word "Empty" as its heading, with no icon, no progress bar, and no coin amount -- nothing else to extract from it, just note its slot number.

For each slot with an active offer, extract:
- type: "buy" or "sell", from step 1 above
- itemName: the item's name exactly as shown, from step 2
- price: the price PER ITEM in gp from step 4, as a plain integer -- no commas, no "coins" suffix, no "k"/"m" suffix, and do NOT multiply or divide it by qty (it is already per-item)
- qty: the small badge number from step 2 (NOT anything from the progress bar or the coins line), as a plain integer
- filledQty: your estimate from step 3, as a plain integer between 0 and qty
- slotIndex: which of the 8 slots (1-8) this offer is in, per the grid position described above. IMPORTANT: the same item can legitimately appear in more than one slot at once (e.g. several sell offers split across slots for the same item) -- always report the slot position even when the item name repeats, never merge or skip a slot just because another slot has the same item. If the screenshot only shows a single slot cropped in isolation with no visible grid context, use null for slotIndex and don't report any empty slots either (you can't see the rest of the grid, so you can't know what's actually empty).

If a slot's quantity badge or price line is cut off or genuinely illegible, omit that offer entirely rather than guessing -- but still report a slot as empty if its heading literally says "Empty".

Respond with ONLY a JSON object, no markdown fences, no other text, in this exact shape:
{"offers": [{"type": "buy", "itemName": "Abyssal whip", "price": 786000, "qty": 5, "filledQty": 2, "slotIndex": 3}], "emptySlotIndexes": [1, 4, 6, 7, 8]}

If nothing is readable, respond with {"offers": [], "emptySlotIndexes": []}`;

function parseGeState(raw: string): ExtractedGeState {
  // Small local vision models sometimes wrap JSON in markdown fences or add stray commentary
  // despite instructions -- same defensive parsing as llm.ts's parseExplanation.
  const stripped = raw.replace(/```(?:json)?\s*/g, "").replace(/```\s*$/g, "");
  const match = stripped.match(/\{[\s\S]*\}/);
  const jsonText = match ? match[0] : stripped;
  const parsed = JSON.parse(jsonText) as unknown;
  if (!parsed || typeof parsed !== "object") throw new Error("Model response was not a JSON object");
  const obj = parsed as Record<string, unknown>;

  const rawOffers = Array.isArray(obj.offers) ? obj.offers : [];
  const offers = rawOffers
    .filter((row): row is Record<string, unknown> & { type: "buy" | "sell" } => {
      if (!row || typeof row !== "object") return false;
      const r = row as Record<string, unknown>;
      return (
        (r.type === "buy" || r.type === "sell") &&
        typeof r.itemName === "string" &&
        r.itemName.trim().length > 0 &&
        typeof r.price === "number" &&
        Number.isFinite(r.price) &&
        r.price > 0 &&
        typeof r.qty === "number" &&
        Number.isFinite(r.qty) &&
        r.qty > 0
      );
    })
    .map((r) => {
      const qty = r.qty as number;
      const rawFilled = typeof r.filledQty === "number" && Number.isFinite(r.filledQty) ? r.filledQty : 0;
      // Clamp defensively -- a model reporting filledQty > qty (misread progress bar) shouldn't
      // produce a nonsensical "6/5 filled" downstream.
      const filledQty = Math.max(0, Math.min(qty, Math.round(rawFilled)));
      const rawSlot = r.slotIndex;
      const slotIndex =
        typeof rawSlot === "number" && Number.isInteger(rawSlot) && rawSlot >= 1 && rawSlot <= 8
          ? rawSlot
          : null;
      return {
        type: r.type,
        itemName: (r.itemName as string).trim(),
        price: r.price as number,
        qty,
        filledQty,
        slotIndex,
      };
    });

  const rawEmpty = Array.isArray(obj.emptySlotIndexes) ? obj.emptySlotIndexes : [];
  const emptySlotIndexes = [
    ...new Set(
      rawEmpty.filter(
        (n): n is number => typeof n === "number" && Number.isInteger(n) && n >= 1 && n <= 8,
      ),
    ),
  ];

  return { offers, emptySlotIndexes };
}

// `imageDataUrl` is a full data: URL (e.g. "data:image/png;base64,...") as produced by the
// browser's FileReader.readAsDataURL -- passed straight through to the model, no server-side
// decoding needed.
export async function extractGeOffersFromImage(imageDataUrl: string): Promise<ExtractedGeState> {
  const response = await client.chat.completions.create({
    model,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "user",
        content: [
          { type: "text", text: "Read the GE trade slots in this screenshot." },
          { type: "image_url", image_url: { url: imageDataUrl } },
        ],
      },
    ],
  } as OpenAI.Chat.ChatCompletionCreateParamsNonStreaming);

  const text = response.choices[0]?.message?.content;
  if (!text) throw new Error("Empty response from vision model");

  const state = parseGeState(text);
  // Not an error case (an empty GE, or a slot mid-setup with no price typed in yet, both
  // legitimately produce zero offers) -- but silent-zero is indistinguishable from "the model
  // just didn't read it" without seeing what it actually said, so log the raw reply either way.
  console.log(
    `[vision] extracted ${state.offers.length} offer(s), ${state.emptySlotIndexes.length} empty slot(s) from screenshot. Raw model reply:\n${text}`,
  );
  return state;
}
