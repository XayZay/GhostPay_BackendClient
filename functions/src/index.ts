import * as crypto from "crypto";
import * as admin from "firebase-admin";
import {logger} from "firebase-functions";
import {onRequest} from "firebase-functions/v2/https";
import type {Request, Response} from "express";
import jwt from "jsonwebtoken";

admin.initializeApp();

const mockVoicePayload = {
  status: "success",
  payload: {
    kora_url: "https://checkout.korapay.com/test_123",
    whatsapp_sent: true,
    parsed_data: {
      amount: 15000,
      customer: "+2348031234567",
      item: "Test item",
    },
    audio_feedback_url: "https://example.com/audio.mp3",
  },
} as const;

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

  res.status(200).json(mockVoicePayload);
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
