import * as crypto from "crypto";
import * as admin from "firebase-admin";
import {logger} from "firebase-functions";
import {FieldValue, Timestamp} from "firebase-admin/firestore";
import {onRequest} from "firebase-functions/v2/https";
import {onSchedule} from "firebase-functions/v2/scheduler";
import type {Request, Response} from "express";
import jwt from "jsonwebtoken";
import Busboy from "busboy";
import type {Readable} from "stream";
import FormData from "form-data";
import fetch from "node-fetch";
import {parseIntent} from "./geminiParser";

admin.initializeApp();

const WHISPER_PROMPT =
  "This is Nigerian English. Common terms: 'k' means thousand " +
  "(e.g. '15k' = 15000), 'naira' is the currency. Phone numbers " +
  "start with '070', '080', '081', '090', '091'. " +
  "Transcribe numbers as digits.";

interface AudioFile {
  buffer: Buffer;
  filename: string;
  mimeType: string;
}

interface KoraCharge {
  checkoutUrl: string;
  reference: string;
}

interface KoraChargeStatus {
  status?: string;
}

interface KoraEvent {
  data?: {
    reference?: string;
    transaction_reference?: string;
    status?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

interface ParsedPaymentData {
  amount: number;
  description: string;
  customer_phone: string;
}

interface JwtMerchantPayload extends jwt.JwtPayload {
  merchantId?: string;
  phone?: string;
}

interface VoiceIngestResponse {
  status: "success";
  payload: {
    kora_url: string;
    whatsapp_sent: boolean;
    parsed_data: {
      amount: number;
      customer: string;
      item: string;
    };
    audio_feedback_url: string;
  };
}

interface TransactionRecord {
  amount?: number;
  customer?: string;
  item?: string;
  merchantId?: string;
  [key: string]: unknown;
}

interface YarnGptAudioResponse {
  buffer: Buffer;
  contentType: string;
}

interface QueryChargeFallbackDeps {
  dispatchConfirmation?: (transactionId: string, merchantId: string) => Promise<void>;
  now?: () => number;
}

const db = admin.firestore();

/**
 * Parse multipart/form-data and extract the first audio file field.
 */
const parseMultipart = (req: Request): Promise<AudioFile> => {
  return new Promise((resolve, reject) => {
    const bb = Busboy({headers: req.headers});
    const chunks: Buffer[] = [];
    let filename = "audio.wav";
    let mimeType = "audio/wav";

    bb.on(
      "file",
      (_field: string, stream: Readable, info: {filename: string; mimeType: string}) => {
        filename = info.filename || filename;
        mimeType = info.mimeType || mimeType;
        stream.on("data", (chunk: Buffer) => chunks.push(chunk));
      }
    );

    bb.on("finish", () => {
      if (chunks.length === 0) {
        reject(new Error("No audio file found in request"));
        return;
      }
      resolve({buffer: Buffer.concat(chunks), filename, mimeType});
    });

    bb.on("error", (err: Error) => reject(err));

    // Firebase Cloud Functions pre-parse the body into req.rawBody
    const rawBody = (req as Request & {rawBody?: Buffer}).rawBody;
    if (rawBody) {
      bb.end(rawBody);
    } else {
      req.pipe(bb);
    }
  });
};

/**
 * Send an audio buffer to OpenAI Whisper and return the transcript.
 */
const transcribeAudio = async (audio: AudioFile): Promise<string> => {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is not configured");
  }

  const form = new FormData();

  // Whisper doesn't accept .aac — normalize to supported extensions
  const extensionMap: Record<string, {ext: string; mime: string}> = {
    ".aac": {ext: ".m4a", mime: "audio/mp4"},
    ".amr": {ext: ".mp3", mime: "audio/mpeg"},
    ".3gp": {ext: ".mp4", mime: "audio/mp4"},
  };

  let filename = audio.filename;
  let contentType = audio.mimeType;
  const dotIndex = filename.lastIndexOf(".");
  const originalExt = dotIndex >= 0 ? filename.slice(dotIndex).toLowerCase() : "";
  const mapped = extensionMap[originalExt];
  if (mapped) {
    filename = filename.slice(0, dotIndex) + mapped.ext;
    contentType = mapped.mime;
  }

  form.append("file", audio.buffer, {
    filename,
    contentType,
  });
  form.append("model", "whisper-1");
  form.append("language", "en");
  form.append("prompt", WHISPER_PROMPT);

  const response = await fetch(
    "https://api.openai.com/v1/audio/transcriptions",
    {
      method: "POST",
      headers: {Authorization: `Bearer ${apiKey}`},
      body: form,
    }
  );

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Whisper API error ${response.status}: ${body}`);
  }

  const data = (await response.json()) as {text: string};
  return data.text;
};

const initializeKoraCharge = async (
  parsedData: ParsedPaymentData,
  reference: string
): Promise<KoraCharge> => {
  try {
    const secretKey = process.env.KORA_SECRET_KEY;
    const webhookUrl = process.env.KORA_WEBHOOK_URL;

    if (!secretKey || !webhookUrl) {
      throw new Error("Kora environment variables are not configured");
    }

    const response = await fetch(
      "https://api.korapay.com/merchant/api/v1/charges/initialize",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${secretKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          amount: parsedData.amount,
          currency: "NGN",
          reference,
          narration: parsedData.description,
          customer: {
            email: "customer@ghostpay.app",
            name: "Ghost Pay Customer",
          },
          notification_url: webhookUrl,
        }),
      }
    );

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Kora API error ${response.status}: ${body}`);
    }

    const data = (await response.json()) as {
      data?: {checkout_url?: string};
    };
    const checkoutUrl = data.data?.checkout_url;

    if (!checkoutUrl) {
      throw new Error("Kora response missing checkout_url");
    }

    logger.info("Kora charge initialized", {reference});
    return {checkoutUrl, reference};
  } catch (error) {
    logger.error("Kora initialization failed", {error, reference});
    throw new Error("Payment link generation failed");
  }
};

