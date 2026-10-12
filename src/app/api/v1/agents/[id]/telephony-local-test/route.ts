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
import { FasterWhisperSTTProvider } from "@/lib/providers/faster-whisper-stt";
import { assessLocalTelephonyInput, assessLocalAgentReadiness, encodeLocalTelephonyOutput } from "@/lib/voice/local-telephony";

/**
 * DEVELOPER LAB ONLY — not Twilio/PSTN, never a production endpoint.
 * The database must be local and explicitly disposable, to prevent a UI test
 * from writing AI usage/transcripts into the operational business database.
 */
function assertIsolatedLab() {
  if (process.env.NODE_ENV !== "development") {
    throw new AppError(404, "NOT_FOUND", "Local telephone lab is disabled");
  }
  let url: URL;
  try {
    url = new URL(process.env.DATABASE_URL ?? "");
  } catch {
    throw new AppError(503, "DEPENDENCY_UNAVAILABLE", "Isolated test database is not configured");
  }
  if (!["127.0.0.1", "localhost"].includes(url.hostname) ||
      !url.pathname.endsWith("/ai_receptionist_test") ||
      (process.env.TEST_DATABASE_URL && process.env.TEST_DATABASE_URL !== url.toString())) {
    throw new AppError(403, "FORBIDDEN", "Local telephone lab requires localhost/ai_receptionist_test, never the original database");
  }
}

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
    if (form.get("voicePreview") === "piper") {
      const previewVoice = parsePiperVoice(form.get("piperVoice") ?? "fa_IR-amir-medium");
      const previewStyle = parsePiperStyle(form.get("piperStyle") ?? "natural");
      const started = Date.now();
      const sample = await new PiperTTSProvider({
        voice: previewVoice, style: previewStyle,
      }).synthesize("سلام، وقت شما بخیر. خوشحال می‌شوم راهنمایی‌تان کنم.", { format: "pcm" });
      const playback = encodeLocalTelephonyOutput(sample.audio, sample.mimeType);
      return ok({
        mode: "piper-voice-preview",
        realPhoneCall: false,
        voice: previewVoice,
        style: previewStyle,
        ttsMs: Date.now() - started,
        playbackWavBase64: playback.wav.toString("base64"),
        playbackSeconds: playback.frames20ms * 0.02,
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
    if (ttsEngine !== null && ttsEngine !== "configured" && ttsEngine !== "piper") {
      throw new AppError(400, "INVALID_PAYLOAD", "ttsEngine must be configured or piper");
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

    // Real AI providers & metering; explicitly opted into from the dev-only UI.
    // No Twilio requests, CallSid, phone calls, call admission or PSTN billing.
    const result = await runVoiceTurn({
      businessId: auth.businessId,
      agentId: agent.id,
      audio: muLaw,
      audioCodec: "mulaw",
      audioSampleRate: 8_000,
      ttsFormat: "pcm",
      requestId,
      actor: auth.userId,
      briefVoiceReply: responseStyle === "brief",
      // Explicit, authenticated and isolated local lab opt-in only.
      // No global provider switching and no Gemini credential exposure.
      tts: ttsEngine === "piper"
        ? new PiperTTSProvider({ voice: piperVoice!, style: piperStyle! })
        : undefined,
      stt: sttEngine === "faster-whisper" ? new FasterWhisperSTTProvider() : undefined,
    });

    const playback = result.audio
      ? encodeLocalTelephonyOutput(result.audio, result.audioMimeType)
      : null;

    return ok({
      mode: "local-telephony-codec",
      realPhoneCall: false,
      heard: result.heard,
      transcript: result.transcript,
      reply: result.reply,
      spokenText: result.spokenText,
      input,
      output: playback ? { mulawBytes: playback.mulawBytes, frames20ms: playback.frames20ms } : null,
      playbackWavBase64: playback ? playback.wav.toString("base64") : null,
      latencyMs: result.latencyMs,
      usage: result.usage,
    });
  });
}
