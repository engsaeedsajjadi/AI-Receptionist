import { describe, expect, it, vi, afterEach } from "vitest";
import { pcm16ToWav } from "@/lib/voice/audio";
import { normalizePiperWav, validatePiperEndpoint, PiperTTSProvider } from "@/lib/providers/piper-tts";

// Isolate local-Piper tests from DATABASE_URL and all production secrets.
vi.mock("@/lib/env", async (importOriginal) => {
  // Vitest setup imports resetEnvCache from this module; preserve all exports.
  const actual = await importOriginal<typeof import("@/lib/env")>();
  return {
    ...actual,
    getEnv: () => ({
      ...actual.getEnv(),
      PIPER_TTS_URL: "http://127.0.0.1:5000",
      PIPER_TTS_VOICE: "fa_IR-amir-medium",
      PIPER_TTS_TIMEOUT_MS: 20_000,
    }),
  };
});

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

  it("accepts the official Flask text/html MIME when the body is valid WAV", async () => {
    const wav = pcm16ToWav(Buffer.alloc(22050 * 2, 5), 22050);
    const fetchSpy = vi.fn().mockResolvedValue(new Response(new Uint8Array(wav), {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
    }));
    vi.stubGlobal("fetch", fetchSpy);
    const provider = new PiperTTSProvider();
    const result = await provider.synthesize("سلام، وقت بخیر.", { format: "pcm" });
    expect(result.mimeType).toBe("audio/l16");
    expect(result.audio.byteLength).toBe(48000);
    expect(result.provider).toBe("piper");
    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(fetchSpy.mock.calls[0][0]).toBe("http://127.0.0.1:5000/synthesize");
    expect(fetchSpy.mock.calls[0][1].redirect).toBe("error");
  });

  it("rejects actual HTML errors despite the Flask 200 status", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("<html>Error</html>", {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
    })));
    await expect(new PiperTTSProvider().synthesize("سلام", { format: "pcm" }))
      .rejects.toThrow(/invalid or oversized WAV/);
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
