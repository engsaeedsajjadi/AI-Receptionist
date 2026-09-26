import { logWarn } from "@/lib/logger";
import { getTTSProvider, type TTSProvider } from "@/lib/providers/tts";
import { getStorageProvider, tenantKey } from "@/lib/providers/storage";
import { recordUsage } from "@/lib/services/usage";

/**
 * Out-of-turn speech: silence reprompts and failure fallbacks (§29/§30).
 *
 * These are NOT agent turns — no STT, no LLM, no tools. Fixed, reviewed
 * Persian strings so the caller never hears technical errors or unexpected
 * LLM output when the pipeline is degraded.
 */

/** First silence nudges ("I didn't hear you, please go ahead"). */
export const SILENCE_NUDGE =
  "صدای شما رو نشنیدم، اگر هنوز پشت خط هستید لطفاً دوباره بفرمایید.";

/** Final message before the session gives up on silence. */
export const SILENCE_FINAL =
  "اگر مایل باشید همکارمون با شما تماس می‌گیره. برای پایان تماس، می‌تونید قطع کنید.";

/** Spoken when a turn fails technically (detail stays server-side). */
export const TURN_FAILURE_FALLBACK =
  "متأسفانه الان نتونستم اطلاعات رو دریافت کنم. اگر بخواید می‌تونم درخواست تماس همکارمون رو ثبت کنم.";

export type SpeakInput = {
  businessId: string;
  callId?: string;
  text: string;
  voice?: string;
  requestId: string;
  tts?: TTSProvider;
};

export type SpeakResult = {
  audio: Buffer;
  mimeType: string;
  /** Public storage URL for gateway playback (null when archival failed). */
  audioUrl: string | null;
};

/**
 * Synthesize + archive one fixed string. Usage is recorded (idempotent);
 * archival is best-effort (raw bytes are still returned). Throws only when
 * synthesis itself fails — callers decide the degraded path.
 */
export async function speakText(input: SpeakInput): Promise<SpeakResult> {
  const tts = input.tts ?? getTTSProvider();
  const result = await tts.synthesize(input.text, {
    voice: input.voice,
    format: "mp3",
    requestId: input.requestId,
    businessId: input.businessId,
    callId: input.callId,
  });
  const characters = result.usage.characters ?? input.text.length;
  await recordUsage({
    businessId: input.businessId,
    type: "tts_characters",
    quantity: characters,
    unit: "character",
    provider: result.provider,
    idempotencyKey: `speak:${input.callId ?? input.businessId}:${input.requestId}`,
    metadata: { callId: input.callId, model: result.model, voice: result.voice, kind: "reprompt" },
  });

  let audioUrl: string | null = null;
  try {
    const key = tenantKey(
      input.businessId,
      "calls",
      input.callId ?? "adhoc",
      "replies",
      `${input.requestId}.mp3`,
    );
    await getStorageProvider().upload({ key, data: result.audio, contentType: result.mimeType });
    audioUrl = await getStorageProvider().getSignedUrl(key);
  } catch (err) {
    logWarn("Reprompt archival failed (bytes still returned)", {
      requestId: input.requestId,
      businessId: input.businessId,
      callId: input.callId,
      operation: "voice.speak.store",
      status: "error",
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return { audio: result.audio, mimeType: result.mimeType, audioUrl };
}
