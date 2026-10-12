/** Telephony audio helpers. Supports the common G.711 μ-law 8kHz mono format. */

export type AudioCodec = "pcm_s16le" | "mulaw" | "unknown";

export type AudioFormat = {
  codec: AudioCodec;
  sampleRate: number;
  channels: 1;
};

const MULAW_BIAS = 0x84;
const MULAW_CLIP = 32635;

/** Decode one G.711 μ-law byte to signed 16-bit PCM. */
export function decodeMulawByte(value: number): number {
  const u = (~value) & 0xff;
  const sign = u & 0x80;
  const exponent = (u >> 4) & 0x07;
  const mantissa = u & 0x0f;
  const magnitude = ((mantissa << 3) + MULAW_BIAS) << exponent;
  return sign ? MULAW_BIAS - magnitude : magnitude - MULAW_BIAS;
}

/** Compute normalized RMS energy for a PCM16 or μ-law mono frame. */
export function frameRms(frame: Buffer, codec: AudioCodec): number {
  if (frame.length === 0) return 0;
  let sum = 0;
  let count = 0;
  if (codec === "mulaw") {
    for (let i = 0; i < frame.length; i++) {
      const sample = decodeMulawByte(frame[i]);
      sum += sample * sample;
      count += 1;
    }
  } else if (codec === "pcm_s16le") {
    const usable = frame.length - (frame.length % 2);
    for (let i = 0; i < usable; i += 2) {
      const sample = frame.readInt16LE(i);
      sum += sample * sample;
      count += 1;
    }
  } else {
    return 0;
  }
  if (!count) return 0;
  return Math.sqrt(sum / count) / 32768;
}

export type VADConfig = {
  enabled: boolean;
  codec: AudioCodec;
  sampleRate: number;
  speechThreshold: number;
  silenceMs: number;
  minSpeechMs: number;
  maxUtteranceMs: number;
};

/**
 * Small frame-level VAD. It deliberately does not claim speech recognition;
 * it only detects speech/silence boundaries from audio energy.
 */
export class EnergyVAD {
  private speechMs = 0;
  private silenceMs = 0;
  private active = false;
  private noiseFloor: number | null = null;

  constructor(private readonly config: VADConfig) {}

  get isActive(): boolean {
    return this.active;
  }

  reset(): void {
    this.speechMs = 0;
    this.silenceMs = 0;
    this.active = false;
    this.noiseFloor = null;
  }

  /**
   * Detect a stable voiced component during cold start.
   * This supplements the energy gate; it is not speech recognition.
   */
  /**
   * Suppress common steady telephone signaling tones.
   * Uses normalized spectral concentration rather than RMS alone.
   * This is a narrow tone filter, not a general speech classifier.
   */
  private isKnownTelephoneTone(frame: Buffer, rms: number): boolean {
    if (rms < this.config.speechThreshold) return false;

    const codec = this.config.codec;

    if (codec !== "mulaw" && codec !== "pcm_s16le") {
      return false;
    }

    const count =
      codec === "mulaw"
        ? frame.length
        : Math.floor(frame.length / 2);

    if (count < 80 || this.config.sampleRate <= 0) {
      return false;
    }

    const samples = new Float64Array(count);
    let mean = 0;

    for (let i = 0; i < count; i++) {
      const value =
        codec === "mulaw"
          ? decodeMulawByte(frame[i])
          : frame.readInt16LE(i * 2);

      samples[i] = value;
      mean += value;
    }

    mean /= count;

    let energy = 0;

    for (let i = 0; i < count; i++) {
      samples[i] -= mean;
      energy += samples[i] * samples[i];
    }

    if (energy <= 0) return false;

    const spectralScore = (frequency: number): number => {
      let sineProjection = 0;
      let cosineProjection = 0;

      for (let i = 0; i < count; i++) {
        const phase =
          (2 * Math.PI * frequency * i) /
          this.config.sampleRate;

        sineProjection += samples[i] * Math.sin(phase);
        cosineProjection += samples[i] * Math.cos(phase);
      }

      return (
        2 *
        (
          sineProjection * sineProjection +
          cosineProjection * cosineProjection
        )
      ) / (count * energy);
    };

    const score425 = spectralScore(425);
    const score440 = spectralScore(440);

    // Strong, nearly pure 425Hz or 440Hz telephone tone.
    if (score425 >= 0.90 || score440 >= 0.90) {
      return true;
    }

    // Dual-frequency 350Hz + 440Hz dial tone.
    const score350 = spectralScore(350);

    return (
      score350 >= 0.22 &&
      score440 >= 0.22 &&
      score350 + score440 >= 0.80
    );
  }

