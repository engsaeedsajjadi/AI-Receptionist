import { describe, expect, it } from "vitest";
import { assessLocalTelephonyInput, encodeLocalTelephonyOutput } from "@/lib/voice/local-telephony";
import { pcm16ToMulaw } from "@/lib/voice/audio";

describe("local telephone lab: real codec, no PSTN", () => {
  it("accepts 2s PCM voice converted to 8 kHz G.711 and reports frames", () => {
    const pcm = Buffer.alloc(8_000 * 2 * 2);
    for (let i = 0; i < 16_000; i++) {
      pcm.writeInt16LE(Math.round(10000 * Math.sin(2 * Math.PI * 230 * i / 8000)), 2 * i);
    }
    const input = assessLocalTelephonyInput(pcm16ToMulaw(pcm));
    expect(input.durationSeconds).toBe(2);
    expect(input.rms).toBeGreaterThan(0.01);
    expect(input.frames20ms).toBe(100);
  });
  it("blocks silent telephone audio before any STT usage", () => {
    expect(() => assessLocalTelephonyInput(Buffer.alloc(16_000, 0xff))).toThrow(/silent/);
  });
  it("blocks too short and overlong caller audio", () => {
    expect(() => assessLocalTelephonyInput(Buffer.alloc(4000, 0))).toThrow(/between/);
    expect(() => assessLocalTelephonyInput(Buffer.alloc(20 * 8_000 + 1, 0))).toThrow(/between/);
  });
  it("encodes 24 kHz raw PCM to 8 kHz G.711 and playable WAV", () => {
    const pcm = Buffer.alloc(48_000, 0);
    for (let i = 0; i < 24_000; i++)
      pcm.writeInt16LE(Math.round(9000 * Math.sin(2 * Math.PI * 220 * i / 24_000)), 2 * i);
    const output = encodeLocalTelephonyOutput(pcm, "audio/l16");
    expect(output.mulawBytes).toBe(8000);
    expect(output.frames20ms).toBe(50);
    expect(output.wav.subarray(0, 4).toString()).toBe("RIFF");
    expect(output.wav.readUInt32LE(24)).toBe(8000);
  });
  it("rejects provider containers masquerading as raw PCM", () => {
    expect(() => encodeLocalTelephonyOutput(Buffer.from("ID3example"), "audio/mpeg")).toThrow(/raw 24 kHz PCM16/);
    expect(() => encodeLocalTelephonyOutput(Buffer.from("RIFF" + "000000WAVE"), "audio/l16")).toThrow(/raw 24 kHz PCM16/);
  });
});
