import { createMediaSessionToken } from "@/lib/voice/media-auth";

/** Test helper: mint a valid media session token for the given claims. */
export function acceptMediaSessionToken(
  secret: string,
  claims: { businessId: string; callId?: string; externalCallId?: string; ttlSeconds?: number },
): string {
  return createMediaSessionToken(secret, claims);
}
