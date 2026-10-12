import { createHmac, timingSafeEqual } from "node:crypto";
import { NextRequest } from "next/server";
import { AppError } from "@/lib/errors";
import { setNx } from "@/lib/redis";

const MAX_WEBHOOK_BODY_BYTES = 1024 * 1024; // 1 MB
const TIMESTAMP_TOLERANCE_SECONDS = 5 * 60; // 5 minutes

export function computeHmacHex(secret: string, payload: string | Buffer): string {
  const hmac = createHmac("sha256", secret);
  if (typeof payload === "string") hmac.update(payload, "utf8");
  else hmac.update(payload);
  return hmac.digest("hex");
}

export function verifyHmacHex(secret: string, payload: string | Buffer, signature: string): boolean {
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
};

function getHeader(req: NextRequest, names: string[]): string | null {
  for (const name of names) {
    const value = req.headers.get(name);
    if (value) return value;
  }
  return null;
}

/**
 * Verify an inbound webhook's authenticity:
 * - request size limit
 * - HMAC-SHA256 signature (timing-safe)
 * - timestamp freshness (replay protection) when a timestamp header is present
 *
 * This function does NOT claim idempotency. Callers must validate the payload
 * (zod) FIRST and then call `claimWebhookIdempotency`, so that invalid
 * payloads can never burn an idempotency key and mask the real error on
 * retry.
 *
 * Accepted headers:
 * - signature: x-webhook-signature | x-signature | stripe-style "t=...,v1=..."
 * - idempotency: x-idempotency-key | idempotency-key
 * - timestamp: x-webhook-timestamp | x-timestamp
 */
export async function verifyWebhookRequest(
  req: NextRequest,
  opts: {
    secret: string;
    previousSecrets?: string[];
    requireSignedTimestamp?: boolean;
    scope: string;
    requireTimestamp?: boolean;
    /** Skip JSON parsing (e.g. multipart audio uploads); payload is {} and the route parses rawBody itself. */
    parseJson?: boolean;
    /** Override the default 1 MB body cap (audio uploads need more). */
    maxBytes?: number;
  },
): Promise<WebhookVerification> {
  // Clone before reading so routes can still consume the body (formData()).
  // Read BYTES (not text): binary multipart audio must be HMAC-verified and
  // measured exactly — UTF-8 decoding would corrupt non-text bytes.
  const maxBytes = opts.maxBytes ?? MAX_WEBHOOK_BODY_BYTES;
  const reader = req.clone().body?.getReader();
  const buffers: Buffer[] = [];
  let total = 0;
  if (reader) {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) {
          void reader.cancel().catch(() => undefined);
          throw new AppError(413, "PAYLOAD_TOO_LARGE", "Webhook payload too large");
        }
        buffers.push(Buffer.from(value));
      }
    } finally { reader.releaseLock(); }
  }
  const rawBytes = Buffer.concat(buffers);
  if (rawBytes.length > maxBytes) {
    throw new AppError(413, "PAYLOAD_TOO_LARGE", "Webhook payload too large");
  }
  const rawBody = rawBytes.toString("utf8");

  const signatureHeader = getHeader(req, ["x-webhook-signature", "x-signature", "x-hub-signature-256"]);
  const idempotencyKey = getHeader(req, ["x-idempotency-key", "idempotency-key"]);
  const timestampHeader = getHeader(req, ["x-webhook-timestamp", "x-timestamp"]);

  if (!signatureHeader) throw new AppError(401, "INVALID_SIGNATURE", "Missing webhook signature");
  if (!idempotencyKey) throw new AppError(401, "UNAUTHORIZED", "Missing idempotency key");

  // Support "t=<ts>,v1=<hex>" style signatures; signed content is "<ts>." + raw bytes.
  let signature = signatureHeader;
  let signedPayload: string | Buffer = rawBytes;
  let timestampSeconds: number | null = null;
  const composite = signatureHeader.match(/^t=(\d+)\s*,\s*v1=([a-fA-F0-9]{64})$/);
  if (composite) {
    timestampSeconds = Number(composite[1]);
    signature = composite[2];
    signedPayload = Buffer.concat([Buffer.from(`${composite[1]}.`, "utf8"), rawBytes]);
  } else if (timestampHeader && /^\d+$/.test(timestampHeader.trim())) {
    timestampSeconds = Number(timestampHeader.trim());
  }
  // Strip optional "sha256=" prefix (GitHub-style).
  signature = signature.replace(/^sha256=/, "").trim();

  const requireSigned = opts.requireSignedTimestamp ?? process.env.NODE_ENV === "production";
  if (requireSigned && !composite)
    throw new AppError(401, "STALE_TIMESTAMP", "Signed timestamp required: t=<seconds>,v1=<signature>");
  const keys = [opts.secret, ...(opts.previousSecrets ?? [])].filter(Boolean);
  if (!keys.some((key) => verifyHmacHex(key, signedPayload, signature))) {
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

  let payload: Record<string, unknown> = {};
  if (opts.parseJson !== false) {
    try {
      payload = JSON.parse(rawBody) as Record<string, unknown>;
    } catch {
      throw new AppError(400, "INVALID_JSON", "Invalid webhook JSON payload");
    }
  }

  return { rawBody, payload, idempotencyKey };
}

/**
 * Claim distributed webhook idempotency (Redis-backed, 24h window).
 * Returns true for the first delivery (caller proceeds), false for a
 * redelivery (caller returns a deterministic duplicate response).
 * MUST be called only after the payload passed schema validation.
 */
export async function claimWebhookIdempotency(scope: string, idempotencyKey: string): Promise<boolean> {
  return setNx(`webhook:${scope}:${idempotencyKey}`, "1", 24 * 60 * 60);
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
