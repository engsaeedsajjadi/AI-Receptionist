import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { auditLogs, businesses } from "@/db/schema";
import { getEnv } from "@/lib/env";
import { AppError } from "@/lib/errors";
import { assertTenantScope, requestContext } from "@/lib/request-context";

/**
 * Voice-cloning safety (P2).
 *
 * A tenant-configurable voice id is a synthesis input: pointing it at a cloned
 * voice is a consent-sensitive capability, not a styling option. This module is
 * the single gate for it, and it **fails closed**:
 *
 *  1. a small set of publisher/default voices is always allowed;
 *  2. an operator allowlist (`TTS_ALLOWED_VOICE_IDS`) can widen that set;
 *  3. anything else requires **both** the platform opt-in
 *     (`VOICE_CLONING_ENABLED=true`) **and** a consent record stored on the
 *     tenant (subject + reference + who recorded it + when);
 *  4. the guard runs at configuration time (agent create/update) *and* at
 *     synthesis time, so a pre-existing cloned voice id cannot be used after the
 *     platform opt-in is switched off or consent is revoked.
 */

export const DEFAULT_VOICES = new Set(["", "default", "fa", "fa-default", "alloy", "nova", "shimmer"]);

export const VoiceCloningConsentSchema = z.object({
  /** Who consented (person/company) — never inferred. */
  subject: z.string().trim().min(2).max(200),
  /** Contract, email thread or document reference that proves consent. */
  reference: z.string().trim().min(3).max(200),
  /** The exact voice ids this consent covers — consent never grants a blanket. */
  voiceIds: z.array(z.string().trim().min(1).max(100)).min(1).max(20),
  recordedByUserId: z.string().uuid().optional(),
  recordedAt: z.string().datetime(),
});
export type VoiceCloningConsent = z.infer<typeof VoiceCloningConsentSchema>;

export function allowedVoiceIds(): Set<string> {
  let configured = "";
  try {
    configured = getEnv().TTS_ALLOWED_VOICE_IDS;
  } catch {
    configured = process.env.TTS_ALLOWED_VOICE_IDS ?? "";
  }
  return new Set(configured.split(",").map((v) => v.trim()).filter(Boolean));
}

export function isCloningEnabled(): boolean {
  try {
    return getEnv().VOICE_CLONING_ENABLED;
  } catch {
    return process.env.VOICE_CLONING_ENABLED === "true";
  }
}

export function readConsent(settings: Record<string, unknown> | null | undefined): VoiceCloningConsent | null {
  const parsed = VoiceCloningConsentSchema.safeParse(settings?.voice_cloning_consent);
  return parsed.success ? parsed.data : null;
}

/**
 * Throws `VOICE_CONSENT_REQUIRED` (403) unless the voice id is a publisher voice
 * or the tenant has both the platform opt-in and recorded consent.
 */
export async function assertVoiceAllowed(input: { businessId: string; voiceId?: string | null }): Promise<void> {
  const voiceId = (input.voiceId ?? "").trim();
  if (!voiceId || DEFAULT_VOICES.has(voiceId) || allowedVoiceIds().has(voiceId)) return;
  assertTenantScope(input.businessId);

  const [row] = await db
    .select({ settings: businesses.settings, isActive: businesses.isActive })
    .from(businesses)
    .where(eq(businesses.id, input.businessId))
    .limit(1);
  if (!row) throw new AppError(404, "BUSINESS_NOT_FOUND", "Business not found");
  const consent = readConsent(row.settings as Record<string, unknown>);
  if (!isCloningEnabled()) {
    throw new AppError(403, "VOICE_CONSENT_REQUIRED", "Voice cloning is disabled for this platform");
  }
  if (!consent || !consent.voiceIds.includes(voiceId)) {
    throw new AppError(
      403,
      "VOICE_CONSENT_REQUIRED",
      "This voice id is not an approved publisher voice; record voice-cloning consent for this voice id before using it",
    );
  }
}

/** Records consent (ADMIN action, audited). Refuses to overwrite silently. */
export async function recordVoiceCloningConsent(input: {
  businessId: string;
  userId: string;
  subject: string;
  reference: string;
  voiceIds: string[];
}): Promise<VoiceCloningConsent> {
  assertTenantScope(input.businessId);
  const consent: VoiceCloningConsent = {
    subject: input.subject.trim(),
    reference: input.reference.trim(),
    voiceIds: [...new Set(input.voiceIds.map((voiceId) => voiceId.trim()).filter(Boolean))],
    recordedByUserId: input.userId,
    recordedAt: new Date().toISOString(),
  };
  if (consent.voiceIds.length === 0) throw new AppError(400, "VALIDATION_ERROR", "At least one voice id is required");
  await db.transaction(async (tx) => {
    const [row] = await tx
      .select({ settings: businesses.settings })
      .from(businesses)
      .where(eq(businesses.id, input.businessId))
      .for("update")
      .limit(1);
    if (!row) throw new AppError(404, "BUSINESS_NOT_FOUND", "Business not found");
    const settings = { ...((row.settings as Record<string, unknown>) ?? {}), voice_cloning_consent: consent };
    await tx.update(businesses).set({ settings, updatedAt: new Date() }).where(eq(businesses.id, input.businessId));
    await tx.insert(auditLogs).values({
      businessId: input.businessId,
      actorType: "user",
      actorId: input.userId,
      action: "voice.consent_recorded",
      entityType: "business",
      entityId: input.businessId,
      requestId: requestContext.getStore()?.requestId,
      // The consent text itself is not PII-sensitive but the subject name is:
      // store the reference only in the audit metadata.
      metadata: { reference: consent.reference, voiceIds: consent.voiceIds },
    });
  });
  return consent;
}

/** Revokes consent. Any cloned voice id becomes unusable immediately. */
export async function revokeVoiceCloningConsent(input: { businessId: string; userId: string }): Promise<void> {
  assertTenantScope(input.businessId);
  await db.transaction(async (tx) => {
    const [row] = await tx
      .select({ settings: businesses.settings })
      .from(businesses)
      .where(eq(businesses.id, input.businessId))
      .for("update")
      .limit(1);
    if (!row) throw new AppError(404, "BUSINESS_NOT_FOUND", "Business not found");
    const settings = { ...((row.settings as Record<string, unknown>) ?? {}) };
    const had = Boolean(settings.voice_cloning_consent);
    delete settings.voice_cloning_consent;
    await tx.update(businesses).set({ settings, updatedAt: new Date() }).where(eq(businesses.id, input.businessId));
    if (had) {
      await tx.insert(auditLogs).values({
        businessId: input.businessId,
        actorType: "user",
        actorId: input.userId,
        action: "voice.consent_revoked",
        entityType: "business",
        entityId: input.businessId,
        requestId: requestContext.getStore()?.requestId,
        metadata: {},
      });
    }
  });
}
