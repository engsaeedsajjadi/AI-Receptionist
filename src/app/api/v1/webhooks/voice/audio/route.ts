import { NextRequest } from "next/server";
import { z } from "zod";
import { and, desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { calls } from "@/db/schema";
import { ok, parseWith } from "@/lib/api";
import { AppError } from "@/lib/errors";
import { env, getEnv } from "@/lib/env";
import { logInfo, logWarn } from "@/lib/logger";
import { enforceRateLimit } from "@/lib/rate-limit";
import { claimWebhookIdempotency, verifyWebhookRequest } from "@/lib/security";
import { withApiHandling } from "@/lib/server-core";
import { getVoiceProvider } from "@/lib/providers/voice";
import { clearTurnMarker, runVoiceTurn } from "@/lib/voice/turn";

const MAX_AUDIO_BYTES = 30 * 1024 * 1024; // matches nginx client_max_body_size

const jsonSchema = z.object({
  business_id: z.string().uuid(),
  external_call_id: z.string().min(1).max(255),
  transcript: z.string().min(1).max(20000),
  agent_id: z.string().uuid().optional(),
  event_id: z.string().min(1).max(255).optional(),
  is_final: z.boolean().default(true),
  language: z.string().max(20).optional(),
  voice: z.string().max(100).optional(),
});

const formSchema = z.object({
  business_id: z.string().uuid(),
  external_call_id: z.string().min(1).max(255),
  agent_id: z.string().uuid().optional(),
  event_id: z.string().min(1).max(255).optional(),
  is_final: z
    .string()
    .optional()
    .transform((v) => v !== "false"),
  language: z.string().max(20).optional(),
  voice: z.string().max(100).optional(),
});

type TurnParams = {
  businessId: string;
  externalCallId: string;
  agentId?: string;
  eventId?: string;
  language?: string;
  voice?: string;
  audio?: Buffer;
  audioMimeType?: string;
  transcript?: string;
};

async function parseMultipart(req: NextRequest): Promise<{ params: TurnParams; isFinal: boolean }> {
  const form = await req.formData();
  const get = (k: string): string | undefined => {
    const v = form.get(k);
    return typeof v === "string" ? v : undefined;
  };
  const body = parseWith(formSchema, {
    business_id: get("business_id"),
    external_call_id: get("external_call_id"),
    agent_id: get("agent_id"),
    event_id: get("event_id"),
    is_final: get("is_final"),
    language: get("language"),
    voice: get("voice"),
  });
  const file = form.get("audio");
  if (!(file instanceof File)) throw new AppError(400, "INVALID_PAYLOAD", "Missing audio field");
  const buffer = Buffer.from(await file.arrayBuffer());
  if (buffer.length === 0) throw new AppError(400, "INVALID_PAYLOAD", "Empty audio payload");
  if (buffer.length > MAX_AUDIO_BYTES) throw new AppError(413, "PAYLOAD_TOO_LARGE", "Audio exceeds 30 MB limit");
  return {
    params: {
      businessId: body.business_id,
      externalCallId: body.external_call_id,
      agentId: body.agent_id,
      eventId: body.event_id,
      language: body.language,
      voice: body.voice,
      audio: buffer,
      audioMimeType: file.type || undefined,
    },
    isFinal: body.is_final,
  };
}

/**
 * Full voice-turn webhook for telephony gateways.
 *
 * Two topologies, one endpoint:
 * - multipart/form-data with an `audio` file → server-side STT → agent → TTS
 * - application/json with `transcript` → gateway-side STT → agent → TTS
 *
 * The reply audio is archived and played back through the voice provider
 * (URL playback, or gateway-side TTS from the spoken text when archival or
 * URL playback is unavailable). Partial (is_final=false) deliveries are
 * acknowledged without running a turn.
 */
export async function POST(req: NextRequest) {
  return withApiHandling(async (rid) => {
    await enforceRateLimit(req, "publicWebhook");
    const contentType = req.headers.get("content-type") ?? "";
    const isMultipart = contentType.includes("multipart/form-data");

    const { payload, idempotencyKey } = await verifyWebhookRequest(req, {
      secret: env.webhookSecret,
      previousSecrets: env.previousWebhookSecrets,
      scope: "voice:audio",
      parseJson: !isMultipart,
      maxBytes: isMultipart ? MAX_AUDIO_BYTES + 1024 * 1024 : undefined,
    });

    let params: TurnParams;
    let isFinal = true;
    if (isMultipart) {
      ({ params, isFinal } = await parseMultipart(req));
    } else {
      const body = parseWith(jsonSchema, payload);
      params = {
        businessId: body.business_id,
        externalCallId: body.external_call_id,
        agentId: body.agent_id,
        eventId: body.event_id,
        language: body.language,
        voice: body.voice,
        transcript: body.transcript,
      };
      isFinal = body.is_final;
    }

    if (!(await claimWebhookIdempotency("voice:audio", idempotencyKey))) {
      return ok({ ok: true, duplicate: true });
    }

    if (!isFinal) return ok({ ok: true, partial: true });

    const [call] = await db
      .select()
      .from(calls)
      .where(and(eq(calls.businessId, params.businessId), eq(calls.externalCallId, params.externalCallId)))
      .orderBy(desc(calls.createdAt))
      .limit(1);
    if (!call) throw new AppError(404, "CALL_NOT_FOUND", "Call not found");

    const language = params.language ?? getEnv().VOICE_DEFAULT_LANGUAGE;
    const turn = await runVoiceTurn({
      businessId: params.businessId,
      agentId: params.agentId ?? call.agentId ?? undefined,
      callId: call.id,
      externalCallId: params.externalCallId,
      audio: params.audio,
      audioMimeType: params.audioMimeType,
      transcript: params.transcript,
      eventId: params.eventId,
      language,
      voice: params.voice,
      requestId: rid,
      actor: "voice-webhook",
    });

    if (turn.duplicate) return ok({ ok: true, duplicate: true });
    if (!turn.heard) return ok({ ok: true, heard: false, transcript: "" });

    // Playback: prefer archived-audio URL; fall back to gateway-side TTS.
    const voice = getVoiceProvider();
    const mode = turn.audioUrl ? "audio-url" : "gateway-tts";
    try {
      if (turn.audioUrl) {
        await voice.playAudio(params.externalCallId, { audioUrl: turn.audioUrl, language }, { requestId: rid });
      } else {
        await voice.playAudio(params.externalCallId, { text: turn.spokenText, language }, { requestId: rid });
      }
    } catch (err) {
      // Playback failed: clear the completion marker so a retry recomputes
      // (or the gateway plays turn.audioUrl itself from this response).
      if (params.eventId) await clearTurnMarker(call.id, params.eventId);
      logWarn("Voice playback failed", {
        requestId: rid,
        businessId: params.businessId,
        callId: call.id,
        operation: "voice.playback",
        status: "error",
        error: err instanceof Error ? err.message : String(err),
      });
      throw new AppError(502, "VOICE_ERROR", "Reply computed but playback failed", {
        transcript: turn.transcript,
        reply: turn.reply,
        audioUrl: turn.audioUrl,
        latencyMs: turn.latencyMs,
      });
    }

    logInfo("Voice turn served", {
      requestId: rid,
      businessId: params.businessId,
      callId: call.id,
      operation: "voice.audio",
      durationMs: turn.latencyMs.total,
      status: "ok",
    });

    return ok({
      ok: true,
      transcript: turn.transcript,
      reply: turn.reply,
      audioUrl: turn.audioUrl,
      audioStored: turn.audioStored,
      playback: mode,
      toolCalls: turn.toolCalls,
      usage: turn.usage,
      latencyMs: turn.latencyMs,
    });
  });
}
