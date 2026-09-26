import { describe, expect, it } from "vitest";
import {
  G711,
  alawDecodeByte,
  alawToPcm16,
  mulawDecodeByte,
  mulawEncodeSample,
  mulawToPcm16,
  pcm16ToAlaw,
  pcm16ToMulaw,
  alawEncodeSample,
} from "@/lib/audio/codecs";
import { pcmNoise, pcmRms, pcmSilence, pcmSine } from "../helpers/audio";

describe("G.711 mu-law", () => {
  it("decodes the silence anchor: 0xFF -> 0", () => {
    expect(mulawDecodeByte(0xff)).toBe(0);
  });

  it("encodes zero canonically: 0 -> 0xFF", () => {
    expect(mulawEncodeSample(0)).toBe(G711.MULAW_ZERO_CANONICAL);
  });

  it("round-trips every code (0x7F is the known +0 alias of 0xFF)", () => {
    for (let code = 0; code < 256; code++) {
      const back = mulawEncodeSample(mulawDecodeByte(code));
      if (code === 0x7f) {
        expect(back).toBe(0xff);
      } else {
        expect(back).toBe(code);
      }
    }
  });

  it("clips out-of-range samples to the extreme codes", () => {
    expect(mulawDecodeByte(mulawEncodeSample(32767))).toBe(G711.MULAW_MAX_MAGNITUDE);
    expect(mulawDecodeByte(mulawEncodeSample(-32768))).toBe(-G711.MULAW_MAX_MAGNITUDE);
  });

  it("keeps PCM round-trip error within the quantisation step", () => {
    const tone = pcmSine(200);
    const back = mulawToPcm16(pcm16ToMulaw(tone));
    expect(back.length).toBe(tone.length);
    let maxErr = 0;
    for (let i = 0; i < tone.length; i += 2) {
      maxErr = Math.max(maxErr, Math.abs(back.readInt16LE(i) - tone.readInt16LE(i)));
    }
    expect(maxErr).toBeLessThanOrEqual(1024);
    // Energy is preserved (no systematic attenuation).
    expect(Math.abs(pcmRms(back) - pcmRms(tone)) / pcmRms(tone)).toBeLessThan(0.1);
  });

  it("maps silence bytes to silence samples", () => {
    const pcm = mulawToPcm16(Buffer.alloc(160, 0xff));
    expect(pcm.length).toBe(320);
    expect(pcmRms(pcm)).toBe(0);
  });

  it("rejects odd-length PCM16 buffers", () => {
    expect(() => pcm16ToMulaw(Buffer.alloc(3))).toThrow(RangeError);
  });
});

describe("G.711 A-law", () => {
  it("decodes the idle anchor: 0xD5 -> +8 (A-law has no true zero)", () => {
    expect(alawDecodeByte(0xd5)).toBe(8);
  });

  it("round-trips every code exactly", () => {
    for (let code = 0; code < 256; code++) {
      expect(alawEncodeSample(alawDecodeByte(code))).toBe(code);
    }
  });

  it("clips out-of-range samples to the extreme codes", () => {
    expect(alawDecodeByte(alawEncodeSample(32767))).toBe(G711.ALAW_MAX_MAGNITUDE);
    expect(alawDecodeByte(alawEncodeSample(-32768))).toBe(-G711.ALAW_MAX_MAGNITUDE);
  });

  it("keeps PCM round-trip error within the quantisation step", () => {
    const noise = pcmNoise(200, 8000);
    const back = alawToPcm16(pcm16ToAlaw(noise));
    let maxErr = 0;
    for (let i = 0; i < noise.length; i += 2) {
      maxErr = Math.max(maxErr, Math.abs(back.readInt16LE(i) - noise.readInt16LE(i)));
    }
    expect(maxErr).toBeLessThanOrEqual(2048);
  });

  it("maps idle bytes to near-silence", () => {
    const pcm = alawToPcm16(Buffer.alloc(160, 0xd5));
    expect(pcmRms(pcm)).toBeLessThanOrEqual(8);
  });

  it("rejects odd-length PCM16 buffers", () => {
    expect(() => pcm16ToAlaw(Buffer.alloc(3))).toThrow(RangeError);
  });
});

describe("silence fixture sanity", () => {
  it("generates true digital silence", () => {
    expect(pcmRms(pcmSilence(100))).toBe(0);
  });
});
