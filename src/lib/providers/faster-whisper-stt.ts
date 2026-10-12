import { AppError } from "@/lib/errors";
import { getEnv } from "@/lib/env";
import type { STTProvider, TranscribeOptions, TranscriptionResult } from "@/lib/providers/stt";

const MAX_WAV_BYTES = 800_000;

export function validateLocalWhisperUrl(value: string): URL {
  let url: URL;
  try { url = new URL(value); }
  catch { throw new AppError(400, "VALIDATION_ERROR", "Local Whisper URL is invalid"); }
  if (url.protocol !== "http:" ||
    !["127.0.0.1", "localhost"].includes(url.hostname) ||
    url.username || url.password || url.hash || url.search || url.pathname !== "/") {
    throw new AppError(400, "VALIDATION_ERROR", "Local Whisper must be HTTP on loopback");
  }
  return url;
}

/**
 * CPU-only test STT. A separate Python Flask process listens on localhost:5001.
 * Never automatically falls back to Gemini: fallback would silently incur API cost.
 */
export class FasterWhisperSTTProvider implements STTProvider {
  readonly name = "faster-whisper";
  private readonly endpoint: string;
  private readonly timeoutMs: number;

  constructor(overrides: { baseURL?: string; timeoutMs?: number } = {}) {
    const env = getEnv();
    const base = validateLocalWhisperUrl(overrides.baseURL ?? env.LOCAL_WHISPER_STT_URL);
    this.endpoint = new URL("/transcribe", base).toString();
    this.timeoutMs = overrides.timeoutMs ?? env.LOCAL_WHISPER_STT_TIMEOUT_MS;
  }

  async transcribe(audio: Buffer, options: TranscribeOptions = {}): Promise<TranscriptionResult> {
    if (audio.length < 44 || audio.length > MAX_WAV_BYTES ||
      audio.toString("ascii", 0, 4) !== "RIFF" ||
      audio.toString("ascii", 8, 12) !== "WAVE") {
      throw new AppError(400, "INVALID_PAYLOAD", "Local Whisper requires a bounded PCM WAV");
    }
    let response: Response;
    try {
      response = await fetch(this.endpoint, {
        method: "POST",
        headers: { "Content-Type": "audio/wav", "Accept": "application/json" },
        body: new Uint8Array(audio),
        redirect: "error",
        signal: AbortSignal.timeout(options.timeoutMs ?? this.timeoutMs),
      });
    } catch {
      throw new AppError(503, "DEPENDENCY_UNAVAILABLE",
        "Local Faster-Whisper is offline or timed out; start CPU STT on localhost:5001");
    }
    if (!response.ok) throw new AppError(502, "STT_ERROR", `Local Faster-Whisper HTTP ${response.status}`);
    const raw = await response.text();
    if (raw.length > 8192) throw new AppError(502, "STT_ERROR", "Local STT response too large");
    let parsed: unknown;
    try { parsed = JSON.parse(raw); }
    catch { throw new AppError(502, "STT_ERROR", "Local STT returned invalid JSON"); }
    if (!parsed || typeof parsed !== "object") {
      throw new AppError(502, "STT_ERROR", "Invalid local STT response");
    }
    const value = parsed as Record<string, unknown>;
    if (typeof value.text !== "string" || value.text.length > 4000 ||
      typeof value.durationSeconds !== "number" ||
      !Number.isFinite(value.durationSeconds) ||
      value.durationSeconds <= 0 || value.durationSeconds > 20.5 ||
      typeof value.model !== "string" || !["tiny", "base"].includes(value.model)) {
      throw new AppError(502, "STT_ERROR", "Invalid local STT transcription metadata");
    }
    return {
      text: value.text.trim(),
      language: "fa",
      status: "final",
      confidence: null,
      durationSeconds: value.durationSeconds,
      usage: { audioSeconds: value.durationSeconds },
      provider: this.name,
      model: value.model,
    };
  }
}
