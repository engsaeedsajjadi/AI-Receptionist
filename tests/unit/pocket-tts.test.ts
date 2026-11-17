import { afterEach, describe, expect, it, vi } from "vitest";
import { pcm16ToWav } from "@/lib/voice/audio";

vi.mock("@/lib/env", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/env")>();
  return {
    ...actual,
    getEnv: () => ({ ...actual.getEnv(), POCKET_TTS_URL: "http://127.0.0.1:5002", POCKET_TTS_TIMEOUT_MS: 30_000 }),
  };
});

import { PocketTTSProvider } from "@/lib/providers/pocket-tts";

describe("local Pocket-TTS (Cilla) adapter", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("only ever talks to a loopback HTTP server", () => {
    for (const baseURL of ["https://127.0.0.1:5002", "http://example.com:5002", "http://10.0.0.5:5002",
      "http://127.0.0.1:5002/other", "http://u:p@127.0.0.1:5002"]) {
      expect(() => new PocketTTSProvider({ baseURL }), baseURL).toThrow();
    }
    expect(() => new PocketTTSProvider()).not.toThrow();
  });

  it("sends only the text (the voice is fixed on the server) and returns 24-kHz PCM", async () => {
    const wav = pcm16ToWav(Buffer.alloc(24_000 * 2, 3), 24_000);
    const spy = vi.fn().mockResolvedValue(new Response(new Uint8Array(wav), { status: 200 }));
    vi.stubGlobal("fetch", spy);
    const result = await new PocketTTSProvider().synthesize("نوبت شما ثبت شد.", { format: "pcm" });
    expect(spy.mock.calls[0][0]).toBe("http://127.0.0.1:5002/synthesize");
    expect(JSON.parse(spy.mock.calls[0][1].body)).toEqual({ text: "نوبت شما ثبت شد." });
    expect(spy.mock.calls[0][1].redirect).toBe("error");
    expect(result.audio.byteLength).toBe(48_000);
    expect(result.provider).toBe("pocket-tts");
  });

  it("resamples a 16-kHz model output to 24 kHz", async () => {
    const wav = pcm16ToWav(Buffer.alloc(16_000 * 2, 1), 16_000);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(new Uint8Array(wav), { status: 200 })));
    const result = await new PocketTTSProvider().synthesize("سلام", { format: "pcm" });
    expect(result.audio.byteLength).toBe(48_000);
  });

  it("refuses a runaway (>30 s), stereo or non-WAV reply instead of playing it", async () => {
    const tooLong = pcm16ToWav(Buffer.alloc(24_000 * 2 * 31), 24_000);
    const notWav = Buffer.from("<html>error</html>");
    for (const body of [tooLong, notWav]) {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(new Uint8Array(body), { status: 200 })));
      await expect(new PocketTTSProvider().synthesize("سلام")).rejects.toMatchObject({ code: "TTS_ERROR" });
    }
  });

  it("reports a stopped server clearly and validates input", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("fetch failed")));
    await expect(new PocketTTSProvider().synthesize("سلام")).rejects.toMatchObject({ code: "DEPENDENCY_UNAVAILABLE" });
    await expect(new PocketTTSProvider().synthesize("  ")).rejects.toMatchObject({ code: "INVALID_PAYLOAD" });
    await expect(new PocketTTSProvider().synthesize("ا".repeat(601))).rejects.toMatchObject({ code: "INVALID_PAYLOAD" });
    await expect(new PocketTTSProvider().synthesize("سلام", { format: "mp3" })).rejects.toMatchObject({ code: "UNSUPPORTED_MEDIA_TYPE" });
  });
});
