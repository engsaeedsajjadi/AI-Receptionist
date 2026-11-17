import { AppError } from "@/lib/errors";
import { getEnv } from "@/lib/env";
import { normalizePiperWav, validatePiperEndpoint } from "@/lib/providers/piper-tts";
import { pcm16ToWav } from "@/lib/voice/audio";
import type { SpeechResult, SynthesizeOptions, TTSProvider } from "@/lib/providers/tts";

const TARGET_SAMPLE_RATE = 24_000;
const MAX_TEXT_CHARS = 600;
const MAX_WAV_BYTES = 4 * 1024 * 1024;

/**
 * Experimental offline Persian TTS through a loopback Pocket-TTS server
 * (Cilla / pocket-tts-farsi models), started separately with
 * `scripts/local-tts/pocket_server.py`. Developer telephone lab only.
 *
 * The voice is fixed on the server at start-up (a consenting speaker's
 * recording); the app never sends or chooses a voice, so it cannot be used to
 * clone a caller or anyone else.
 */
export class PocketTTSProvider implements TTSProvider {
  readonly name = "pocket-tts";
  private readonly endpoint: string;
  private readonly timeoutMs: number;

  constructor(overrides: { baseURL?: string; timeoutMs?: number } = {}) {
    const env = getEnv();
    const url = validatePiperEndpoint(overrides.baseURL ?? env.POCKET_TTS_URL);
    this.endpoint = new URL("/synthesize", url).toString();
    this.timeoutMs = overrides.timeoutMs ?? env.POCKET_TTS_TIMEOUT_MS;
  }

  async synthesize(text: string, options: SynthesizeOptions = {}): Promise<SpeechResult> {
    const input = text.trim();
    if (!input || input.length > MAX_TEXT_CHARS) {
      throw new AppError(400, "INVALID_PAYLOAD", `Pocket-TTS text must be 1..${MAX_TEXT_CHARS} characters`);
    }
    const format = options.format ?? "wav";
    if (format !== "wav" && format !== "pcm") {
      throw new AppError(415, "UNSUPPORTED_MEDIA_TYPE", "Pocket-TTS supports pcm or wav output, not MP3/Opus");
    }
    let response: Response;
    try {
      response = await fetch(this.endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Accept": "audio/wav" },
        body: JSON.stringify({ text: input }),
        redirect: "error",
        signal: AbortSignal.timeout(options.timeoutMs ?? this.timeoutMs),
      });
    } catch (err) {
      throw new AppError(503, "DEPENDENCY_UNAVAILABLE",
        "Local Pocket-TTS (Cilla) is unavailable; start scripts/local-tts/pocket_server.py (port 5002)", {
          cause: err instanceof Error ? err.name : "request_error",
        });
    }
    if (!response.ok) throw new AppError(502, "TTS_ERROR", `Pocket-TTS HTTP ${response.status}`);
    const contentLength = Number(response.headers.get("content-length") ?? "0");
    if (contentLength > MAX_WAV_BYTES) throw new AppError(502, "TTS_ERROR", "Pocket-TTS WAV exceeds 4 MB");
    // Same strict RIFF/PCM16-mono/≤30 s validation as Piper, resampled to 24 kHz.
    const pcm = normalizePiperWav(Buffer.from(await response.arrayBuffer()));
    return {
      audio: format === "pcm" ? pcm : pcm16ToWav(pcm, TARGET_SAMPLE_RATE),
      mimeType: format === "pcm" ? "audio/l16" : "audio/wav",
      usage: { characters: input.length },
      provider: this.name,
      model: "pocket-tts-local",
      voice: "server-fixed",
    };
  }
}
