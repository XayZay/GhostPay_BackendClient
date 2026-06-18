import {describe, expect, jest, test} from "@jest/globals";
import * as dotenv from "dotenv";
import {parseIntent} from "../geminiParser";

dotenv.config();

jest.setTimeout(60000);

const transcripts = [
  "generate 15 K link for lace fabric send to 0 8 0 3 1 2 3 4 5 6 7",
  "create 5 bags payment for sneakers customer number zero seven zero one two three four five six seven eight",
  "abeg make two five hundred link for phone case na 0 8 0 5 5 6 6 7 7 8 8",
  "bill am thirty K for ankara go 0 9 0 1 1 2 2 3 3 4 4",
  "send link 1.5k earrings to this number 0 7 0 9 8 7 6 5 4 3 2",
];

const runGeminiTests = process.env.GEMINI_API_KEY ? describe : describe.skip;

runGeminiTests("Nigerian Whisper transcript parser", () => {
  test.each(transcripts)("parses simulated Whisper transcript: %s", async (transcript) => {
    const parsed = await parseIntent(transcript);

    console.log("Raw Gemini parsed output:", {
      transcript,
      parsed,
    });

    expect(Number.isInteger(parsed.amount)).toBe(true);
    expect(parsed.amount).toBeGreaterThan(0);
    expect(parsed.customer_phone).toMatch(/^\+234/);
    expect(parsed.description.trim().length).toBeGreaterThan(0);
  });
});