const createTransaction = async (
  reference: string,
  parsedData: ParsedPaymentData,
  merchantId?: string
): Promise<void> => {
  await db.collection("transactions").doc(reference).set({
    status: "pending",
    amount: parsedData.amount,
    customer: parsedData.customer_phone,
    item: parsedData.description,
    merchantId,
    createdAt: FieldValue.serverTimestamp(),
  });
};

const getIdempotencyHash = (
  merchantId: string,
  parsedData: ParsedPaymentData,
  windowId: number
): string => {
  return crypto.createHash("sha256")
    .update(`${merchantId}${parsedData.amount}${parsedData.customer_phone}${windowId}`)
    .digest("hex");
};

const getCachedVoiceResponse = async (
  hash: string
): Promise<VoiceIngestResponse | null> => {
  const snapshot = await db.collection("idempotency").doc(hash).get();
  if (!snapshot.exists) {
    return null;
  }

  const createdAt = snapshot.get("createdAt") as Timestamp | undefined;
  const cachedResponse = snapshot.get("response") as VoiceIngestResponse | undefined;

  if (!createdAt || !cachedResponse) {
    return null;
  }

  const ageMs = Date.now() - createdAt.toMillis();
  return ageMs < 60 * 1000 ? cachedResponse : null;
};

const saveVoiceResponseCache = async (
  hash: string,
  response: VoiceIngestResponse
): Promise<void> => {
  const now = Timestamp.now();

  await db.collection("idempotency").doc(hash).set({
    response,
    createdAt: now,
    ttl: Timestamp.fromMillis(now.toMillis() + 5 * 60 * 1000),
  });
};

const numberWordsUnderThousand = (amount: number): string => {
  const ones = [
    "zero", "one", "two", "three", "four", "five", "six", "seven", "eight",
    "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen",
    "sixteen", "seventeen", "eighteen", "nineteen",
  ];
  const tens = [
    "", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy",
    "eighty", "ninety",
  ];

  if (amount < 20) {
    return ones[amount];
  }

  if (amount < 100) {
    const ten = Math.floor(amount / 10);
    const unit = amount % 10;
    return unit ? `${tens[ten]} ${ones[unit]}` : tens[ten];
  }

  const hundred = Math.floor(amount / 100);
  const rest = amount % 100;
  return rest
    ? `${ones[hundred]} hundred ${numberWordsUnderThousand(rest)}`
    : `${ones[hundred]} hundred`;
};

