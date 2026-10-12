import { afterEach, describe, expect, it, vi } from "vitest";
import { pcm16ToWav } from "@/lib/voice/audio";
import { FasterWhisperSTTProvider, validateLocalWhisperUrl } from "@/lib/providers/faster-whisper-stt";

vi.mock("@/lib/env", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/env")>();
  return {
    ...actual,
    getEnv: () => ({
      ...actual.getEnv(),
      LOCAL_WHISPER_STT_URL: "http://127.0.0.1:5001",
      LOCAL_WHISPER_STT_TIMEOUT_MS: 15000,
    }),
  };
});

describe("offline Faster-Whisper lab adapter", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("prevents SSRF / remote STT endpoint injection", () => {
    expect(validateLocalWhisperUrl("http://127.0.0.1:5001").hostname).toBe("127.0.0.1");
    for (const url of ["https://localhost:5001", "http://example.test",
      "http://192.168.1.113:5001", "http://localhost:5001/x",
      "http://localhost:5001?token=x", "http://user:pass@localhost:5001"]) {
      expect(() => validateLocalWhisperUrl(url)).toThrow();
    }
  });

  it("uses the loopback audio/WAV endpoint, validates duration and preserves Persian transcript", async () => {
    const spy = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      text: "سلام، دنبال آپارتمان دوخوابه هستم.",
      language: "fa", model: "tiny", durationSeconds: 1,
    }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", spy);
    const wav = pcm16ToWav(Buffer.alloc(16000), 8000);
    const output = await new FasterWhisperSTTProvider().transcribe(wav);
    expect(output.text).toMatch(/آپارتمان/);
    expect(output.durationSeconds).toBe(1);
    expect(output.usage.audioSeconds).toBe(1);
    expect(output.provider).toBe("faster-whisper");
    expect(spy.mock.calls[0][0]).toBe("http://127.0.0.1:5001/transcribe");
    expect(spy.mock.calls[0][1].redirect).toBe("error");
  });

  it("rejects non-WAV input and malformed STT data", async () => {
    const provider = new FasterWhisperSTTProvider();
    await expect(provider.transcribe(Buffer.from("bad"))).rejects.toThrow(/PCM WAV/);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      text: 1, durationSeconds: -20, model: "random",
    }), { status: 200 })));
    await expect(provider.transcribe(pcm16ToWav(Buffer.alloc(16000), 8000)))
      .rejects.toThrow(/metadata/);
  });
});
