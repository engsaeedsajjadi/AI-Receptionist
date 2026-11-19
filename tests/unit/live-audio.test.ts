import { describe, expect, it } from "vitest";
import {
  LIVE_OUTPUT_RATE,
  TELEPHONE_RATE,
  float32ToPcm16Base64,
  liveOutputToPlayback,
  micToLiveInput,
  pcm16Base64ToFloat32,
  resampleFloat32,
  rms,
  telephoneBand,
} from "@/lib/voice/live-audio";

function tone(rate: number, seconds: number, hz = 300, amplitude = 0.5): Float32Array {
  const out = new Float32Array(Math.round(rate * seconds));
  for (let i = 0; i < out.length; i++) out[i] = amplitude * Math.sin((2 * Math.PI * hz * i) / rate);
  return out;
}

describe("Gemini Live browser audio helpers", () => {
  it("resamples to the expected length in both directions and keeps level", () => {
    const mic = tone(48_000, 0.1);
    const down = resampleFloat32(mic, 48_000, 16_000);
    expect(down.length).toBe(1_600);
    expect(rms(down)).toBeCloseTo(rms(mic), 1);
    const up = resampleFloat32(tone(8_000, 0.1), 8_000, 16_000);
    expect(up.length).toBe(1_600);
    expect(resampleFloat32(new Float32Array(0), 48_000, 16_000).length).toBe(0);
    const same = resampleFloat32(mic, 16_000, 16_000);
    expect(same).not.toBe(mic);
    expect(same).toEqual(mic);
  });

  it("round-trips PCM16 through base64 within one quantization step and clamps overload", () => {
    const samples = new Float32Array([0, 0.25, -0.25, 0.999, -1, 2, -2]);
    const back = pcm16Base64ToFloat32(float32ToPcm16Base64(samples));
    expect(back.length).toBe(samples.length);
    for (let i = 0; i < 5; i++) expect(Math.abs(back[i] - samples[i])).toBeLessThan(1 / 16_000);
    expect(back[5]).toBeCloseTo(32767 / 32768, 5);
    expect(back[6]).toBe(-1);
  });

  it("applies G.711 μ-law quantization like a phone line (small, level-dependent error)", () => {
    const line = tone(TELEPHONE_RATE, 0.05);
    const narrow = telephoneBand(line);
    let maxError = 0;
    for (let i = 0; i < line.length; i++) maxError = Math.max(maxError, Math.abs(narrow[i] - line[i]));
    expect(maxError).toBeGreaterThan(0);
    expect(maxError).toBeLessThan(0.02);
  });

  it("produces 16-kHz input with or without the telephone band", () => {
    const block = tone(48_000, 0.1);
    for (const telephone of [false, true]) {
      const pcm = pcm16Base64ToFloat32(micToLiveInput(block, 48_000, telephone));
      expect(pcm.length).toBe(1_600);
      expect(rms(pcm)).toBeGreaterThan(0.25);
    }
  });

  it("plays 24-kHz output natively, or narrowed to 8 kHz for the telephone band", () => {
    const chunk = float32ToPcm16Base64(tone(LIVE_OUTPUT_RATE, 0.2));
    const wide = liveOutputToPlayback(chunk, false);
    expect(wide.sampleRate).toBe(24_000);
    expect(wide.samples.length).toBe(4_800);
    const narrow = liveOutputToPlayback(chunk, true);
    expect(narrow.sampleRate).toBe(8_000);
    expect(narrow.samples.length).toBe(1_600);
    expect(rms(narrow.samples)).toBeGreaterThan(0.25);
  });

  it("rms of silence and empty input is zero", () => {
    expect(rms(new Float32Array(0))).toBe(0);
    expect(rms(new Float32Array(160))).toBe(0);
  });
});