const numberToWords = (amount: number): string => {
  if (amount === 0) {
    return "zero";
  }

  const scales = [
    {value: 1_000_000_000, label: "billion"},
    {value: 1_000_000, label: "million"},
    {value: 1_000, label: "thousand"},
  ];
  const parts: string[] = [];
  let remaining = amount;

  for (const scale of scales) {
    const count = Math.floor(remaining / scale.value);
    if (count > 0) {
      parts.push(`${numberWordsUnderThousand(count)} ${scale.label}`);
      remaining %= scale.value;
    }
  }

  if (remaining > 0) {
    parts.push(numberWordsUnderThousand(remaining));
  }

  return parts.join(" ");
};

const formatAmountForSpeech = (amount: number): string => {
  const words = `${numberToWords(Math.round(amount))} naira`;
  return words.charAt(0).toUpperCase() + words.slice(1);
};

const generateYarnGptAudio = async (
  amount: number,
  itemName: string
): Promise<YarnGptAudioResponse> => {
  try {
    const apiKey = process.env.YARNGPT_API_KEY;
    if (!apiKey) {
      throw new Error("YARNGPT_API_KEY is not configured");
    }

    const response = await fetch("https://yarngpt.ai/api/v1/tts", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        text: `Boss, your payment don enter! ${formatAmountForSpeech(amount)} for the ${itemName}.`,
        voice: "osagie",
        response_format: "mp3",
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`YarnGPT API error ${response.status}: ${body}`);
    }

    return {
      buffer: await response.buffer(),
      contentType: response.headers.get("content-type") ?? "audio/mpeg",
    };
  } catch (error) {
    logger.error("YarnGPT audio generation failed", {error, amount, itemName});
    throw error;
  }
};

const uploadConfirmationAudio = async (
  transactionId: string,
  audio: YarnGptAudioResponse
): Promise<string> => {
  const bucket = admin.storage().bucket();
  const path = `audio/confirm_${transactionId}.mp3`;
  const file = bucket.file(path);

  await file.save(audio.buffer, {
    contentType: audio.contentType,
    resumable: false,
    metadata: {
      cacheControl: "public, max-age=31536000",
    },
  });
  await file.makePublic();

  return `https://storage.googleapis.com/${bucket.name}/${path}`;
};

const sendPaymentConfirmationFcm = async (
  merchantId: string,
  storagePublicUrl: string,
  amount: number,
  itemName: string
): Promise<void> => {
  const merchant = await db.collection("merchants").doc(merchantId).get();
  const token = merchant.get("fcmToken") as string | undefined;

  if (!token) {
    logger.warn("Merchant FCM token missing", {merchantId});
    return;
  }

  await admin.messaging().send({
    token,
    data: {
      type: "payment_confirmed",
      audio_url: storagePublicUrl,
      amount: String(amount),
      item: itemName,
    },
    android: {
      priority: "high",
    },
  });
};

export const dispatchPaymentConfirmation = async (
  transactionId: string,
  merchantId: string
): Promise<void> => {
  try {
    const snapshot = await db.collection("transactions").doc(transactionId).get();
    const transaction = snapshot.data() as TransactionRecord | undefined;

    if (!transaction) {
      logger.warn("Transaction missing for payment confirmation", {transactionId});
      return;
    }

    const amount = Number(transaction.amount ?? 0);
    const itemName = String(transaction.item ?? "item");
    const audio = await generateYarnGptAudio(amount, itemName);
    const audioUrl = await uploadConfirmationAudio(transactionId, audio);

    await sendPaymentConfirmationFcm(merchantId, audioUrl, amount, itemName);
    logger.info("Payment confirmation dispatched", {transactionId, merchantId});
  } catch (error) {
    logger.error("Payment confirmation dispatch failed", {
      error,
      transactionId,
      merchantId,
    });
  }
};

