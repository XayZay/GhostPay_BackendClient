import {GoogleGenerativeAI} from "@google/generative-ai";

const GEMINI_MODEL = "gemini-3.5-flash";

export interface ParsedIntent {
  amount: number;
  description: string;
  customer_phone: string;
}

const GEMINI_PROMPT =
  "Extract payment intent from this Nigerian merchant voice command. " +
  "Return ONLY valid JSON with no markdown, no explanation:\n" +
  "{ \"amount\": number (in naira, convert 'k' to thousands, 'bag' to 100000), " +
  "\"description\": string, " +
  "\"customer_phone\": string (E.164 format, add +234 prefix, remove leading 0) }\n" +
  "If any field cannot be determined, set it to null.\n" +
  "Voice command: ";

/**
 * Send the Whisper transcript to Gemini Flash and parse the payment intent.
 */
export const parseIntent = async (transcript: string): Promise<ParsedIntent> => {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY is not configured");
  }

  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({model: GEMINI_MODEL});

  let text: string;
  try {
    const result = await model.generateContent(GEMINI_PROMPT + transcript);
    text = result.response.text().trim();
  } catch (error) {
    console.error("Gemini API error", {error});
    throw new Error("Could not understand the command. Please try again.");
  }
  console.log("Gemini raw response:", text);

  // Strip markdown fences if Gemini wraps the JSON
  const cleaned = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    throw new Error("Could not understand the command. Please try again.");
  }

  if (
    parsed.amount == null ||
    parsed.description == null ||
    parsed.customer_phone == null ||
    !Number.isFinite(Number(parsed.amount)) ||
    !/^\+234\d{10}$/.test(String(parsed.customer_phone))
  ) {
    throw new Error("Could not understand the command. Please try again.");
  }

  return {
    amount: Number(parsed.amount),
    description: String(parsed.description),
    customer_phone: String(parsed.customer_phone),
  };
};
