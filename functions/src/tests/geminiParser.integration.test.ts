import {describe, expect, test, jest} from "@jest/globals";
import * as dotenv from "dotenv";
dotenv.config();

import {parseIntent} from "../geminiParser";

// Increase timeout to 30 seconds since we are making real API calls
jest.setTimeout(30000);

const cases = [
  {
    transcript: "Generate 15k link for the lace fabric and send to 08031234567",
    expectedAmount: 15000,
    expectedDescription: "lace fabric",
    expectedPhone: "+2348031234567",
  },
  {
    transcript: "Create payment link of 5 bags for the sneakers, send to 07012345678",
    expectedAmount: 500000, // 1 bag = 100k
    expectedDescription: "sneakers",
    expectedPhone: "+2347012345678",
  },
  {
    transcript: "Bill Ade 2500 for data subscription, his number is 09011223344",
    expectedAmount: 2500,
    expectedDescription: "data",
    expectedPhone: "+2349011223344",
  }
];

// We only run this suite if the GEMINI_API_KEY environment variable is set
const runIntegrationTest = process.env.GEMINI_API_KEY ? describe : describe.skip;

runIntegrationTest("parseIntent Integration (Live API)", () => {
  test.each(cases)("live parses Nigerian transcript: $transcript", async ({transcript, expectedAmount, expectedDescription, expectedPhone}) => {
    
    // Call the actual function without any mocking
    const result = await parseIntent(transcript);

    console.log(`Real Gemini output for "${transcript}":\n`, result);

    expect(result.amount).toBe(expectedAmount);
    
    // The LLM might slightly adjust the description, so we just check if it contains the keywords
    expect(result.description.toLowerCase()).toContain(expectedDescription.toLowerCase());
    
    expect(result.customer_phone).toBe(expectedPhone);
  });
});