const sendWhatsAppPaymentLink = async (
  parsedData: ParsedPaymentData,
  koraCheckoutUrl: string
): Promise<boolean> => {
  try {
    const token = process.env.WHATSAPP_TOKEN;
    const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;

    if (!token || !phoneNumberId) {
      throw new Error("WhatsApp environment variables are not configured");
    }

    const response = await fetch(
      `https://graph.facebook.com/v19.0/${phoneNumberId}/messages`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          to: parsedData.customer_phone,
          type: "template",
          template: {
            name: "ghost_pay_payment_link",
            language: {code: "en"},
            components: [
              {
                type: "body",
                parameters: [
                  {type: "text", text: parsedData.description},
                  {type: "text", text: koraCheckoutUrl},
                ],
              },
            ],
          },
        }),
      }
    );

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`WhatsApp API error ${response.status}: ${body}`);
    }

    logger.info("WhatsApp payment link sent", {
      to: parsedData.customer_phone,
    });
    return true;
  } catch (error) {
    logger.error("WhatsApp payment link failed", {
      error,
      to: parsedData.customer_phone,
    });
    return false;
  }
};

const getRawBody = (req: Request): Buffer => {
  return (req as Request & {rawBody?: Buffer}).rawBody ?? Buffer.from("");
};

const sendMethodNotAllowed = (res: Response, allowedMethod: string): void => {
  res.set("Allow", allowedMethod).status(405).json({
    error: "method_not_allowed",
  });
};

const getBearerToken = (req: Request): string => {
  const authHeader = req.header("Authorization") ?? "";
  return authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
};

const verifyJwtPayload = (req: Request): JwtMerchantPayload | null => {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    return null;
  }

  const decoded = jwt.verify(getBearerToken(req), secret);
  return typeof decoded === "string" ? null : decoded as JwtMerchantPayload;
};

const requireJwt = (req: Request, res: Response): boolean => {
  if (!process.env.JWT_SECRET) {
    logger.warn("JWT_SECRET missing; rejecting protected request");
    res.status(500).json({error: "server_auth_not_configured"});
    return false;
  }

  try {
    verifyJwtPayload(req);
    return true;
  } catch (error) {
    logger.warn("JWT verification failed", {error});
    res.status(401).json({error: "unauthorized"});
    return false;
  }
};

const getMerchantIdFromRequest = (req: Request): string | null => {
  try {
    const payload = verifyJwtPayload(req);
    return payload?.merchantId ?? payload?.phone ?? payload?.sub ?? null;
  } catch (error) {
    logger.warn("JWT merchant payload extraction failed", {error});
    return null;
  }
};

const verifyKoraSignature = (req: Request, res: Response): boolean => {
  const secret = process.env.KORA_SECRET_KEY;

  if (!secret) {
    logger.warn("KORA_SECRET_KEY missing; rejecting webhook request");
    res.status(500).json({error: "webhook_auth_not_configured"});
    return false;
  }

  const signature = (req.header("x-korapay-signature") ?? "").trim();
  const digest = crypto
    .createHmac("sha256", secret)
    .update(getRawBody(req))
    .digest("hex");

  const signatureBuffer = Buffer.from(signature);
  const digestBuffer = Buffer.from(digest);

  if (
    signatureBuffer.length === digestBuffer.length
    && crypto.timingSafeEqual(signatureBuffer, digestBuffer)
  ) {
    return true;
  }

  logger.warn("Kora signature verification failed");
  res.status(401).json({error: "invalid_signature"});
  return false;
};

const parseKoraEvent = (req: Request): KoraEvent => {
  if (req.body && typeof req.body === "object") {
    return req.body as KoraEvent;
  }

  const rawBody = getRawBody(req).toString("utf8");
  return rawBody ? JSON.parse(rawBody) as KoraEvent : {};
};

