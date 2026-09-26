import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Per-call media tokens (P0-1).
 *
 * The static `VOICE_MEDIA_TOKEN` authenticates the GATEWAY, but the app
 * never sends it anywhere — so a gateway receiving `startStream` had no
 * credential for the media `start` frame and every call died with
 * UNAUTHORIZED. The fix: `call-started` issues a short-lived token bound
 * to THIS call, `startStream` delivers it to the gateway, and the media
 * sidecar verifies it and binds it to the resolved call row.
 *
 * Format: `v1.<base64url(payload)>.<hex-hmac-sha256>` where the HMAC key
 * is `VOICE_MEDIA_TOKEN` and payload is
 * `{ b: businessId, c: callId, x: externalCallId|null, exp: epochMs, n: nonce }`.
 * Tokens are bearer credentials: short TTL (VOICE_MEDIA_TOKEN_TTL_SECONDS),
 * single purpose (media `start` only), never logged, never returned in
 * webhook responses.
 */

const VERSION = "v1";

export type MediaTokenClaims = {
  businessId: string;
  callId: string;
  externalCallId: string | null;
  /** Expiry, epoch milliseconds. */
  exp: number;
  nonce: string;
};

export type MediaTokenError = "MALFORMED" | "BAD_SIGNATURE" | "EXPIRED";

export class InvalidMediaToken extends Error {
  readonly reason: MediaTokenError;
  constructor(reason: MediaTokenError, message: string) {
    super(message);
    this.name = "InvalidMediaToken";
    this.reason = reason;
  }
}

function b64urlEncode(input: Buffer): string {
  return input.toString("base64url");
}

function b64urlDecode(input: string): Buffer {
  return Buffer.from(input, "base64url");
}

function sign(secret: string, data: string): string {
  return createHmac("sha256", secret).update(data, "utf8").digest("hex");
}

export function issueMediaToken(input: {
  businessId: string;
  callId: string;
  externalCallId?: string | null;
  ttlSeconds: number;
  secret: string;
  nowMs?: number;
}): string {
  if (!input.secret) throw new Error("Media token secret is not configured");
  if (!Number.isFinite(input.ttlSeconds) || input.ttlSeconds <= 0) {
    throw new Error("Media token TTL must be positive");
  }
  const now = input.nowMs ?? Date.now();
  const payload: MediaTokenClaims = {
    businessId: input.businessId,
    callId: input.callId,
    externalCallId: input.externalCallId ?? null,
    exp: now + input.ttlSeconds * 1000,
    nonce: randomBytes(16).toString("hex"),
  };
  const body = b64urlEncode(Buffer.from(JSON.stringify(payload), "utf8"));
  return `${VERSION}.${body}.${sign(input.secret, `${VERSION}.${body}`)}`;
}

function safeEqualHex(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length || ab.length === 0) return false;
  try {
    return timingSafeEqual(ab, bb);
  } catch {
    return false;
  }
}

export function verifyMediaToken(token: string, secret: string, nowMs = Date.now()): MediaTokenClaims {
  const fail = (reason: MediaTokenError, message: string): never => {
    throw new InvalidMediaToken(reason, message);
  };
  if (!secret) return fail("BAD_SIGNATURE", "Media token secret is not configured");
  const parts = String(token ?? "").split(".");
  if (parts.length !== 3 || parts[0] !== VERSION || !parts[1] || !parts[2]) {
    return fail("MALFORMED", "Malformed media token");
  }
  if (!safeEqualHex(parts[2], sign(secret, `${parts[0]}.${parts[1]}`))) {
    return fail("BAD_SIGNATURE", "Invalid media token signature");
  }
  let claims: MediaTokenClaims;
  try {
    claims = JSON.parse(b64urlDecode(parts[1]).toString("utf8")) as MediaTokenClaims;
  } catch {
    return fail("MALFORMED", "Malformed media token payload");
  }
  if (!claims || typeof claims.businessId !== "string" || typeof claims.callId !== "string") {
    return fail("MALFORMED", "Media token is missing call binding");
  }
  if (typeof claims.exp !== "number" || claims.exp <= nowMs) {
    return fail("EXPIRED", "Media token has expired");
  }
  return {
    businessId: claims.businessId,
    callId: claims.callId,
    externalCallId: typeof claims.externalCallId === "string" ? claims.externalCallId : null,
    exp: claims.exp,
    nonce: typeof claims.nonce === "string" ? claims.nonce : "",
  };
}
