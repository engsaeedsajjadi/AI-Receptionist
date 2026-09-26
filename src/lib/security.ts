import { createHmac, timingSafeEqual } from "node:crypto";
import { NextRequest } from "next/server";
import { AppError } from "@/lib/errors";
import { setNx } from "@/lib/redis";

const MAX_WEBHOOK_BODY_BYTES = 1024 * 1024; // 1 MB
const TIMESTAMP_TOLERANCE_SECONDS = 5 * 60; // 5 minutes

export function computeHmacHex(secret: string, payload: string): string {
  return createHmac("sha256", secret).update(payload, "utf8").digest("hex");
}

export function verifyHmacHex(secret: string, payload: string, signature: string): boolean {
  const expected = computeHmacHex(secret, payload);
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(signature.trim(), "utf8");
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

export type WebhookVerification = {
  rawBody: string;
  payload: Record<string, unknown>;
  idempotencyKey: string;
  duplicate: boolean;
};

function getHeader(req: NextRequest, names: string[]): string | null {
  for (const name of names) {
    const value = req.headers.get(name);
    if (value) return value;
  }
  return null;
}

/**
 * Verify an inbound webhook:
 * - request size limit
 * - HMAC-SHA256 signature (timing-safe)
 * - timestamp freshness (replay protection) when a timestamp header is present
 * - idempotency key (distributed, Redis-backed)
 *
 * Accepted headers:
 * - signature: x-webhook-signature | x-signature | stripe-style "t=...,v1=..."
 * - idempotency: x-idempotency-key | idempotency-key
 * - timestamp: x-webhook-timestamp | x-timestamp
 */
export async function verifyWebhookRequest(
  req: NextRequest,
  opts: { secret: string; scope: string; requireTimestamp?: boolean },
): Promise<WebhookVerification> {
  const rawBody = await req.text();
  if (Buffer.byteLength(rawBody, "utf8") > MAX_WEBHOOK_BODY_BYTES) {
    throw new AppError(413, "PAYLOAD_TOO_LARGE", "Webhook payload too large");
  }

  const signatureHeader = getHeader(req, ["x-webhook-signature", "x-signature", "x-hub-signature-256"]);
  const idempotencyKey = getHeader(req, ["x-idempotency-key", "idempotency-key"]);
  const timestampHeader = getHeader(req, ["x-webhook-timestamp", "x-timestamp"]);

  if (!signatureHeader) throw new AppError(401, "INVALID_SIGNATURE", "Missing webhook signature");
  if (!idempotencyKey) throw new AppError(401, "UNAUTHORIZED", "Missing idempotency key");

  // Support "t=<ts>,v1=<hex>" style signatures; signed content is "<ts>.<rawBody>".
  let signature = signatureHeader;
  let signedPayload = rawBody;
  let timestampSeconds: number | null = null;
  const composite = signatureHeader.match(/t=(\d+)\s*,\s*v1=([a-fA-F0-9]+)/);
  if (composite) {
    timestampSeconds = Number(composite[1]);
    signature = composite[2];
    signedPayload = `${composite[1]}.${rawBody}`;
  } else if (timestampHeader && /^\d+$/.test(timestampHeader.trim())) {
    timestampSeconds = Number(timestampHeader.trim());
  }
  // Strip optional "sha256=" prefix (GitHub-style).
  signature = signature.replace(/^sha256=/, "").trim();

  if (!verifyHmacHex(opts.secret, signedPayload, signature)) {
    throw new AppError(401, "INVALID_SIGNATURE", "Invalid webhook signature");
  }

  if (timestampSeconds !== null) {
    const now = Math.floor(Date.now() / 1000);
    if (Math.abs(now - timestampSeconds) > TIMESTAMP_TOLERANCE_SECONDS) {
      throw new AppError(401, "STALE_TIMESTAMP", "Webhook timestamp outside tolerance window");
    }
  } else if (opts.requireTimestamp) {
    throw new AppError(401, "STALE_TIMESTAMP", "Missing webhook timestamp");
  }

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(rawBody) as Record<string, unknown>;
  } catch {
    throw new AppError(400, "INVALID_JSON", "Invalid webhook JSON payload");
  }

  // Distributed idempotency: first delivery wins for 24h.
  const isNew = await setNx(`webhook:${opts.scope}:${idempotencyKey}`, "1", 24 * 60 * 60);

  return { rawBody, payload, idempotencyKey, duplicate: !isNew };
}

/** Constant-time string comparison helper for API keys. */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  try {
    return timingSafeEqual(ab, bb);
  } catch {
    return false;
  }
}
