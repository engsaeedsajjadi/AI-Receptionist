import { requireTenantFeature } from "@/lib/tenant-config";
import { AppError } from "@/lib/errors";
import { logInfo, logWarn } from "@/lib/logger";
import { getSTTProvider, type STTProvider } from "@/lib/providers/stt";
import { getTTSProvider, type TTSProvider } from "@/lib/providers/tts";
import { getStorageProvider, tenantKey } from "@/lib/providers/storage";
import type { LLMProvider } from "@/lib/providers/llm";
import { redisDel, redisGet, redisSet } from "@/lib/redis";
import { runAgentTurn } from "@/lib/services/agent";
import { recordUsage } from "@/lib/services/usage";
import { toSpokenPersian } from "@/lib/voice/cleaner";
import { normalizeTelephonyAudio, type AudioCodec } from "@/lib/voice/audio";

export type VoiceTurnInput = {
  businessId: string;
  agentId?: string;
  callId?: string;
  externalCallId?: string;
  /** Raw caller audio (exactly one of audio / transcript is required). */
  audio?: Buffer;
  audioMimeType?: string;
  audioCodec?: AudioCodec;
  audioSampleRate?: number;
  /** Pre-transcribed caller text (gateway-side STT topology). */
  transcript?: string;
  /** Provider utterance identity for completion-marker dedup. */
  eventId?: string;
  seq?: number | null;
  /** BCP-47 language hint for STT. Defaults to Persian. */
  language?: string;
  /** TTS voice override. */
  voice?: string;
  requestId: string;
  actor?: string;
  /** Provider overrides for tests. */
  stt?: STTProvider;
  tts?: TTSProvider;
  llm?: LLMProvider;
};

export type VoiceTurnResult = {
  /** True when this event already completed (redelivery): no work was done. */
  duplicate: boolean;
  /** False when STT heard no speech: no agent/TTS work was done. */
  heard: boolean;
  transcript: string;
  sttLanguage: string | null;
  sttDurationSeconds: number | null;
  reply: string;
  spokenText: string;
  audio: Buffer | null;
  audioMimeType: string | null;
  /** Public storage URL for gateway-side playback (null when archival failed). */
  audioUrl: string | null;
  audioStored: boolean;
  agentId: string | null;
  toolCalls: Array<{ tool: string; status: string }>;
  usage: {
    sttMinutes: number;
    ttsCharacters: number;
    llmInputTokens: number;
    llmOutputTokens: number;
  };
  latencyMs: { total: number; stt?: number; agent?: number; tts?: number; store?: number };
};

const MARKER_TTL_SECONDS = 24 * 60 * 60;

function markerKey(callId: string, eventId: string): string {
  return `voice:turn-done:${callId}:${eventId}`;
}

function emptyResult(overrides: Partial<VoiceTurnResult> & { transcript: string }): VoiceTurnResult {
  return {
    duplicate: false,
    heard: true,
    sttLanguage: null,
    sttDurationSeconds: null,
    reply: "",
    spokenText: "",
    audio: null,
    audioMimeType: null,
    audioUrl: null,
    audioStored: false,
    agentId: null,
    toolCalls: [],
    usage: { sttMinutes: 0, ttsCharacters: 0, llmInputTokens: 0, llmOutputTokens: 0 },
    latencyMs: { total: 0 },
    ...overrides,
  };
}

/**
 * One full voice turn: audio → STT → Persian-normalized agent turn (tools) →
 * speakable-text cleaning → TTS → audio archival.
 *
 * Playback is the caller's job (gateway REST `play` or media-socket audio
 * frame) — this function returns both raw audio bytes and a public URL.
 *
 * Idempotency: when `eventId` + `callId` are present, a Redis completion
 * marker makes redeliveries return `{ duplicate: true }` without re-running
 * (no double STT/TTS billing, no double agent side effects). The marker is
 * set only on success; errors propagate and retries re-run.
 */
