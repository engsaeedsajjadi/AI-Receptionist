import { describe, expect, it } from "vitest";
import {
  encodeMulawSample,
  mulawFrames,
  mulawToPcm16,
  pcm16ToMulaw,
  pcmToTelephonyMulaw,
  resamplePcm16,
} from "@/lib/voice/audio";

function pcm16(samples: number[]): Buffer {
  const out = Buffer.allocUnsafe(samples.length * 2);
  samples.forEach((sample, index) => out.writeInt16LE(sample, index * 2));
  return out;
}

describe("G.711 μ-law encoding (telephony egress)", () => {
  it("round-trips samples through the μ-law reference implementation", () => {
    for (const value of [0, 1, -1, 100, -100, 1000, -1000, 8000, -8000, 30000, -30000]) {
      const encoded = encodeMulawSample(value);
      expect(encoded).toBeGreaterThanOrEqual(0);
      expect(encoded).toBeLessThanOrEqual(255);
      const decoded = mulawToPcm16(Buffer.from([encoded])).readInt16LE(0);
      // μ-law is lossy: assert the decoded value is within one quantization step.
      expect(Math.abs(decoded - value)).toBeLessThan(1300);
    }
  });

  it("clips out-of-range input instead of wrapping", () => {
    const clipped = mulawToPcm16(Buffer.from([encodeMulawSample(32000)])).readInt16LE(0);
    expect(clipped).toBeGreaterThan(30000);
    expect(mulawToPcm16(Buffer.from([encodeMulawSample(-32000)])).readInt16LE(0)).toBeLessThan(-30000);
  });

  it("encodes PCM16 buffers byte-for-byte deterministically", () => {
    const pcm = pcm16([0, 100, -100, 2000, -2000]);
    const mulaw = pcm16ToMulaw(pcm);
    expect(mulaw.length).toBe(5);
    expect(pcm16ToMulaw(pcm).equals(mulaw)).toBe(true);
    expect(pcm16ToMulaw(Buffer.alloc(1)).length).toBe(0);
  });
});

describe("Resampling for 8 kHz telephony", () => {
  it("decimates 24 kHz TTS audio to 8 kHz at a third of the sample count", () => {
    const source = pcm16(Array.from({ length: 300 }, (_, index) => Math.round(Math.sin(index / 5) * 8000)));
    const resampled = resamplePcm16(source, 24_000, 8_000);
    expect(resampled.length / 2).toBe(100);
    expect(resampled.length).toBeGreaterThan(0);
  });

  it("returns the input unchanged when rates match and handles empty input", () => {
    const pcm = pcm16([1, 2, 3]);
    expect(resamplePcm16(pcm, 8000, 8000)).toBe(pcm);
    expect(resamplePcm16(Buffer.alloc(0), 24_000, 8_000).length).toBe(0);
    expect(resamplePcm16(pcm16([5]), 24_000, 8_000).length / 2).toBe(1);
  });

  it("upsamples 8 kHz to 16 kHz for STT consumers", () => {
    const resampled = resamplePcm16(pcm16([100, 200, 300, 400]), 8_000, 16_000);
    expect(resampled.length / 2).toBe(8);
    expect(resampled.readInt16LE(0)).toBe(100);
  });
});

describe("Telephony framing", () => {
  it("converts 24 kHz PCM to 20 ms μ-law frames", () => {
    const source = pcm16(Array.from({ length: 720 }, (_, index) => (index % 20) * 30));
    const mulaw = pcmToTelephonyMulaw(source, 24_000, 8_000);
    expect(mulaw.length).toBe(240);
    const frames = mulawFrames(mulaw);
    expect(frames.length).toBe(2);
    expect(frames[0].length).toBe(160);
    expect(frames[1].length).toBe(80);
    expect(mulawFrames(mulaw, 100).length).toBe(3);
    expect(mulawFrames(Buffer.alloc(0))).toEqual([]);
  });
});