  private hasVoicedPeriodicity(frame: Buffer): boolean {
    const codec = this.config.codec;

    if (codec !== "mulaw" && codec !== "pcm_s16le") {
      return false;
    }

    const count =
      codec === "mulaw"
        ? frame.length
        : Math.floor(frame.length / 2);

    if (count < 80) return false;

    const samples = new Float64Array(count);
    let sum = 0;

    for (let i = 0; i < count; i++) {
      const value =
        codec === "mulaw"
          ? decodeMulawByte(frame[i])
          : frame.readInt16LE(i * 2);

      samples[i] = value;
      sum += value;
    }

    // Remove DC offset before calculating autocorrelation.
    const mean = sum / count;

    for (let i = 0; i < count; i++) {
      samples[i] -= mean;
    }

    const minLag = Math.max(
      2,
      Math.floor(this.config.sampleRate / 420),
    );

    const maxLag = Math.min(
      Math.floor(count / 2),
      Math.ceil(this.config.sampleRate / 90),
    );

    let strongestCorrelation = 0;

    for (let lag = minLag; lag <= maxLag; lag++) {
      let correlation = 0;
      let energyA = 0;
      let energyB = 0;

      for (let i = lag; i < count; i++) {
        const a = samples[i];
        const b = samples[i - lag];

        correlation += a * b;
        energyA += a * a;
        energyB += b * b;
      }

      if (energyA <= 0 || energyB <= 0) continue;

      const normalized =
        correlation / Math.sqrt(energyA * energyB);

      strongestCorrelation = Math.max(
        strongestCorrelation,
        normalized,
      );
    }

    return strongestCorrelation >= 0.65;
  }

  process(frame: Buffer): { speech: boolean; utteranceEnd: boolean } {
    if (!this.config.enabled || !frame.length || !this.config.sampleRate) {
      return { speech: false, utteranceEnd: false };
    }

    const samples =
      this.config.codec === "mulaw"
        ? frame.length
        : Math.floor(frame.length / 2);

    const durationMs = Math.max(
      1,
      (samples / this.config.sampleRate) * 1000,
    );

    const rms = frameRms(frame, this.config.codec);
    const baseThreshold = this.config.speechThreshold;

    // Before a noise estimate exists, require a clearer speech onset.
    // Once background noise is observed, use a relative energy gate.
    const adaptiveThreshold =
      this.noiseFloor === null
        ? baseThreshold * 2.2
        : Math.max(baseThreshold, this.noiseFloor * 1.7);

    // A sudden rise in broadband noise is not sufficient evidence
    // of speech. Require either voiced periodicity or a clearly
    // stronger signal than both the base threshold and noise floor.
    const voicedSpeech =
      rms >= baseThreshold &&
      this.hasVoicedPeriodicity(frame);

    const clearlyAboveNoise =
      rms >= adaptiveThreshold &&
      rms >= Math.max(
        baseThreshold * 3,
        (this.noiseFloor ?? 0) * 3,
      );

    const speech =
      !this.isKnownTelephoneTone(frame, rms) &&
      (voicedSpeech || clearlyAboveNoise);

    if (!speech) {
      // Update the ambient noise estimate only from likely noise frames.
      // A small smoothing factor prevents abrupt baseline changes.
      const noiseLimit = Math.max(
        baseThreshold * 3,
        (this.noiseFloor ?? 0) * 2,
      );

      if (rms <= noiseLimit) {
        this.noiseFloor =
          this.noiseFloor === null
            ? rms
            : this.noiseFloor * 0.95 + rms * 0.05;
      }
    }

    if (speech) {
      this.speechMs += durationMs;
      this.silenceMs = 0;

      if (this.speechMs >= this.config.minSpeechMs) {
        this.active = true;
      }
    } else if (this.active) {
      this.silenceMs += durationMs;
    } else {
      // Before activation, speech must be consecutive.
      this.speechMs = 0;
    }

    const utteranceEnd =
      this.active &&
      (
        this.silenceMs >= this.config.silenceMs ||
        this.speechMs >= this.config.maxUtteranceMs
      );

    if (utteranceEnd) {
      // Preserve the learned noise floor across consecutive turns.
      this.speechMs = 0;
      this.silenceMs = 0;
      this.active = false;
    }

    return { speech, utteranceEnd };
  }
}
/** Convert G.711 μ-law mono audio to PCM16 little-endian. */
export function mulawToPcm16(input: Buffer): Buffer {
  const out = Buffer.allocUnsafe(input.length * 2);
  for (let i = 0; i < input.length; i++) out.writeInt16LE(decodeMulawByte(input[i]), i * 2);
  return out;
}

