import { describe, expect, it, vi, afterEach } from "vitest";
import { pcm16ToWav } from "@/lib/voice/audio";
import { normalizePiperWav, validatePiperEndpoint } from "@/lib/providers/piper-tts";

describe("local Piper TTS sandbox", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("rejects all remote, HTTPS, or credentialed endpoints (SSRF protection)", () => {
    for (const url of ["https://127.0.0.1:5000", "http://example.com:5000",
      "http://192.168.1.113:5000", "http://127.0.0.1:5000@evil.test",
      "http://localhost:5000?x=1", "http://localhost:5000/other"]) {
      expect(() => validatePiperEndpoint(url)).toThrow();
    }
    expect(validatePiperEndpoint("http://127.0.0.1:5000").hostname).toBe("127.0.0.1");
    expect(validatePiperEndpoint("http://localhost:5000").hostname).toBe("localhost");
  });

  it("resamples genuine 22.05 kHz Piper PCM16 mono WAV to 24 kHz", () => {
    const pcm = Buffer.alloc(22050 * 2);
    for (let i = 0; i < 22050; i++) pcm.writeInt16LE(Math.round(8000 * Math.sin(i / 8)), 2 * i);
    const normalized = normalizePiperWav(pcm16ToWav(pcm, 22050));
    expect(normalized.byteLength).toBe(48000);
    expect(normalized.readInt16LE(32)).not.toBe(0);
  });

  it("rejects fake header, WAV truncation, and stereo WAV", () => {
    expect(() => normalizePiperWav(Buffer.from("not a wav"))).toThrow();
    const wav = pcm16ToWav(Buffer.alloc(4000), 22050);
    expect(() => normalizePiperWav(wav.subarray(0, 80))).toThrow();
    const stereo = Buffer.from(wav);
    stereo.writeUInt16LE(2, 22);
    expect(() => normalizePiperWav(stereo)).toThrow();
  });
});
