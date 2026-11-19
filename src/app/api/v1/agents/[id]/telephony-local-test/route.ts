import { NextRequest } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { agents } from "@/db/schema";
import { AppError } from "@/lib/errors";
import { ok } from "@/lib/api";
import { getAuthContext } from "@/lib/auth";
import { withApiHandling } from "@/lib/server-core";
import { runVoiceTurn } from "@/lib/voice/turn";
import { PiperTTSProvider, parsePiperVoice, parsePiperStyle } from "@/lib/providers/piper-tts";
import { PocketTTSProvider } from "@/lib/providers/pocket-tts";
import { pcm16ToWav } from "@/lib/voice/audio";
import { assertIsolatedLab } from "@/lib/voice/lab-guard";
import { FasterWhisperSTTProvider } from "@/lib/providers/faster-whisper-stt";
import { appendLabTurn, loadLabHistory, parseLabSessionId } from "@/lib/voice/lab-conversation";
import { assessLocalTelephonyInput, assessLocalAgentReadiness, encodeLocalTelephonyOutput, validateLocalHighQualitySttWav } from "@/lib/voice/local-telephony";

// DEVELOPER LAB ONLY — not Twilio/PSTN, never a production endpoint (see lab-guard).

/** Fixed, server-owned wording; the client can never choose synthesized text. */
const LAB_FILLER_TEXT = "بله، یک لحظه لطفاً.";

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return withApiHandling(async () => {
    assertIsolatedLab();
    const auth = await getAuthContext(req);
    const { id } = await ctx.params;
    const [agent] = await db.select({ id: agents.id }).from(agents)
      .where(and(eq(agents.id, id), eq(agents.businessId, auth.businessId), eq(agents.isActive, true))).limit(1);
    if (!agent) throw new AppError(404, "AGENT_NOT_FOUND", "Active agent not found for the current test tenant");
    return ok(assessLocalAgentReadiness(process.env));
  });
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return withApiHandling(async (requestId) => {
    assertIsolatedLab();
    const auth = await getAuthContext(req);
    const { id } = await ctx.params;
    const [agent] = await db.select({ id: agents.id }).from(agents)
      .where(and(eq(agents.id, id), eq(agents.businessId, auth.businessId), eq(agents.isActive, true))).limit(1);
    if (!agent) throw new AppError(404, "AGENT_NOT_FOUND", "Active agent not found for this tenant");

    const form = await req.formData();
    // Voice-only preview: fixed text, offline Piper, no Gemini STT/LLM calls,
    // no call creation and no arbitrary client text passed to a synthesizer.
    const voicePreview = form.get("voicePreview");
    if (voicePreview === "piper" || voicePreview === "pocket") {
      const isPocket = voicePreview === "pocket";
      const previewVoice = isPocket ? null : parsePiperVoice(form.get("piperVoice") ?? "fa_IR-amir-medium");
      const previewStyle = isPocket ? null : parsePiperStyle(form.get("piperStyle") ?? "natural");
      // Two fixed server-side phrases only: the speaker sample, and the short
      // "one moment" line the live lab plays while a slow turn is processing.
      const previewKind = form.get("previewKind") ?? "sample";
      if (previewKind !== "sample" && previewKind !== "filler") {
        throw new AppError(400, "INVALID_PAYLOAD", "previewKind must be sample or filler");
      }
      const previewText = previewKind === "filler"
        ? LAB_FILLER_TEXT
        : "سلام، وقت شما بخیر. خوشحال می‌شوم راهنمایی‌تان کنم.";
      const started = Date.now();
      const sample = await (isPocket
        ? new PocketTTSProvider()
        : new PiperTTSProvider({ voice: previewVoice!, style: previewStyle! })
      ).synthesize(previewText, { format: "pcm" });
      // Browser speaker comparison must use native 24-kHz PCM quality, not
      // the 8-kHz G.711 telephone codec that intentionally degrades bandwidth.
      // Real lab turns retain their original telephony path unchanged.
      const previewWav = pcm16ToWav(sample.audio, 24_000);
      return ok({
        mode: isPocket ? "pocket-voice-preview" : "piper-voice-preview",
        previewKind,
        realPhoneCall: false,
        voice: previewVoice,
        style: previewStyle,
        ttsMs: Date.now() - started,
        playbackWavBase64: previewWav.toString("base64"),
        playbackSeconds: sample.audio.length / (2 * 24_000),
        playbackSampleRate: 24_000,
      });
    }
    const file = form.get("audio");
    if (!(file instanceof File) || file.type.split(";")[0] !== "audio/basic") {
      throw new AppError(415, "UNSUPPORTED_MEDIA_TYPE", "Provide 8 kHz mono G.711 mu-law audio/basic");
    }
    if (file.size > 8_000 * 20) throw new AppError(413, "PAYLOAD_TOO_LARGE", "20 seconds maximum");
    const readiness = assessLocalAgentReadiness(process.env);
    if (!readiness.ready) {
      throw new AppError(503, "PROVIDER_NOT_CONFIGURED", readiness.reasons.join(" | "));
    }
    const ttsEngine = form.get("ttsEngine");
    if (ttsEngine !== null && ttsEngine !== "configured" && ttsEngine !== "piper" && ttsEngine !== "pocket") {
      throw new AppError(400, "INVALID_PAYLOAD", "ttsEngine must be configured, piper or pocket");
    }
    const sttEngine = form.get("sttEngine");
    if (sttEngine !== null && sttEngine !== "configured" && sttEngine !== "faster-whisper") {
      throw new AppError(400, "INVALID_PAYLOAD", "sttEngine must be configured or faster-whisper");
    }
    // Voice presets are restricted to known publisher models; never trust an arbitrary
    // path or a caller-provided voice ID. A server may load these voices on demand.
    const piperVoice = ttsEngine === "piper"
      ? parsePiperVoice(form.get("piperVoice") ?? "fa_IR-amir-medium")
      : null;
    const piperStyle = ttsEngine === "piper"
      ? parsePiperStyle(form.get("piperStyle") ?? "natural")
      : null;
    const responseStyle = form.get("responseStyle");
    if (responseStyle !== null && responseStyle !== "brief" && responseStyle !== "normal") {
      throw new AppError(400, "INVALID_PAYLOAD", "responseStyle must be brief or normal");
    }
    const muLaw = Buffer.from(await file.arrayBuffer());
    const input = assessLocalTelephonyInput(muLaw);
    const sttWavFile = form.get("sttWav");
    if (sttWavFile !== null && (sttEngine !== "faster-whisper" ||
        !(sttWavFile instanceof File) || sttWavFile.type.split(";")[0] !== "audio/wav")) {
      throw new AppError(400, "INVALID_PAYLOAD",
        "16-kHz microphone STT is allowed only for the local Faster-Whisper lab");
    }
    const highQualityWav = sttWavFile instanceof File
      ? validateLocalHighQualitySttWav(Buffer.from(await sttWavFile.arrayBuffer()), input.durationSeconds)
      : null;

    // Lab-only conversation memory (no call row exists here). Server-side,
    // scoped to this tenant, user and agent; the browser sends an opaque id.
    const sessionId = parseLabSessionId(form.get("conversationId"));
    const scope = sessionId
      ? { businessId: auth.businessId, userId: auth.userId, agentId: agent.id, sessionId }
      : null;
    const priorMessages = scope ? await loadLabHistory(scope) : undefined;

    // Real AI providers & metering; explicitly opted into from the dev-only UI.
    // No Twilio requests, CallSid, phone calls, call admission or PSTN billing.
    const result = await runVoiceTurn({
      businessId: auth.businessId,
      agentId: agent.id,
      audio: highQualityWav ?? muLaw,
      audioCodec: highQualityWav ? undefined : "mulaw",
      audioMimeType: highQualityWav ? "audio/wav" : undefined,
      audioSampleRate: highQualityWav ? undefined : 8_000,
      ttsFormat: "pcm",
      requestId,
      actor: auth.userId,
      briefVoiceReply: responseStyle === "brief",
      priorMessages,
      // Explicit, authenticated and isolated local lab opt-in only.
      // No global provider switching and no Gemini credential exposure.
      tts: ttsEngine === "piper"
        ? new PiperTTSProvider({ voice: piperVoice!, style: piperStyle! })
        : ttsEngine === "pocket" ? new PocketTTSProvider() : undefined,
      stt: sttEngine === "faster-whisper" ? new FasterWhisperSTTProvider() : undefined,
    });

    const playback = result.audio
      ? encodeLocalTelephonyOutput(result.audio, result.audioMimeType)
      : null;
    const conversationTurns = scope && result.heard && result.transcript.trim() && result.reply.trim()
      ? await appendLabTurn(scope, result.transcript, result.reply)
      : (priorMessages?.length ?? 0) / 2;

    return ok({
      mode: "local-telephony-codec",
      realPhoneCall: false,
      heard: result.heard,
      conversationTurns,
      transcript: result.transcript,
      reply: result.reply,
      spokenText: result.spokenText,
      input,
      sttInputMode: highQualityWav ? "microphone-16k" : "telephone-8k",
      output: playback ? { mulawBytes: playback.mulawBytes, frames20ms: playback.frames20ms } : null,
      playbackWavBase64: playback ? playback.wav.toString("base64") : null,
      latencyMs: result.latencyMs,
      usage: result.usage,
    });
  });
}
