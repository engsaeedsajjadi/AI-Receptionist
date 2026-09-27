/** Telephony audio helpers. Supports the common G.711 μ-law 8kHz mono format. */

export type AudioCodec = "pcm_s16le" | "mulaw" | "unknown";

export type AudioFormat = {
  codec: AudioCodec;
  sampleRate: number;
  channels: 1;
};

const MULAW_BIAS = 0x84;

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

  constructor(private readonly config: VADConfig) {}

  get isActive(): boolean {
    return this.active;
  }

  reset(): void {
    this.speechMs = 0;
    this.silenceMs = 0;
    this.active = false;
  }

  process(frame: Buffer): { speech: boolean; utteranceEnd: boolean } {
    if (!this.config.enabled || !frame.length || !this.config.sampleRate) {
      return { speech: false, utteranceEnd: false };
    }
    const samples = this.config.codec === "mulaw" ? frame.length : Math.floor(frame.length / 2);
    const durationMs = Math.max(1, (samples / this.config.sampleRate) * 1000);
    const speech = frameRms(frame, this.config.codec) >= this.config.speechThreshold;

    if (speech) {
      this.speechMs += durationMs;
      this.silenceMs = 0;
      if (this.speechMs >= this.config.minSpeechMs) this.active = true;
    } else if (this.active) {
      this.silenceMs += durationMs;
    }

    const utteranceEnd = this.active && (
      this.silenceMs >= this.config.silenceMs ||
      this.speechMs >= this.config.maxUtteranceMs
    );

    if (utteranceEnd) this.reset();
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