const getEventMerchantId = (event: KoraEvent): string | undefined => {
  const value = event.data?.merchantId ?? event.data?.merchant_id;
  return typeof value === "string" && value ? value : undefined;
};

const markTransactionPaid = async (event: KoraEvent): Promise<void> => {
  const data = event.data;
  if (data?.status !== "success") {
    return;
  }

  const reference = data.reference ?? data.transaction_reference;
  if (!reference) {
    logger.error("Kora success event missing reference", {event});
    return;
  }

  const transactionRef = db.collection("transactions").doc(reference);
  const snapshot = await transactionRef.get();
  const paidAt = FieldValue.serverTimestamp();
  const existing = snapshot.data() as TransactionRecord | undefined;
  const merchantId = existing?.merchantId ?? getEventMerchantId(event);

  if (snapshot.exists) {
    await transactionRef.update({status: "paid", paidAt});
  } else {
    await transactionRef.set({
      ...data,
      status: "paid",
      paidAt,
      event,
    });
  }

  if (!merchantId) {
    logger.warn("Skipping payment confirmation; merchantId missing", {
      transactionId: reference,
    });
    return;
  }

  void dispatchPaymentConfirmation(reference, merchantId);
};

const fetchKoraChargeStatus = async (
  reference: string
): Promise<KoraChargeStatus> => {
  try {
    const secretKey = process.env.KORA_SECRET_KEY;
    if (!secretKey) {
      throw new Error("KORA_SECRET_KEY is not configured");
    }

    const response = await fetch(
      `https://api.korapay.com/merchant/api/v1/charges/${encodeURIComponent(reference)}`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${secretKey}`,
        },
      }
    );

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Kora charge lookup error ${response.status}: ${body}`);
    }

    const body = await response.json() as {
      data?: KoraChargeStatus;
      status?: string;
    };

    return body.data ?? {status: body.status};
  } catch (error) {
    logger.error("Kora charge lookup failed", {error, reference});
    throw error;
  }
};

export const runQueryChargeFallback = async (
  deps: QueryChargeFallbackDeps = {}
): Promise<{
  checked: number;
  resolved: number;
}> => {
  const dispatchConfirmation = deps.dispatchConfirmation ?? dispatchPaymentConfirmation;
  const now = deps.now ?? Date.now;
  const cutoff = Timestamp.fromMillis(now() - 2 * 60 * 1000);
  const snapshot = await db.collection("transactions")
    .where("status", "==", "pending")
    .where("createdAt", "<", cutoff)
    .get();

  let resolved = 0;

  for (const doc of snapshot.docs) {
    const transaction = doc.data() as TransactionRecord;
    const transactionId = doc.id;

    try {
      const charge = await fetchKoraChargeStatus(transactionId);
      const status = String(charge.status ?? "").toLowerCase();

      if (status === "success") {
        await doc.ref.update({
          status: "paid",
          paidAt: FieldValue.serverTimestamp(),
        });

        if (transaction.merchantId) {
          await dispatchConfirmation(transactionId, transaction.merchantId);
        } else {
          logger.warn("Skipping fallback confirmation; merchantId missing", {
            transactionId,
          });
        }

        resolved += 1;
      }

      if (status === "failed") {
        await doc.ref.update({
          status: "failed",
          failedAt: FieldValue.serverTimestamp(),
        });
        resolved += 1;
      }
    } catch (error) {
      logger.error("queryCharge transaction check failed", {
        error,
        transactionId,
      });
    }
  }

  logger.info("queryCharge fallback complete", {
    checked: snapshot.size,
    resolved,
  });

  return {checked: snapshot.size, resolved};
};

