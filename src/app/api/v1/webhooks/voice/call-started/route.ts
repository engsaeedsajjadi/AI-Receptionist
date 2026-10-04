import { NextRequest } from "next/server";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { businesses, calls, usageRecords } from "@/db/schema";
import { ok, parseWith } from "@/lib/api";
import { AppError } from "@/lib/errors";
import { env, getEnv } from "@/lib/env";
import { logInfo, logWarn } from "@/lib/logger";
import { getVoiceProvider } from "@/lib/providers/voice";
import { normalizePersianText, normalizePhone } from "@/lib/normalization";
import { enforceRateLimit } from "@/lib/rate-limit";
import { claimWebhookIdempotency, verifyWebhookRequest } from "@/lib/security";
import { withApiHandling } from "@/lib/server-core";
import { createMediaSessionToken } from "@/lib/voice/media-auth";

const payloadSchema = z.object({
  business_id: z.string().uuid(),
  external_call_id: z.string().min(1).max(255),
  phone_number: z.string().min(1).max(30),
  agent_id: z.string().uuid().optional(),
  direction: z.enum(["INBOUND", "OUTBOUND"]).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export async function POST(req: NextRequest) {
  return withApiHandling(async (rid) => {
    await enforceRateLimit(req, "publicWebhook");
    // 1. Authenticate → 2. validate → 3. claim idempotency (invalid payloads
    // must never burn a key).
    const { payload, idempotencyKey } = await verifyWebhookRequest(req, {
      secret: env.webhookSecret,
      previousSecrets: env.previousWebhookSecrets,
      scope: "voice:call-started",
    });
    const body = parseWith(payloadSchema, payload);
    if (!(await claimWebhookIdempotency("voice:call-started", idempotencyKey))) {
      return ok({ ok: true, duplicate: true });
    }

    const [business] = await db
      .select({ id: businesses.id, settings: businesses.settings })
      .from(businesses)
      .where(eq(businesses.id, body.business_id))
      .limit(1);
    if (!business) throw new AppError(404, "BUSINESS_NOT_FOUND", "Business not found");

    const phoneNumber = normalizePhone(body.phone_number) ?? normalizePersianText(body.phone_number);

    // Idempotent insert: concurrent duplicate deliveries (different header
    // keys) collapse on the (businessId, externalCallId) unique constraint.
    // Usage is recorded exactly once — only for the winning insert.
    const [inserted] = await db
      .insert(calls)
      .values({
        businessId: body.business_id,
        externalCallId: body.external_call_id,
        phoneNumber,
        agentId: body.agent_id ?? null,
        direction: body.direction ?? "INBOUND",
        status: "RINGING",
        startedAt: new Date(),
        metadata: { ...(body.metadata ?? {}), idempotencyKey },
      })
      .onConflictDoNothing({ target: [calls.businessId, calls.externalCallId] })
      .returning({ id: calls.id });

    let callId = inserted?.id ?? null;
    const created = Boolean(inserted);
    if (!inserted) {
      const [existing] = await db
        .select({ id: calls.id })
        .from(calls)
        .where(and(eq(calls.businessId, body.business_id), eq(calls.externalCallId, body.external_call_id)))
        .limit(1);
      callId = existing?.id ?? null;
    }
    if (!callId) {
      // Conflicted on insert but the row vanished — should never happen.
      throw new AppError(500, "INTERNAL_ERROR", "Call registration failed");
    }

    if (created) {
      await db
        .insert(usageRecords)
        .values({
          businessId: body.business_id,
          type: "calls",
          quantity: "1",
          unit: "count",
          idempotencyKey: `call-started:${callId}`,
          metadata: { event: "call_started", callId, externalCallId: body.external_call_id },
        })
        .onConflictDoNothing({ target: [usageRecords.businessId, usageRecords.idempotencyKey] });
    }

    // Media bootstrap (winning insert only): answer the call and ask the
    // gateway to stream audio to the media sidecar. Best-effort — the call
    // RECORD is the source of truth and is already persisted — but the
    // outcome is reported honestly in the response (never a silent fake).
    const media = await bootstrapMedia({
      businessSettings: (business.settings as Record<string, unknown>) ?? {},
      externalCallId: body.external_call_id,
      callId,
      businessId: body.business_id,
      requestId: rid,
      skip: !created,
    });

    logInfo("Inbound call started", {
      requestId: rid,
      businessId: body.business_id,
      callId,
      operation: "voice.call-started",
      status: created ? "ok" : "duplicate",
    });

    return ok({ ok: true, callId, duplicate: !created, media });
  });
}

export type MediaBootstrap = {
  attempted: boolean;
  answered: boolean;
  streaming: boolean;
  reason?: string;
};

/**
 * Answer + start media streaming for a newly recorded call.
 * Skipped (attempted:false) for duplicates, when auto-answer is disabled
 * (VOICE_AUTO_ANSWER=false or per-business settings.voice.autoAnswer=false),
 * or when no telephony provider is configured.
 */
export async function bootstrapMedia(input: {
  businessSettings: Record<string, unknown>;
  externalCallId: string;
  callId: string;
  businessId: string;
  requestId: string;
  skip: boolean;
}): Promise<MediaBootstrap> {
  if (input.skip) return { attempted: false, answered: false, streaming: false, reason: "duplicate" };
  const e = getEnv();
  if (e.VOICE_PROVIDER !== "generic") {
    return { attempted: false, answered: false, streaming: false, reason: "provider_not_configured" };
  }
  const voiceSettings = (input.businessSettings.voice as Record<string, unknown> | undefined) ?? {};
  const autoAnswer =
    typeof voiceSettings.autoAnswer === "boolean" ? voiceSettings.autoAnswer : e.VOICE_AUTO_ANSWER;
  if (!autoAnswer) {
    return { attempted: false, answered: false, streaming: false, reason: "auto_answer_disabled" };
  }

  const voice = getVoiceProvider();
  try {
    await voice.answerCall(input.externalCallId, { requestId: input.requestId });
  } catch (err) {
    logWarn("Voice answer failed (call record kept)", {
      requestId: input.requestId,
      operation: "voice.answer",
      status: "error",
      error: err instanceof Error ? err.message : String(err),
    });
    return { attempted: true, answered: false, streaming: false, reason: "answer_failed" };
  }

  if (!e.VOICE_MEDIA_PUBLIC_URL) {
    return { attempted: true, answered: true, streaming: false, reason: "media_url_not_configured" };
  }
  try {
    await voice.startStream(input.externalCallId, {
      websocketUrl: e.VOICE_MEDIA_PUBLIC_URL,
      requestId: input.requestId,
      businessId: input.businessId,
      callId: input.callId,
      mediaToken: createMediaSessionToken(e.VOICE_MEDIA_TOKEN, {
        businessId: input.businessId,
        callId: input.callId,
        externalCallId: input.externalCallId,
        ttlSeconds: 120,
      }),
      codec: e.VOICE_MEDIA_CODEC,
      sampleRate: e.VOICE_MEDIA_SAMPLE_RATE,
    });
    return { attempted: true, answered: true, streaming: true };
  } catch (err) {
    logWarn("Voice stream start failed (call answered, no media)", {
      requestId: input.requestId,
      operation: "voice.stream.start",
      status: "error",
      error: err instanceof Error ? err.message : String(err),
    });
    return { attempted: true, answered: true, streaming: false, reason: "stream_start_failed" };
  }
}
