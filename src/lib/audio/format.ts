import { AppError } from "@/lib/errors";
import { alawToPcm16, mulawToPcm16, pcm16ToAlaw, pcm16ToMulaw } from "@/lib/audio/codecs";
import { buildWav } from "@/lib/audio/wav";

/**
 * Telephony audio format layer (§8).
 *
 * The pipeline's canonical working format is **PCM16 mono @ 16 kHz**:
 * STT file uploads, VAD and turn buffering all operate on it. Everything
 * arriving in a telephony format (typically 8 kHz mu-law/A-law mono) is
 * normalised HERE on ingress, and TTS output is converted back HERE on
 * egress. Nothing outside this directory may assume a codec.
 */

export type TelephonyEncoding = "pcm16" | "mulaw" | "alaw";

export type AudioFormat = {
  encoding: TelephonyEncoding;
  /** Samples per second. Telephony is 8k; the pipeline works at 16k. */
  sampleRate: number;
  /** Only mono is supported; stereo must be downmixed before this layer. */
  channels: 1;
};

/** Sample rates the resampler accepts (telephony + pipeline native). */
const SUPPORTED_RATES = new Set([8000, 16000]);

/** Canonical in-pipeline format: PCM16 mono @ 16 kHz. */
export const PIPELINE_FORMAT: AudioFormat = { encoding: "pcm16", sampleRate: 16000, channels: 1 };

export function assertAudioFormat(format: AudioFormat, label: string): void {
  if (format.channels !== 1) {
    throw new AppError(400, "INVALID_PAYLOAD", `${label}: only mono audio is supported`);
  }
  if (!SUPPORTED_RATES.has(format.sampleRate)) {
    throw new AppError(
      400,
      "INVALID_PAYLOAD",
      `${label}: unsupported sample rate ${format.sampleRate} (expected 8000 or 16000)`,
    );
  }
}

/**
 * Linear-interpolation resampler for PCM16 mono. Telephony-grade (not
 * hi-fi): adequate for 8k<->16k voice, deterministic, dependency-free.
 */
export function resamplePcm16Mono(input: Buffer, fromRate: number, toRate: number): Buffer {
  if (input.length % 2 !== 0) {
    throw new AppError(400, "INVALID_PAYLOAD", "PCM16 buffer length must be even");
  }
  if (fromRate === toRate) return Buffer.from(input);
  if (!Number.isInteger(fromRate) || fromRate <= 0 || !Number.isInteger(toRate) || toRate <= 0) {
    throw new AppError(400, "INVALID_PAYLOAD", `Invalid resample rates ${fromRate} -> ${toRate}`);
  }
  const inSamples = input.length / 2;
  if (inSamples === 0) return Buffer.alloc(0);
  if (inSamples === 1) {
    const out = Buffer.allocUnsafe(2);
    out.writeInt16LE(input.readInt16LE(0), 0);
    return out;
  }
  const outSamples = Math.max(1, Math.round((inSamples * toRate) / fromRate));
  const out = Buffer.allocUnsafe(outSamples * 2);
  for (let i = 0; i < outSamples; i++) {
    const pos = (i * (inSamples - 1)) / (outSamples - 1);
    const lo = Math.floor(pos);
    const hi = Math.min(lo + 1, inSamples - 1);
    const frac = pos - lo;
    const value = Math.round(input.readInt16LE(lo * 2) * (1 - frac) + input.readInt16LE(hi * 2) * frac);
    out.writeInt16LE(Math.max(-32768, Math.min(32767, value)), i * 2);
  }
  return out;
}

function decodeToPcm16(input: Buffer, encoding: TelephonyEncoding): Buffer {
  switch (encoding) {
    case "pcm16":
      if (input.length % 2 !== 0) {
        throw new AppError(400, "INVALID_PAYLOAD", "PCM16 buffer length must be even");
      }
      return Buffer.from(input);
    case "mulaw":
      return mulawToPcm16(input);
    case "alaw":
      return alawToPcm16(input);
  }
}

/**
 * Ingress: telephony audio -> canonical PCM16 mono @ 16 kHz for STT/VAD.
 * Throws INVALID_PAYLOAD on unsupported formats (never misinterprets).
 */
export function normalizeTelephonyAudio(input: Buffer, from: AudioFormat): Buffer {
  assertAudioFormat(from, "Ingress audio");
  const pcm16 = decodeToPcm16(input, from.encoding);
  return resamplePcm16Mono(pcm16, from.sampleRate, PIPELINE_FORMAT.sampleRate);
}

/**
 * Ingress to a container: telephony audio -> WAV bytes (PCM16 mono 16 kHz)
 * ready for file-based STT upload.
 */
export function telephonyToWav(input: Buffer, from: AudioFormat): Buffer {
  return buildWav(normalizeTelephonyAudio(input, from), PIPELINE_FORMAT.sampleRate);
}

/**
 * Egress: pipeline PCM16 @ 16 kHz -> telephony format for playback.
 * The input MUST already be canonical (PCM16 mono 16 kHz).
 */
export function encodeTelephonyAudio(pcm16_16k: Buffer, to: AudioFormat): Buffer {
  assertAudioFormat(to, "Egress audio");
  if (pcm16_16k.length % 2 !== 0) {
    throw new AppError(400, "INVALID_PAYLOAD", "Egress PCM16 buffer length must be even");
  }
  const atRate = resamplePcm16Mono(pcm16_16k, PIPELINE_FORMAT.sampleRate, to.sampleRate);
  switch (to.encoding) {
    case "pcm16":
      return atRate;
    case "mulaw":
      return pcm16ToMulaw(atRate);
    case "alaw":
      return pcm16ToAlaw(atRate);
  }
}

/** Duration of a canonical PCM16 buffer in milliseconds. */
export function pcm16DurationMs(pcm16: Buffer, sampleRate = PIPELINE_FORMAT.sampleRate): number {
  return (pcm16.length / 2 / sampleRate) * 1000;
}