/** Wrap PCM16 mono samples in a standard RIFF/WAV container. */
export function pcm16ToWav(pcm: Buffer, sampleRate: number): Buffer {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

/** Normalize common telephony audio into a STT-safe WAV payload. */
export function normalizeTelephonyAudio(input: Buffer, codec: AudioCodec, sampleRate: number): {
  audio: Buffer;
  mimeType: string;
  filename: string;
} {
  if (codec === "mulaw") {
    return { audio: pcm16ToWav(mulawToPcm16(input), sampleRate), mimeType: "audio/wav", filename: "call-audio.wav" };
  }
  if (codec === "pcm_s16le") {
    return { audio: pcm16ToWav(input, sampleRate), mimeType: "audio/wav", filename: "call-audio.wav" };
  }
  return { audio: input, mimeType: "audio/mpeg", filename: "call-audio.bin" };
}

// ---------------------------------------------------------------------------
// PCM16 → G.711 μ-law (telephony egress)
// ---------------------------------------------------------------------------


/**
 * Encode one signed 16-bit sample as a G.711 μ-law byte.
 * Standard bit-exact algorithm (same table every telephony stack uses).
 */
export function encodeMulawSample(sample: number): number {
  let sign = 0;
  let value = sample;
  if (value < 0) {
    value = -value;
    sign = 0x80;
  }
  if (value > MULAW_CLIP) value = MULAW_CLIP;
  value += MULAW_BIAS;
  let exponent = 7;
  for (let mask = 0x4000; (value & mask) === 0 && exponent > 0; mask >>= 1) exponent -= 1;
  const mantissa = (value >> (exponent + 3)) & 0x0f;
  return ~(sign | (exponent << 4) | mantissa) & 0xff;
}

/** Convert little-endian PCM16 mono audio to μ-law bytes. */
export function pcm16ToMulaw(pcm: Buffer): Buffer {
  const samples = Math.floor(pcm.length / 2);
  const out = Buffer.allocUnsafe(samples);
  for (let i = 0; i < samples; i++) out[i] = encodeMulawSample(pcm.readInt16LE(i * 2));
  return out;
}

/**
 * Resample little-endian PCM16 mono audio with linear interpolation.
 * Used to bring provider TTS (24 kHz) down to telephony rates (8 kHz).
 */
export function resamplePcm16(pcm: Buffer, fromRate: number, toRate: number): Buffer {
  if (fromRate === toRate || fromRate <= 0 || toRate <= 0) return pcm;
  const inSamples = Math.floor(pcm.length / 2);
  if (inSamples === 0) return Buffer.alloc(0);
  const outSamples = Math.max(1, Math.round((inSamples * toRate) / fromRate));
  const out = Buffer.allocUnsafe(outSamples * 2);
  const ratio = (inSamples - 1) / Math.max(1, outSamples - 1);
  for (let i = 0; i < outSamples; i++) {
    const position = i * ratio;
    const index = Math.floor(position);
    const fraction = position - index;
    const a = pcm.readInt16LE(index * 2);
    const b = index + 1 < inSamples ? pcm.readInt16LE((index + 1) * 2) : a;
    out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(a + (b - a) * fraction))), i * 2);
  }
  return out;
}

/** Full provider-TTS → telephony path: resample to 8 kHz then μ-law encode. */
export function pcmToTelephonyMulaw(pcm: Buffer, fromRate = 24_000, toRate = 8_000): Buffer {
  return pcm16ToMulaw(resamplePcm16(pcm, fromRate, toRate));
}

/** Split μ-law audio into 20 ms telephony frames (160 bytes at 8 kHz). */
export function mulawFrames(mulaw: Buffer, frameBytes = 160): Buffer[] {
  const frames: Buffer[] = [];
  for (let offset = 0; offset < mulaw.length; offset += frameBytes) {
    frames.push(mulaw.subarray(offset, Math.min(mulaw.length, offset + frameBytes)));
  }
  return frames;
}