export async function runVoiceTurn(input: VoiceTurnInput): Promise<VoiceTurnResult> {
  await requireTenantFeature(input.businessId, "voice");
  const started = Date.now();
  const latency: VoiceTurnResult["latencyMs"] = { total: 0 };
  const hasAudio = Boolean(input.audio && input.audio.length > 0);
  const hasTranscript = Boolean(input.transcript && input.transcript.trim());
  if (hasAudio === hasTranscript) {
    throw new AppError(400, "INVALID_PAYLOAD", "Exactly one of audio or transcript is required");
  }

  const marker = input.callId && input.eventId ? markerKey(input.callId, input.eventId) : null;
  if (marker && (await redisGet(marker))) {
    return emptyResult({ duplicate: true, heard: true, transcript: "" });
  }

  const stt = input.stt ?? getSTTProvider();
  const tts = input.tts ?? getTTSProvider();

  // 1. Speech → text.
  let transcript = "";
  let sttLanguage: string | null = null;
  let sttDurationSeconds: number | null = null;
  let sttMinutes = 0;
  if (hasAudio) {
    const t0 = Date.now();
    const normalizedAudio = input.audioCodec
      ? normalizeTelephonyAudio(input.audio as Buffer, input.audioCodec, input.audioSampleRate ?? 8000)
      : { audio: input.audio as Buffer, mimeType: input.audioMimeType, filename: undefined };
    const sttResult = await stt.transcribe(normalizedAudio.audio, {
      filename: normalizedAudio.filename,
      mimeType: normalizedAudio.mimeType,
      language: input.language ?? "fa",
      requestId: input.requestId,
      businessId: input.businessId,
      callId: input.callId,
    });
    latency.stt = Date.now() - t0;
    transcript = (sttResult.text ?? "").trim();
    sttLanguage = sttResult.language;
    sttDurationSeconds = sttResult.durationSeconds;
    sttMinutes = sttDurationSeconds != null ? sttDurationSeconds / 60 : 0;
    await recordUsage({
      businessId: input.businessId,
      type: "stt_minutes",
      quantity: sttMinutes,
      unit: "minute",
      provider: sttResult.provider,
      idempotencyKey: `stt:${input.callId ?? input.businessId}:${input.eventId ?? input.requestId}`,
      metadata: {
        callId: input.callId,
        eventId: input.eventId,
        model: sttResult.model,
        durationSeconds: sttDurationSeconds,
      },
    });
  } else {
    transcript = (input.transcript as string).trim();
  }

  if (!transcript) {
    // Heard nothing: ack honestly without invoking the agent or TTS.
    if (marker) await redisSet(marker, "no-speech", MARKER_TTL_SECONDS);
    latency.total = Date.now() - started;
    return emptyResult({ heard: false, transcript: "", sttLanguage, sttDurationSeconds, latencyMs: latency });
  }

  // 2. Agent turn (Persian normalization + tools + LLM usage inside).
  const t1 = Date.now();
  const agentResult = await runAgentTurn({
    businessId: input.businessId,
    agentId: input.agentId,
    callId: input.callId,
    userMessage: transcript,
    requestId: input.requestId,
    actor: input.actor ?? "voice-turn",
    llm: input.llm,
  });
  latency.agent = Date.now() - t1;

  // 3. Reply → speakable text → speech.
  const spokenText = toSpokenPersian(agentResult.reply) || agentResult.reply.trim().slice(0, 500);
  const t2 = Date.now();
  const ttsResult = await tts.synthesize(spokenText, {
    voice: input.voice,
    format: "mp3",
    requestId: input.requestId,
    businessId: input.businessId,
    callId: input.callId,
  });
  latency.tts = Date.now() - t2;
  const ttsCharacters = ttsResult.usage.characters ?? spokenText.length;
  await recordUsage({
    businessId: input.businessId,
    type: "tts_characters",
    quantity: ttsCharacters,
    unit: "character",
    provider: ttsResult.provider,
    idempotencyKey: `tts:${input.callId ?? input.businessId}:${input.eventId ?? input.requestId}`,
    metadata: { callId: input.callId, eventId: input.eventId, model: ttsResult.model, voice: ttsResult.voice },
  });

  // 4. Archive reply audio for gateway playback (best effort — the raw bytes
  // are still returned, and routes fall back to gateway-side TTS on failure).
  let audioUrl: string | null = null;
  let audioStored = false;
  const t3 = Date.now();
  try {
    const key = tenantKey(
      input.businessId,
      "calls",
      input.callId ?? "adhoc",
      "replies",
      `${input.eventId ?? input.requestId}.mp3`,
    );
    await getStorageProvider().upload({ key, data: ttsResult.audio, contentType: ttsResult.mimeType });
    audioUrl = await getStorageProvider().getSignedUrl(key);
    audioStored = true;
  } catch (err) {
    logWarn("Voice reply archival failed (bytes still returned)", {
      requestId: input.requestId,
      businessId: input.businessId,
      callId: input.callId,
      operation: "voice.turn.store",
      status: "error",
      error: err instanceof Error ? err.message : String(err),
    });
  }
  latency.store = Date.now() - t3;

  if (marker) await redisSet(marker, "done", MARKER_TTL_SECONDS);
  latency.total = Date.now() - started;

  logInfo("Voice turn completed", {
    requestId: input.requestId,
    businessId: input.businessId,
    callId: input.callId,
    operation: "voice.turn",
    durationMs: latency.total,
    status: "ok",
  });

  return {
    duplicate: false,
    heard: true,
    transcript,
    sttLanguage,
    sttDurationSeconds,
    reply: agentResult.reply,
    spokenText,
    audio: ttsResult.audio,
    audioMimeType: ttsResult.mimeType,
    audioUrl,
    audioStored,
    agentId: agentResult.agentId,
    toolCalls: agentResult.toolCalls,
    usage: {
      sttMinutes,
      ttsCharacters,
      llmInputTokens: agentResult.usage.inputTokens,
      llmOutputTokens: agentResult.usage.outputTokens,
    },
    latencyMs: latency,
  };
}

/** Delete a turn completion marker (lets a failed playback retry recompute). */
export async function clearTurnMarker(callId: string, eventId: string): Promise<void> {
  await redisDel(markerKey(callId, eventId));
}
