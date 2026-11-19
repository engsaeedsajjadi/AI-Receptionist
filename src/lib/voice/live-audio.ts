import { decodeMulawByte, encodeMulawSample } from "@/lib/voice/audio";

/**
 * Browser-side audio helpers for the Gemini Live lab: plain typed-array math,
 * no Node Buffer, so they run in the page and in unit tests alike.
 *
 * Gemini Live takes 16-kHz PCM16 and returns 24-kHz PCM16. A real call arrives
 * as 8-kHz G.711 μ-law, so the lab can squeeze both directions through that
 * band to hear what a caller would.
 */
export const LIVE_INPUT_RATE = 16_000;
export const LIVE_OUTPUT_RATE = 24_000;
export const TELEPHONE_RATE = 8_000;

/** Resample mono float audio (box-filter when shrinking, linear when growing). */
export function resampleFloat32(input: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (fromRate === toRate || input.length === 0) return input.slice();
  const outLength = Math.max(1, Math.round((input.length * toRate) / fromRate));
  const out = new Float32Array(outLength);
  const ratio = fromRate / toRate;
  if (ratio > 1) {
    for (let i = 0; i < outLength; i++) {
      const start = Math.floor(i * ratio);
      const end = Math.min(input.length, Math.max(start + 1, Math.floor((i + 1) * ratio)));
      let sum = 0;
      for (let j = start; j < end; j++) sum += input[j];
      out[i] = sum / (end - start);
    }
    return out;
  }
  for (let i = 0; i < outLength; i++) {
    const position = i * ratio;
    const index = Math.floor(position);
    const fraction = position - index;
    const a = input[Math.min(index, input.length - 1)];
    const b = input[Math.min(index + 1, input.length - 1)];
    out[i] = a + (b - a) * fraction;
  }
  return out;
}

function toInt16(sample: number): number {
  const clamped = Math.max(-1, Math.min(1, sample));
  return Math.round(clamped < 0 ? clamped * 32768 : clamped * 32767);
}

/** G.711 μ-law round trip at 8 kHz: the quantization a phone line applies. */
export function telephoneBand(samples8k: Float32Array): Float32Array {
  const out = new Float32Array(samples8k.length);
  for (let i = 0; i < samples8k.length; i++) out[i] = decodeMulawByte(encodeMulawSample(toInt16(samples8k[i]))) / 32768;
  return out;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(binary);
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function float32ToPcm16Base64(samples: Float32Array): string {
  const bytes = new Uint8Array(samples.length * 2);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < samples.length; i++) view.setInt16(i * 2, toInt16(samples[i]), true);
  return bytesToBase64(bytes);
}

export function pcm16Base64ToFloat32(base64: string): Float32Array {
  const bytes = base64ToBytes(base64);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = new Float32Array(Math.floor(bytes.length / 2));
  for (let i = 0; i < out.length; i++) out[i] = view.getInt16(i * 2, true) / 32768;
  return out;
}

/** Microphone block → the 16-kHz PCM16 base64 Gemini Live expects (optionally through a phone line). */
export function micToLiveInput(samples: Float32Array, micRate: number, telephone: boolean): string {
  if (!telephone) return float32ToPcm16Base64(resampleFloat32(samples, micRate, LIVE_INPUT_RATE));
  const narrow = telephoneBand(resampleFloat32(samples, micRate, TELEPHONE_RATE));
  return float32ToPcm16Base64(resampleFloat32(narrow, TELEPHONE_RATE, LIVE_INPUT_RATE));
}

/** Gemini Live 24-kHz chunk → samples to play and their rate (optionally through a phone line). */
export function liveOutputToPlayback(base64: string, telephone: boolean): { samples: Float32Array; sampleRate: number } {
  const samples = pcm16Base64ToFloat32(base64);
  if (!telephone) return { samples, sampleRate: LIVE_OUTPUT_RATE };
  return { samples: telephoneBand(resampleFloat32(samples, LIVE_OUTPUT_RATE, TELEPHONE_RATE)), sampleRate: TELEPHONE_RATE };
}

export function rms(samples: Float32Array): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (const s of samples) sum += s * s;
  return Math.sqrt(sum / samples.length);
}
