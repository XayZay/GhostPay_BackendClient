import * as crypto from "crypto";
import * as admin from "firebase-admin";
import {logger} from "firebase-functions";
import {onRequest} from "firebase-functions/v2/https";
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

interface ParsedPaymentData {
  amount: number;
  description: string;
  customer_phone: string;
}

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
  form.append("file", audio.buffer, {
    filename: audio.filename,
    contentType: audio.mimeType,
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
  parsedData: ParsedPaymentData
): Promise<KoraCharge> => {
  const reference = `gp_${Date.now()}`;

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

const sendMethodNotAllowed = (res: Response, allowedMethod: string): void => {
  res.set("Allow", allowedMethod).status(405).json({
    error: "method_not_allowed",
  });
};

const requireJwt = (req: Request, res: Response): boolean => {
  const secret = process.env.JWT_SECRET;

  if (!secret) {
    logger.warn("JWT_SECRET missing; rejecting protected request");
    res.status(500).json({error: "server_auth_not_configured"});
    return false;
  }

  const authHeader = req.header("Authorization") ?? "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";

  try {
    jwt.verify(token, secret);
    return true;
  } catch (error) {
    logger.warn("JWT verification failed", {error});
    res.status(401).json({error: "unauthorized"});
    return false;
  }
};

const verifyKoraSignature = (req: Request, res: Response): boolean => {
  const secret = process.env.KORA_SECRET_KEY;

  if (!secret) {
    logger.warn("KORA_SECRET_KEY missing; rejecting webhook request");
    res.status(500).json({error: "webhook_auth_not_configured"});
    return false;
  }

  const signature = req.header("x-korapay-signature") ?? "";
  const body = JSON.stringify(req.body ?? {});
  const digest = crypto.createHmac("sha256", secret).update(body).digest("hex");

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

export const voiceIngest = onRequest(async (req, res) => {
  if (req.method !== "POST") {
    sendMethodNotAllowed(res, "POST");
    return;
  }

  if (!requireJwt(req, res)) {
    return;
  }

  try {
    const audio = await parseMultipart(req);
    logger.info("Audio file received", {
      filename: audio.filename,
      mimeType: audio.mimeType,
      sizeBytes: audio.buffer.length,
    });

    const transcript = await transcribeAudio(audio);
    console.log("Whisper transcript:", transcript);

    const parsedData = await parseIntent(transcript);
    console.log("Parsed intent:", parsedData);

    const koraCharge = await initializeKoraCharge(parsedData);
    const whatsappSent = await sendWhatsAppPaymentLink(
      parsedData,
      koraCharge.checkoutUrl
    );

    res.status(200).json({
      status: "success",
      payload: {
        kora_url: koraCharge.checkoutUrl,
        whatsapp_sent: whatsappSent,
        parsed_data: {
          amount: parsedData.amount,
          customer: parsedData.customer_phone,
          item: parsedData.description,
        },
        audio_feedback_url: "",
      },
    });
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

  res.status(200).json({received: true});
});

export const queryCharge = onRequest(async (req, res) => {
  if (req.method !== "GET") {
    sendMethodNotAllowed(res, "GET");
    return;
  }

  if (!requireJwt(req, res)) {
    return;
  }

  res.status(200).json({status: "pending"});
});
