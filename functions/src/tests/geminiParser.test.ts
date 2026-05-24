import {describe, expect, jest, test} from "@jest/globals";

interface GeminiTestResult {
  response: {
    text: () => string;
  };
}

const generateContent = jest.fn<() => Promise<GeminiTestResult>>();

jest.mock("@google/generative-ai", () => ({
  GoogleGenerativeAI: jest.fn().mockImplementation(() => ({
    getGenerativeModel: jest.fn(() => ({generateContent})),
  })),
}));

const cases = [
  {
    transcript: "Generate 15k link for the lace fabric and send to 08031234567",
    parsed: {
      amount: 15000,
      description: "lace fabric",
      customer_phone: "+2348031234567",
    },
  },
  {
    transcript: "Create payment link of 5 bags for the sneakers, send to 07012345678",
    parsed: {
      amount: 500000,
      description: "sneakers",
      customer_phone: "+2347012345678",
    },
  },
  {
    transcript: "Bill Ade 2500 for data subscription, his number is 09011223344",
    parsed: {
      amount: 2500,
      description: "data subscription",
      customer_phone: "+2349011223344",
    },
  },
  {
    transcript: "Send 50k link for ankara material to 08123456789",
    parsed: {
      amount: 50000,
      description: "ankara material",
      customer_phone: "+2348123456789",
    },
  },
  {
    transcript: "Abeg make 3500 naira link for phone case, customer na 08055667788",
    parsed: {
      amount: 3500,
      description: "phone case",
      customer_phone: "+2348055667788",
    },
  },
  {
    transcript: "Generate 1.5k link for earrings go 07098765432",
    parsed: {
      amount: 1500,
      description: "earrings",
      customer_phone: "+2347098765432",
    },
  },
];

describe("parseIntent", () => {
  test.each(cases)("parses Nigerian transcript: $transcript", async ({parsed, transcript}) => {
    process.env.GEMINI_API_KEY = "test-key";
    generateContent.mockResolvedValueOnce({
      response: {
        text: () => JSON.stringify(parsed),
      },
    });

    const {parseIntent} = await import("../geminiParser");
    const result = await parseIntent(transcript);

    console.log("Gemini test output:", result);
    expect(Number.isFinite(result.amount)).toBe(true);
    expect(result.description).toBeTruthy();
    expect(result.customer_phone).toMatch(/^\+234\d{10}$/);
  });
});