export const voiceIngest = onRequest({minInstances: 1}, async (req, res) => {
  const totalStartedAt = Date.now();

  if (req.method !== "POST") {
    sendMethodNotAllowed(res, "POST");
    return;
  }

  if (!requireJwt(req, res)) {
    return;
  }

  const merchantId = getMerchantIdFromRequest(req);
  if (!merchantId) {
    res.status(401).json({error: "merchant_id_required"});
    return;
  }

  try {
    const audio = await parseMultipart(req);
    logger.info("Audio file received", {
      filename: audio.filename,
      mimeType: audio.mimeType,
      sizeBytes: audio.buffer.length,
    });

    const whisperStartedAt = Date.now();
    const transcript = await transcribeAudio(audio);
    const whisperMs = Date.now() - whisperStartedAt;
    console.log({
      event: "whisper_complete",
      transcript,
      duration_ms: whisperMs,
    });

    const geminiStartedAt = Date.now();
    const parsedData = await parseIntent(transcript);
    const geminiMs = Date.now() - geminiStartedAt;
    console.log({
      event: "gemini_parsed",
      amount: parsedData.amount,
      customer_phone: parsedData.customer_phone,
      description: parsedData.description,
    });

    const windowId = Math.floor(Date.now() / 30000);
    const idempotencyHash = getIdempotencyHash(merchantId, parsedData, windowId);
    const cachedResponse = await getCachedVoiceResponse(idempotencyHash);
    if (cachedResponse) {
      res.status(200).json(cachedResponse);
      return;
    }

    const reference = `gp_${Date.now()}`;
    await createTransaction(reference, parsedData, merchantId);

    const koraStartedAt = Date.now();
    const koraPromise = initializeKoraCharge(parsedData, reference);
    const whatsappPromise = koraPromise.then(async (charge) => {
      const success = await sendWhatsAppPaymentLink(parsedData, charge.checkoutUrl);
      console.log({
        event: "whatsapp_sent",
        to: parsedData.customer_phone,
        success,
      });
      return success;
    });

    const koraCharge = await koraPromise;
    const koraMs = Date.now() - koraStartedAt;
    console.log({
      event: "kora_initialized",
      reference: koraCharge.reference,
      checkout_url: koraCharge.checkoutUrl,
    });

    void Promise.allSettled([whatsappPromise]).then(([result]) => {
      if (result.status === "rejected") {
        logger.error("WhatsApp background send failed", {
          error: result.reason,
          to: parsedData.customer_phone,
        });
        console.log({
          event: "whatsapp_sent",
          to: parsedData.customer_phone,
          success: false,
        });
      }
    });

    console.log({
      event: "timing",
      whisper_ms: whisperMs,
      gemini_ms: geminiMs,
      kora_ms: koraMs,
      total_ms: Date.now() - totalStartedAt,
    });

    const response: VoiceIngestResponse = {
      status: "success",
      payload: {
        kora_url: koraCharge.checkoutUrl,
        whatsapp_sent: false,
        parsed_data: {
          amount: parsedData.amount,
          customer: parsedData.customer_phone,
          item: parsedData.description,
        },
        audio_feedback_url: "",
      },
    };

    await saveVoiceResponseCache(idempotencyHash, response);
    res.status(200).json(response);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error("voiceIngest failed", {error: message});
    res.status(500).json({status: "error", message});
  }
});

export const koraWebhook = onRequest(async (req, res) => {
  if (req.method !== "POST") {
    sendMethodNotAllowed(res, "POST");
    return;
  }

  if (!verifyKoraSignature(req, res)) {
    return;
  }

  try {
    const event = parseKoraEvent(req);
    await markTransactionPaid(event);
  } catch (error) {
    logger.error("Kora webhook processing failed", {error});
  }

  res.status(200).json({received: true});
});

export const queryCharge = onSchedule({schedule: "every 2 minutes"}, async () => {
  await runQueryChargeFallback();
});

/**
 * Normalize Nigerian phone numbers to E.164 format (+234XXXXXXXXXX).
 * Accepts: 08031234567, 234803..., +234803..., 0803-123-4567, etc.
 */
const normalizeNigerianPhone = (raw: string): string | null => {
  const digits = raw.replace(/[\s\-().+]/g, "");

  let normalized: string;
  if (digits.startsWith("234") && digits.length === 13) {
    normalized = `+${digits}`;
  } else if (digits.startsWith("0") && digits.length === 11) {
    normalized = `+234${digits.slice(1)}`;
  } else if (digits.length === 10 && /^[789]/.test(digits)) {
    normalized = `+234${digits}`;
  } else {
    return null;
  }

  return /^\+234[789]\d{9}$/.test(normalized) ? normalized : null;
};

