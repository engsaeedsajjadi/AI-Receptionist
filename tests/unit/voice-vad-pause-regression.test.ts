import { describe, expect, it } from "vitest";
import { EnergyVAD, encodeMulawSample } from "@/lib/voice/audio";

/**
 * Offline reproduction of VOICE-10–16 (2026-10-08 test history).
 *
 * TTS-generated segments had about 360 ms trailing silence and 340 ms
 * leading silence. Combined with an inserted 900 ms pause, the VAD sees
 * 1,600 ms of continuous silence. No provider or network calls are used.
 */
const SAMPLE_RATE = 8_000;
const FRAME_MS = 20;
const FRAME_SAMPLES = (SAMPLE_RATE * FRAME_MS) / 1_000;

function frame(speech: boolean): Buffer {
  if (!speech) return Buffer.alloc(FRAME_SAMPLES, 0xff); // G.711 μ-law silence
  const output = Buffer.alloc(FRAME_SAMPLES);
  for (let index = 0; index < output.length; index++) {
    const pcmSample = Math.round(9_000 * Math.sin((2 * Math.PI * 440 * index) / SAMPLE_RATE));
    output[index] = encodeMulawSample(pcmSample);
  }
  return output;
}

type Phase = { name: string; speech: boolean; durationMs: number };
const PHASES: Phase[] = [
  { name: "first-speech", speech: true, durationMs: 600 },
  { name: "tts-tail-silence", speech: false, durationMs: 360 },
  { name: "inserted-pause", speech: false, durationMs: 900 },
  { name: "tts-head-silence", speech: false, durationMs: 340 },
  { name: "second-speech", speech: true, durationMs: 600 },
  { name: "final-silence", speech: false, durationMs: 2_000 },
];

function simulate(silenceMs: number): Array<{ phase: string; atMs: number }> {
  const vad = new EnergyVAD({
    enabled: true,
    codec: "mulaw",
    sampleRate: SAMPLE_RATE,
    speechThreshold: 0.015,
    silenceMs,
    minSpeechMs: 180,
    maxUtteranceMs: 12_000,
  });
  let elapsedMs = 0;
  const endpoints: Array<{ phase: string; atMs: number }> = [];
  for (const phase of PHASES) {
    expect(phase.durationMs % FRAME_MS).toBe(0);
    const chunk = frame(phase.speech);
    for (let ms = 0; ms < phase.durationMs; ms += FRAME_MS) {
      const result = vad.process(chunk);
      elapsedMs += FRAME_MS;
      if (result.utteranceEnd) endpoints.push({ phase: phase.name, atMs: elapsedMs });
    }
  }
  return endpoints;
}

describe("voice endpointing / 900 ms mid-utterance pause", () => {
  it("reproduces early endpointing at 700 ms", () => {
    expect(simulate(700)).toEqual([
      { phase: "inserted-pause", atMs: 1_300 },
      { phase: "final-silence", atMs: 3_500 },
    ]);
  });

  it("reproduces early endpointing at 1200 ms (actual combined silence: 1600 ms)", () => {
    expect(simulate(1_200)).toEqual([
      { phase: "inserted-pause", atMs: 1_800 },
      { phase: "final-silence", atMs: 4_000 },
    ]);
  });

  it("keeps both speech segments together at 1800 ms and endpoints after the final silence", () => {
    expect(simulate(1_800)).toEqual([{ phase: "final-silence", atMs: 4_600 }]);
  });

  it("also keeps both segments together at 1601 ms (strictly above the 1600 ms gap)", () => {
    expect(simulate(1_601)).toEqual([{ phase: "final-silence", atMs: 4_420 }]);
  });
});
