import { createHmac, timingSafeEqual } from "node:crypto";

export type MediaSessionClaims = {
  businessId: string;
  callId?: string;
  externalCallId?: string;
  exp: number;
};

const PREFIX = "v1";

function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function sign(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

/** Create a short-lived media credential bound to one tenant/call. */
export function createMediaSessionToken(
  secret: string,
  claims: Omit<MediaSessionClaims, "exp"> & { ttlSeconds?: number },
): string {
  const payload = encode({
    businessId: claims.businessId,
    callId: claims.callId,
    externalCallId: claims.externalCallId,
    exp: Math.floor(Date.now() / 1000) + (claims.ttlSeconds ?? 120),
  });
  return `${PREFIX}.${payload}.${sign(payload, secret)}`;
}

/** Verify signature, expiry and call/tenant binding. */
export function verifyMediaSessionToken(
  token: string,
  secret: string,
  expected: { businessId: string; callId?: string; externalCallId?: string },
): MediaSessionClaims | null {
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== PREFIX) return null;
  const [, payload, signature] = parts;
  if (!payload || !signature) return null;
  const expectedSignature = sign(payload, secret);
  const a = Buffer.from(signature, "utf8");
  const b = Buffer.from(expectedSignature, "utf8");
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as MediaSessionClaims;
    if (!claims || claims.businessId !== expected.businessId) return null;
    if (claims.exp <= Math.floor(Date.now() / 1000)) return null;
    if (expected.callId && claims.callId !== expected.callId) return null;
    if (expected.externalCallId && claims.externalCallId !== expected.externalCallId) return null;
    return claims;
  } catch {
    return null;
  }
}
