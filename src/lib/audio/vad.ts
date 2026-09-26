import { AppError } from "@/lib/errors";

/**
 * Energy-based voice activity detection over canonical PCM16 mono (§10).
 *
 * The gateway remains free to do its own VAD and send `utterance-end`, but
 * the server can now segment raw streams itself: push 16 kHz PCM16, get
 * speech-start / speech-end events. Deterministic, dependency-free, and
 * fully testable with synthetic fixtures.
 *
 * Algorithm (20 ms frames, RMS energy vs threshold):
 * - `speech-start` when voiced audio reaches `minSpeechMs` (shorter bursts
 *   are treated as noise and ignored — this is the noise gate).
 * - `speech-end` when trailing silence reaches `silenceMs`.
 * - `max-utterance` force-ends an utterance at `maxUtteranceMs` so a caller
 *   who never pauses still yields bounded turns (no infinite waiting).
 *
 * Thresholds come from VOICE_VAD_* env (see `defaultVadConfig`); callers
 * MUST NOT hardcode telephony tuning.
 */

export type VadConfig = {
  silenceMs: number;
  minSpeechMs: number;
  maxUtteranceMs: number;
  /** RMS energy (PCM16 units) below which a frame counts as silence. */
  silenceRms: number;
  sampleRate: number;
};

export type VadEvent = "speech-start" | "speech-end" | "max-utterance";

export type VadState = "silence" | "speech";

/** 20 ms analysis frames. */
export const VAD_FRAME_MS = 20;

export function defaultVadConfig(env: {
  VOICE_VAD_SILENCE_MS: number;
  VOICE_VAD_MIN_SPEECH_MS: number;
  VOICE_VAD_MAX_UTTERANCE_MS: number;
  VOICE_VAD_SILENCE_RMS: number;
}): VadConfig {
  return {
    silenceMs: env.VOICE_VAD_SILENCE_MS,
    minSpeechMs: env.VOICE_VAD_MIN_SPEECH_MS,
    maxUtteranceMs: env.VOICE_VAD_MAX_UTTERANCE_MS,
    silenceRms: env.VOICE_VAD_SILENCE_RMS,
    sampleRate: 16000,
  };
}

function frameRms(pcm16: Buffer, start: number, samples: number): number {
  let sum = 0;
  for (let i = 0; i < samples; i++) {
    const s = pcm16.readInt16LE(start + i * 2);
    sum += s * s;
  }
  return Math.sqrt(sum / samples);
}

export class EnergyVad {
  private readonly frameSamples: number;
  private carry: Buffer = Buffer.alloc(0);
  private state: VadState = "silence";
  private voicedMs = 0;
  private silentMs = 0;
  /** Voiced-audio ms accumulated in the current utterance (excludes silence). */
  private utteranceSpeechMs = 0;
  /** Wall-clock ms since the utterance started (bounds runaway speech). */
  private utteranceElapsedMs = 0;

  constructor(private readonly config: VadConfig) {
    if (config.sampleRate <= 0 || config.silenceMs <= 0 || config.minSpeechMs <= 0 || config.maxUtteranceMs <= 0) {
      throw new AppError(400, "INVALID_PAYLOAD", "VAD config values must be positive");
    }
    this.frameSamples = Math.floor((config.sampleRate * VAD_FRAME_MS) / 1000);
  }

  get currentState(): VadState {
    return this.state;
  }

  /** Push canonical PCM16 mono @ config.sampleRate. Returns fired events. */
  push(pcm16: Buffer): VadEvent[] {
    if (pcm16.length % 2 !== 0) {
      throw new AppError(400, "INVALID_PAYLOAD", "VAD input must be PCM16 (even length)");
    }
    const events: VadEvent[] = [];
    let data = this.carry.length > 0 ? Buffer.concat([this.carry, pcm16]) : pcm16;
    const frameBytes = this.frameSamples * 2;
    let offset = 0;
    while (offset + frameBytes <= data.length) {
      const voiced = frameRms(data, offset, this.frameSamples) >= this.config.silenceRms;
      offset += frameBytes;
      const event = this.advance(voiced);
      if (event) events.push(event);
    }
    this.carry = data.subarray(offset);
    return events;
  }

  /** Flush buffered partial frame state (does not end an utterance). */
  reset(): void {
    this.carry = Buffer.alloc(0);
    this.state = "silence";
    this.voicedMs = 0;
    this.silentMs = 0;
    this.utteranceSpeechMs = 0;
    this.utteranceElapsedMs = 0;
  }

  private advance(voiced: boolean): VadEvent | null {
    if (this.state === "silence") {
      if (!voiced) {
        this.voicedMs = 0;
        return null;
      }
      this.voicedMs += VAD_FRAME_MS;
      if (this.voicedMs >= this.config.minSpeechMs) {
        this.state = "speech";
        this.silentMs = 0;
        this.utteranceSpeechMs = this.voicedMs;
        this.utteranceElapsedMs = this.voicedMs;
        this.voicedMs = 0;
        return "speech-start";
      }
      return null;
    }
    // state === "speech"
    this.utteranceElapsedMs += VAD_FRAME_MS;
    if (this.utteranceElapsedMs >= this.config.maxUtteranceMs) {
      this.endUtterance();
      return "max-utterance";
    }
    if (voiced) {
      this.silentMs = 0;
      this.utteranceSpeechMs += VAD_FRAME_MS;
      return null;
    }
    this.silentMs += VAD_FRAME_MS;
    if (this.silentMs >= this.config.silenceMs) {
      this.endUtterance();
      return "speech-end";
    }
    return null;
  }

  private endUtterance(): void {
    this.state = "silence";
    this.voicedMs = 0;
    this.silentMs = 0;
    this.utteranceSpeechMs = 0;
    this.utteranceElapsedMs = 0;
  }
}
