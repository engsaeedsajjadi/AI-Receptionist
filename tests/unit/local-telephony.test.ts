import { describe, expect, it } from "vitest";
import { assessLocalTelephonyInput, assessLocalAgentReadiness, encodeLocalTelephonyOutput, validateLocalHighQualitySttWav } from "@/lib/voice/local-telephony";
import { pcm16ToMulaw, pcm16ToWav } from "@/lib/voice/audio";

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
  it("accepts a matching 16-kHz mono microphone WAV for local STT only", () => {
    const audio = pcm16ToWav(Buffer.alloc(2 * 16_000 * 2), 16_000);
    expect(validateLocalHighQualitySttWav(audio, 2)).toEqual(audio);
  });
  it("rejects unrelated, truncated, wrong-rate and stereo WAV inputs", () => {
    const wav = pcm16ToWav(Buffer.alloc(2 * 16_000 * 2), 16_000);
    expect(() => validateLocalHighQualitySttWav(wav, 3)).toThrow(/matching/);
    expect(() => validateLocalHighQualitySttWav(wav.subarray(0, 100), 2)).toThrow(/matching/);
    const wrongRate = pcm16ToWav(Buffer.alloc(2 * 8_000 * 2), 8_000);
    expect(() => validateLocalHighQualitySttWav(wrongRate, 2)).toThrow(/matching/);
    const stereo = Buffer.from(wav);
    stereo.writeUInt16LE(2, 22);
    expect(() => validateLocalHighQualitySttWav(stereo, 2)).toThrow(/matching/);
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

describe("local telephone lab AI provider preflight", () => {
  it("blocks without configured speech and language providers", () => {
    const result = assessLocalAgentReadiness({});
    expect(result.ready).toBe(false);
    expect(result.reasons).toHaveLength(3);
  });
  it("rejects incomplete Gemini configuration without exposing the API key", () => {
    const result = assessLocalAgentReadiness({
      LLM_PROVIDER: "compatible", STT_PROVIDER: "gemini", TTS_PROVIDER: "gemini",
      COMPATIBLE_LLM_BASE_URL: "https://example.test",
    });
    expect(result.ready).toBe(false);
    expect(result.reasons.some(reason => reason.includes("Gemini"))).toBe(true);
  });
  it("accepts valid-looking configuration without sending provider traffic", () => {
    const result = assessLocalAgentReadiness({
      LLM_PROVIDER: "compatible", STT_PROVIDER: "gemini", TTS_PROVIDER: "gemini",
      COMPATIBLE_LLM_API_KEY: "test-secret-never-disclose",
      COMPATIBLE_LLM_BASE_URL: "https://example.test",
    });
    expect(result.ready).toBe(true);
    expect(JSON.stringify(result)).not.toContain("test-secret-never-disclose");
  });
});
