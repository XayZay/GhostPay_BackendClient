import {describe, expect, jest, test, beforeEach} from "@jest/globals";

const mockUpdate = jest.fn<(data: unknown) => Promise<void>>();
const mockGet = jest.fn<() => Promise<any>>();
const mockWhere = jest.fn<(field: string, operator: string, value: unknown) => any>();
const mockCollection = jest.fn<(name: string) => any>();
const mockFetch = jest.fn<(url: string, init: unknown) => Promise<any>>();

const serverTimestamp = {type: "serverTimestamp"};
const makeTimestamp = (millis: number) => ({
  millis,
  toMillis: () => millis,
});

const firestoreFn = jest.fn(() => ({collection: mockCollection})) as jest.Mock & {
  Timestamp: {fromMillis: (millis: number) => ReturnType<typeof makeTimestamp>};
  FieldValue: {serverTimestamp: () => typeof serverTimestamp};
};
firestoreFn.Timestamp = {fromMillis: makeTimestamp};
firestoreFn.FieldValue = {serverTimestamp: () => serverTimestamp};

jest.mock("firebase-admin", () => ({
  initializeApp: jest.fn(),
  firestore: firestoreFn,
  storage: jest.fn(() => ({bucket: jest.fn()})),
  messaging: jest.fn(() => ({send: jest.fn()})),
}));

jest.mock("firebase-functions", () => ({
  logger: {
    error: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
  },
}));

jest.mock("firebase-functions/v2/https", () => ({
  onRequest: jest.fn((handler) => handler),
}));

jest.mock("firebase-functions/v2/scheduler", () => ({
  onSchedule: jest.fn((_options, handler) => handler),
}));

jest.mock("node-fetch", () => ({
  __esModule: true,
  default: mockFetch,
}));

describe("queryCharge webhook fallback", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.KORA_SECRET_KEY = "test-kora-secret";
  });

  test("polls Kora, marks pending transaction paid, and dispatches confirmation", async () => {
    const now = Date.parse("2026-06-03T12:00:00.000Z");
    const transactionId = process.env.KORA_SANDBOX_REFERENCE ?? "gp_real_kora_sandbox_reference";
    const merchantId = "+2348031234567";
    const transaction = {
      status: "pending",
      merchantId,
      amount: 15000,
      item: "lace fabric",
      createdAt: makeTimestamp(now - 3 * 60 * 1000),
    };

    const query = {where: mockWhere, get: mockGet};
    mockCollection.mockReturnValue(query);
    mockWhere.mockReturnValue(query);
    mockGet.mockResolvedValue({
      size: 1,
      docs: [
        {
          id: transactionId,
          data: () => transaction,
          ref: {update: mockUpdate},
        },
      ],
    });
    mockUpdate.mockResolvedValue(undefined);
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({data: {status: "success"}}),
    });

    const dispatchConfirmation = jest.fn<(
      transactionId: string,
      merchantId: string
    ) => Promise<void>>().mockResolvedValue(undefined);

    console.log("Creating pending Firestore transaction", {transactionId, transaction});

    const {runQueryChargeFallback} = await import("../index");
    const result = await runQueryChargeFallback({
      dispatchConfirmation,
      now: () => now,
    });

    console.log("Kora fallback poll result", result);
    console.log("Firestore transaction marked paid", {transactionId});
    console.log("Payment confirmation dispatched", {transactionId, merchantId});

    expect(mockCollection).toHaveBeenCalledWith("transactions");
    expect(mockWhere).toHaveBeenNthCalledWith(1, "status", "==", "pending");
    expect(mockWhere).toHaveBeenNthCalledWith(
      2,
      "createdAt",
      "<",
      expect.objectContaining({millis: now - 2 * 60 * 1000})
    );
    expect(mockFetch).toHaveBeenCalledWith(
      `https://api.korapay.com/merchant/api/v1/charges/${encodeURIComponent(transactionId)}`,
      {
        method: "GET",
        headers: {Authorization: "Bearer test-kora-secret"},
      }
    );
    expect(mockUpdate).toHaveBeenCalledWith({
      status: "paid",
      paidAt: serverTimestamp,
    });
    expect(dispatchConfirmation).toHaveBeenCalledWith(transactionId, merchantId);
    expect(result).toEqual({checked: 1, resolved: 1});
  });
});