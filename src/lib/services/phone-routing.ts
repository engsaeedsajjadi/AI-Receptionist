import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { businesses } from "@/db/schema";
import { normalizePhone } from "@/lib/normalization";

/**
 * Deterministic called-number -> business routing (Phase 3 §6).
 *
 * The webhook HMAC authenticates the GATEWAY, not the tenant: a gateway
 * holding the shared secret could assert any `business_id`. Routing by the
 * dialled number closes that hole — a call enters a tenant's agent only via
 * a number that tenant configured.
 *
 * Resolution order (first match wins, fail closed):
 *   1. `businesses.voice_number` — dedicated inbound voice number, UNIQUE
 *      by schema, active businesses only. This is THE deterministic route.
 *   2. `businesses.phone` — general contact number, ONLY when exactly one
 *      active business matches. Two matches => AMBIGUOUS (reject, never guess).
 *   3. No match => UNROUTABLE.
 *
 * Inactive businesses never route. Numbers are normalised with the shared
 * phone normaliser (+98/0098/09, Persian/Arabic digits — §25), so the same
 * dialled number routes identically however the gateway formats it.
 */

export type CalledNumberRoute =
  | { ok: true; businessId: string; matchedNumber: string; via: "voice_number" | "phone" }
  | { ok: false; reason: "UNROUTABLE_NUMBER" | "AMBIGUOUS_NUMBER"; normalized: string | null };

export async function resolveBusinessByCalledNumber(calledNumber: string): Promise<CalledNumberRoute> {
  const normalized = normalizePhone(calledNumber);
  if (!normalized) return { ok: false, reason: "UNROUTABLE_NUMBER", normalized: null };

  const [byVoiceNumber] = await db
    .select({ id: businesses.id })
    .from(businesses)
    .where(and(eq(businesses.voiceNumber, normalized), eq(businesses.isActive, true)))
    .limit(1);
  if (byVoiceNumber) {
    return { ok: true, businessId: byVoiceNumber.id, matchedNumber: normalized, via: "voice_number" };
  }

  const byPhone = await db
    .select({ id: businesses.id })
    .from(businesses)
    .where(and(eq(businesses.phone, normalized), eq(businesses.isActive, true)))
    .limit(2);
  if (byPhone.length === 1) {
    return { ok: true, businessId: byPhone[0].id, matchedNumber: normalized, via: "phone" };
  }
  if (byPhone.length > 1) {
    return { ok: false, reason: "AMBIGUOUS_NUMBER", normalized };
  }
  return { ok: false, reason: "UNROUTABLE_NUMBER", normalized };
}
