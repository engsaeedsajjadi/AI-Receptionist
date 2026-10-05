import { registerInboundCall } from "@/lib/services/call-admission";
import { NextRequest } from "next/server";
import { z } from "zod";
import { ok, parseWith } from "@/lib/api";
import { env, getEnv } from "@/lib/env";
import { logInfo, logWarn } from "@/lib/logger";
import { getVoiceProvider } from "@/lib/providers/voice";
import { normalizePersianText, normalizePhone } from "@/lib/normalization";
import { enforceRateLimit } from "@/lib/rate-limit";
import { verifyWebhookRequest } from "@/lib/security";
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
    const { callId, created, settings } = await registerInboundCall({
      businessId: body.business_id, externalCallId: body.external_call_id,
      phoneNumber: normalizePhone(body.phone_number) ?? normalizePersianText(body.phone_number),
      agentId: body.agent_id, direction: body.direction ?? "INBOUND", metadata: body.metadata ?? {}, idempotencyKey,
    });

    // Media bootstrap (winning insert only): answer the call and ask the
    // gateway to stream audio to the media sidecar. Best-effort — the call
    // RECORD is the source of truth and is already persisted — but the
    // outcome is reported honestly in the response (never a silent fake).
    const media = await bootstrapMedia({
      businessSettings: settings,
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
