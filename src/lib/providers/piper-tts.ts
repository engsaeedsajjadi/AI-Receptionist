import { AppError } from "@/lib/errors";
import { getEnv } from "@/lib/env";
import { pcm16ToWav, resamplePcm16 } from "@/lib/voice/audio";
import type { TTSProvider, SynthesizeOptions, SpeechResult } from "@/lib/providers/tts";

const MAX_WAV_BYTES = 4 * 1024 * 1024;
const TARGET_SAMPLE_RATE = 24_000;

/** Reject outbound SSRF: the local TTS adapter can contact only the loopback Piper server. */
export function validatePiperEndpoint(value: string): URL {
  let url: URL;
  try { url = new URL(value); }
  catch { throw new AppError(400, "VALIDATION_ERROR", "Piper URL is invalid"); }
  if (url.protocol !== "http:" ||
      !["127.0.0.1", "localhost"].includes(url.hostname) ||
      url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new AppError(400, "VALIDATION_ERROR", "Piper must be an HTTP server on localhost only");
  }
  return url;
}

/** Parse a bounded PCM16 mono WAV from Piper and normalize it to 24 kHz PCM. */
export function normalizePiperWav(wav: Buffer): Buffer {
  if (wav.length < 44 || wav.length > MAX_WAV_BYTES ||
    wav.toString("ascii", 0, 4) !== "RIFF" ||
    wav.toString("ascii", 8, 12) !== "WAVE") {
    throw new AppError(502, "TTS_ERROR", "Piper returned invalid or oversized WAV");
  }
  const riffSize = wav.readUInt32LE(4);
  if (riffSize + 8 > wav.length) throw new AppError(502, "TTS_ERROR", "Piper WAV is truncated");

  let sampleRate = 0;
  let audioFormat = 0;
  let channels = 0;
  let bitsPerSample = 0;
  let pcm: Buffer | null = null;
  for (let at = 12; at + 8 <= wav.length;) {
    const name = wav.toString("ascii", at, at + 4);
    const length = wav.readUInt32LE(at + 4);
    const dataAt = at + 8;
    if (length > wav.length - dataAt) throw new AppError(502, "TTS_ERROR", "Truncated Piper WAV chunk");
    if (name === "fmt " && length >= 16) {
      audioFormat = wav.readUInt16LE(dataAt);
      channels = wav.readUInt16LE(dataAt + 2);
      sampleRate = wav.readUInt32LE(dataAt + 4);
      bitsPerSample = wav.readUInt16LE(dataAt + 14);
    } else if (name === "data") {
      pcm = wav.subarray(dataAt, dataAt + length);
    }
    at = dataAt + length + (length % 2);
  }
  if (!pcm?.length || pcm.length % 2 !== 0 || audioFormat !== 1 || channels !== 1 ||
      bitsPerSample !== 16 || sampleRate < 8000 || sampleRate > 48000 ||
      pcm.length > sampleRate * 2 * 30) {
    throw new AppError(502, "TTS_ERROR", "Piper must return up to 30 seconds of mono 16-bit PCM WAV");
  }
  return resamplePcm16(pcm, sampleRate, TARGET_SAMPLE_RATE);
}

/**
 * Optional offline Persian TTS via Piper's official HTTP /synthesize API.
 * Never enabled by default. User must start the local Piper server separately.
 * Note: the voice is the server-configured approved model, not the agent's
 * unrelated cloud voice ID.
 */
export class PiperTTSProvider implements TTSProvider {
  readonly name = "piper";
  private readonly endpoint: string;
  private readonly voice: string;
  private readonly timeoutMs: number;

  constructor(overrides: { baseURL?: string; voice?: string; timeoutMs?: number } = {}) {
    const env = getEnv();
    const url = validatePiperEndpoint(overrides.baseURL ?? env.PIPER_TTS_URL);
    this.endpoint = new URL("/synthesize", url).toString();
    this.voice = overrides.voice ?? env.PIPER_TTS_VOICE;
    this.timeoutMs = overrides.timeoutMs ?? env.PIPER_TTS_TIMEOUT_MS;
  }

  async synthesize(text: string, options: SynthesizeOptions = {}): Promise<SpeechResult> {
    const input = text.trim();
    if (!input || input.length > 4096) {
      throw new AppError(400, "INVALID_PAYLOAD", "Piper text must be 1..4096 characters");
    }
    const format = options.format ?? "wav";
    if (format !== "wav" && format !== "pcm") {
      throw new AppError(415, "UNSUPPORTED_MEDIA_TYPE", "Piper supports pcm or wav output, not MP3/Opus");
    }
    let response: Response;
    try {
      response = await fetch(this.endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Accept": "audio/wav" },
        body: JSON.stringify({ text: input, voice: this.voice }),
        redirect: "error",
        signal: AbortSignal.timeout(options.timeoutMs ?? this.timeoutMs),
      });
    } catch (err) {
      throw new AppError(503, "DEPENDENCY_UNAVAILABLE",
        "Local Piper TTS is unavailable; start Piper on localhost (and confirm port 5000)", {
          cause: err instanceof Error ? err.name : "request_error",
        });
    }
    if (!response.ok) {
      throw new AppError(502, "TTS_ERROR", `Piper TTS HTTP ${response.status}; check that the requested voice is installed`);
    }
    const contentType = response.headers.get("content-type") ?? "";
    if (contentType && !contentType.includes("audio/wav") && !contentType.includes("audio/x-wav")) {
      throw new AppError(502, "TTS_ERROR", "Piper returned a non-WAV response");
    }
    const contentLength = Number(response.headers.get("content-length") ?? "0");
    if (contentLength > MAX_WAV_BYTES) throw new AppError(502, "TTS_ERROR", "Piper WAV exceeds 4 MB");
    const wav = Buffer.from(await response.arrayBuffer());
    const pcm = normalizePiperWav(wav);
    return {
      audio: format === "pcm" ? pcm : pcm16ToWav(pcm, TARGET_SAMPLE_RATE),
      mimeType: format === "pcm" ? "audio/l16" : "audio/wav",
      usage: { characters: input.length },
      provider: this.name,
      model: this.voice,
      voice: this.voice,
    };
  }
}
