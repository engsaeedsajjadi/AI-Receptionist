import { AppError } from "@/lib/errors";
import { frameRms, mulawFrames, mulawToPcm16, pcm16ToWav, pcmToTelephonyMulaw } from "@/lib/voice/audio";

export const TELEPHONY_RATE = 8_000;
export const MAX_TELEPHONY_SECONDS = 20;
const MIN_SECONDS = 0.7;
const RAW_PCM_MIMES = new Set(["audio/l16", "audio/pcm"]);

export function assessLocalTelephonyInput(audio: Buffer) {
  const durationSeconds = audio.length / TELEPHONY_RATE;
  if (durationSeconds < MIN_SECONDS || durationSeconds > MAX_TELEPHONY_SECONDS) {
    throw new AppError(400, "INVALID_PAYLOAD", "Audio must be between 0.7 and 20 seconds of 8 kHz G.711 mu-law");
  }
  const rms = frameRms(audio, "mulaw");
  if (rms < 0.001) {
    throw new AppError(400, "INVALID_PAYLOAD", "Audio is silent or nearly silent; nothing sent to STT");
  }
  return { durationSeconds, rms, frames20ms: mulawFrames(audio).length };
}

/**
 * TTS egress: strictly raw mono PCM16 (provider promises 24 kHz).
 * No MP3/WAV header may be mistaken for PCM before encoding.
 */
export function encodeLocalTelephonyOutput(audio: Buffer, mimeType: string | null) {
  const mime = (mimeType ?? "").split(";")[0].toLowerCase().trim();
  if (!RAW_PCM_MIMES.has(mime) || audio.length < 2 || audio.length % 2 !== 0 ||
    audio.length > 24_000 * 2 * 30 ||
    audio.subarray(0, 4).toString("ascii") === "RIFF") {
    throw new AppError(415, "UNSUPPORTED_MEDIA_TYPE", "Telephone playback requires raw 24 kHz PCM16 mono TTS, not MP3 or WAV");
  }
  const mulaw = pcmToTelephonyMulaw(audio, 24_000, TELEPHONY_RATE);
  return {
    mulawBytes: mulaw.length,
    frames20ms: mulawFrames(mulaw).length,
    wav: pcm16ToWav(mulawToPcm16(mulaw), TELEPHONY_RATE),
  };
}

/** Checks only local provider wiring; no provider requests and no secrets returned. */
type LocalProviderEnvironment = Partial<Record<
  "LLM_PROVIDER" | "STT_PROVIDER" | "TTS_PROVIDER" |
  "COMPATIBLE_LLM_API_KEY" | "COMPATIBLE_LLM_BASE_URL" | "OPENAI_API_KEY",
  string
>>;

export function assessLocalAgentReadiness(env: LocalProviderEnvironment) {
  const llm = env.LLM_PROVIDER ?? "dev";
  const stt = env.STT_PROVIDER ?? "dev";
  const tts = env.TTS_PROVIDER ?? "dev";
  const reasons: string[] = [];
  if (llm === "dev") reasons.push("LLM_PROVIDER در محیط توسعه پیکربندی نشده است.");
  if (stt === "dev") reasons.push("STT_PROVIDER در محیط توسعه پیکربندی نشده است.");
  if (tts === "dev") reasons.push("TTS_PROVIDER در محیط توسعه پیکربندی نشده است.");
  if (llm === "compatible" && (!env.COMPATIBLE_LLM_API_KEY || !env.COMPATIBLE_LLM_BASE_URL)) {
    reasons.push("اتصال LLM سازگار، کلید یا نشانی پایه ندارد.");
  }
  if ((stt === "gemini" || tts === "gemini") && !env.COMPATIBLE_LLM_API_KEY) {
    reasons.push("کلید Gemini برای STT/TTS موجود نیست.");
  }
  if ((stt === "compatible" || tts === "compatible") && (!env.COMPATIBLE_LLM_API_KEY || !env.COMPATIBLE_LLM_BASE_URL)) {
    reasons.push("اتصال STT/TTS سازگار کامل نیست.");
  }
  if ((llm === "openai" || stt === "openai" || tts === "openai") && !env.OPENAI_API_KEY) {
    reasons.push("کلید OpenAI برای ارائه‌دهنده انتخاب‌شده موجود نیست.");
  }
  return { ready: reasons.length === 0, reasons, providers: { llm, stt, tts } };
}