/**
 * Safely parse JSON body from request (handles both pre-parsed and raw).
 */
const parseRequestBody = (req: Request): Record<string, unknown> => {
  if (req.body && typeof req.body === "object") {
    return req.body as Record<string, unknown>;
  }

  const rawBody = (req as Request & {rawBody?: Buffer}).rawBody;
  if (rawBody) {
    return JSON.parse(rawBody.toString("utf8")) as Record<string, unknown>;
  }

  return {};
};

/**
 * Merchant auth — phone-based signup/login.
 * POST { name, phone } → { token, merchantId }
 */
export const merchantAuth = onRequest(async (req, res) => {
  if (req.method !== "POST") {
    sendMethodNotAllowed(res, "POST");
    return;
  }

  const secret = process.env.JWT_SECRET;
  if (!secret) {
    logger.warn("JWT_SECRET missing; cannot issue tokens");
    res.status(500).json({error: "server_auth_not_configured"});
    return;
  }

  try {
    const body = parseRequestBody(req);
    const name = typeof body.name === "string" ? body.name.trim() : "";
    const phoneRaw = typeof body.phone === "string" ? body.phone.trim() : "";

    if (!name || name.length < 2) {
      res.status(400).json({error: "invalid_name", message: "Name must be at least 2 characters"});
      return;
    }

    const phone = normalizeNigerianPhone(phoneRaw);
    if (!phone) {
      res.status(400).json({
        error: "invalid_phone",
        message: "Phone must be a valid Nigerian number (e.g. 08031234567)",
      });
      return;
    }

    const merchantRef = db.collection("merchants").doc(phone);
    await merchantRef.set(
      {
        name,
        phone,
        updatedAt: FieldValue.serverTimestamp(),
      },
      {merge: true}
    );

    const token = jwt.sign({merchantId: phone, phone}, secret, {expiresIn: "30d"});

    logger.info("Merchant authenticated", {merchantId: phone});
    res.status(200).json({token, merchantId: phone});
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error("merchantAuth failed", {error: message});
    res.status(500).json({error: "auth_failed", message});
  }
});

/**
 * Verify a bank account via Kora's resolve endpoint.
 * POST { account_number, bank_code } → resolved account details
 */
export const verifyAccount = onRequest(async (req, res) => {
  if (req.method !== "POST") {
    sendMethodNotAllowed(res, "POST");
    return;
  }

  if (!requireJwt(req, res)) {
    return;
  }

  try {
    const body = parseRequestBody(req);
    const accountNumberRaw = body.account_number ?? body.accountNumber;
    const bankCodeRaw = body.bank_code ?? body.bankCode;
    const accountNumber = typeof accountNumberRaw === "string" ? accountNumberRaw.trim() : "";
    const bankCode = typeof bankCodeRaw === "string" ? bankCodeRaw.trim() : "";

    if (!accountNumber || !/^\d{10}$/.test(accountNumber)) {
      res.status(400).json({
        error: "invalid_account_number",
        message: "Account number must be 10 digits",
      });
      return;
    }

    if (!bankCode || !/^\d{3}$/.test(bankCode)) {
      res.status(400).json({
        error: "invalid_bank_code",
        message: "Bank code must be 3 digits",
      });
      return;
    }

    const secretKey = process.env.KORA_SECRET_KEY;
    if (!secretKey) {
      res.status(500).json({error: "kora_not_configured"});
      return;
    }

    const koraResponse = await fetch(
      "https://api.korapay.com/merchant/api/v1/misc/banks/resolve",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${secretKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          bank: bankCode,
          account: accountNumber,
          currency: "NGN",
        }),
      }
    );

    if (!koraResponse.ok) {
      const errorBody = await koraResponse.text();
      logger.error("Kora resolve failed", {status: koraResponse.status, body: errorBody});
      res.status(502).json({
        error: "bank_verification_failed",
        message: "Could not verify bank account. Please check the details and try again.",
      });
      return;
    }

    const koraData = (await koraResponse.json()) as {
      status?: boolean;
      data?: {
        account_name?: string;
        bank_name?: string;
        account_number?: string;
        bank_code?: string;
      };
    };

    if (!koraData.status || !koraData.data?.account_name) {
      res.status(404).json({
        error: "account_not_found",
        message: "Bank account could not be resolved",
      });
      return;
    }

    logger.info("Bank account verified", {bankCode, accountNumber});
    res.status(200).json({
      account_name: koraData.data.account_name,
      bank_name: koraData.data.bank_name ?? "",
      account_number: koraData.data.account_number ?? accountNumber,
      bank_code: koraData.data.bank_code ?? bankCode,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error("verifyAccount failed", {error: message});
    res.status(500).json({error: "verification_failed", message});
  }
});

/**
 * Create/update merchant with verified payout bank details.
 * POST { account_number, bank_code, account_name } → { status, merchantId }
 */
export const createMerchant = onRequest(async (req, res) => {
  if (req.method !== "POST") {
    sendMethodNotAllowed(res, "POST");
    return;
  }

  if (!requireJwt(req, res)) {
    return;
  }

  const merchantId = getMerchantIdFromRequest(req);
  if (!merchantId) {
    res.status(401).json({error: "merchant_id_required"});
    return;
  }

  try {
    const body = parseRequestBody(req);
    const accountNumberRaw = body.account_number ?? body.accountNumber;
    const bankCodeRaw = body.bank_code ?? body.bankCode;
    const accountNameRaw = body.account_name ?? body.accountName;
    const accountNumber = typeof accountNumberRaw === "string" ? accountNumberRaw.trim() : "";
    const bankCode = typeof bankCodeRaw === "string" ? bankCodeRaw.trim() : "";
    const accountName = typeof accountNameRaw === "string" ? accountNameRaw.trim() : "";

    if (!accountNumber || !bankCode || !accountName) {
      res.status(400).json({
        error: "missing_fields",
        message: "account_number, bank_code, and account_name are required",
      });
      return;
    }

    const merchantRef = db.collection("merchants").doc(merchantId);
    await merchantRef.set(
      {
        payoutAccountNumber: accountNumber,
        payoutBankCode: bankCode,
        payoutAccountName: accountName,
        onboardingComplete: true,
        updatedAt: FieldValue.serverTimestamp(),
      },
      {merge: true}
    );

    logger.info("Merchant payout details saved", {merchantId});
    res.status(200).json({status: "success", merchantId});
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error("createMerchant failed", {error: message, merchantId});
    res.status(500).json({error: "create_merchant_failed", message});
  }
});

/**
 * Store or update merchant FCM token for push notifications.
 * POST { fcm_token } → { status }
 */
export const merchantFcm = onRequest(async (req, res) => {
  if (req.method !== "POST") {
    sendMethodNotAllowed(res, "POST");
    return;
  }

  if (!requireJwt(req, res)) {
    return;
  }

  const merchantId = getMerchantIdFromRequest(req);
  if (!merchantId) {
    res.status(401).json({error: "merchant_id_required"});
    return;
  }

  try {
    const body = parseRequestBody(req);
    const fcmToken = typeof body.fcm_token === "string"
      ? body.fcm_token.trim() : "";

    if (!fcmToken) {
      res.status(400).json({
        error: "missing_fcm_token",
        message: "fcm_token is required",
      });
      return;
    }

    const merchantRef = db.collection("merchants").doc(merchantId);
    await merchantRef.set(
      {
        fcmToken,
        fcmUpdatedAt: FieldValue.serverTimestamp(),
      },
      {merge: true}
    );

    logger.info("FCM token updated", {merchantId});
    res.status(200).json({status: "success"});
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error("merchantFcm failed", {error: message, merchantId});
    res.status(500).json({error: "fcm_update_failed", message});
  }
});
