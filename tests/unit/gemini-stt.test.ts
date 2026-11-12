import { beforeEach, describe, expect, it, vi } from "vitest";

const sdk = vi.hoisted(() => ({ create: vi.fn(), keys: [] as string[] }));
const config = vi.hoisted(() => ({ apiKey: "test-api-key" }));

vi.mock("@google/genai", () => ({
  GoogleGenAI: class {
    interactions = { create: sdk.create };
    constructor(options: { apiKey: string }) {
      sdk.keys.push(options.apiKey);
    }
  },
}));

vi.mock("@/lib/env", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/env")>()),
  getEnv: () => ({
    COMPATIBLE_LLM_API_KEY: config.apiKey,
    STT_MODEL: "gemini-test-stt",
    STT_PROVIDER: "gemini",
  }),
}));

import { DevSTTProvider, GeminiSTTProvider, getSTTProvider } from "@/lib/providers/stt";

/**
 * Gemini speech-to-text adapter. No network: the SDK is replaced by a fake.
 * The contract is what the rest of the voice pipeline relies on — a verbatim
 * Persian transcript request, honest "unknown duration" metadata (so billing
 * never uses an invented length) and provider errors mapped to stable codes.
 */
const audio = Buffer.from("fake-wav-bytes");

beforeEach(() => {
  sdk.create.mockReset();
  sdk.keys.length = 0;
  config.apiKey = "test-api-key";
});

describe("GeminiSTTProvider", () => {
  it("refuses to construct without an API key", () => {
    config.apiKey = "";
    expect(() => new GeminiSTTProvider()).toThrowError(/COMPATIBLE_LLM_API_KEY/);
  });

  it("is what the provider factory returns for STT_PROVIDER=gemini", () => {
    const provider = getSTTProvider();
    expect(provider).toBeInstanceOf(GeminiSTTProvider);
    expect(provider.name).toBe("gemini");
    expect(sdk.keys).toEqual(["test-api-key"]);
  });

  it("sends the audio inline with a verbatim Persian instruction and returns the trimmed text", async () => {
    sdk.create.mockResolvedValue({ output_text: "  سلام، یک آپارتمان دو خوابه می‌خواهم \n" });

    const result = await new GeminiSTTProvider().transcribe(audio, {
      mimeType: "audio/webm", language: "fa-IR", requestId: "r1", businessId: "b1", callId: "c1",
    });

    expect(result).toEqual({
      text: "سلام، یک آپارتمان دو خوابه می‌خواهم",
      language: "fa",
      status: "final",
      confidence: null,
      // The API reports no audio length: unknown must stay unknown.
      durationSeconds: null,
      usage: {},
      provider: "gemini",
      model: "gemini-test-stt",
    });

    expect(sdk.create).toHaveBeenCalledTimes(1);
    const request = sdk.create.mock.calls[0][0];
    expect(request.model).toBe("gemini-test-stt");
    expect(request.input).toHaveLength(2);
    expect(request.input[0].type).toBe("text");
    expect(request.input[0].text).toContain("کلمه‌به‌کلمه");
    expect(request.input[0].text).toContain("حدس");
    expect(request.input[1]).toEqual({ type: "audio", data: audio.toString("base64"), mime_type: "audio/webm" });
  });

  it("defaults to Persian and WAV, and uses an English instruction for other languages", async () => {
    sdk.create.mockResolvedValue({ output_text: "hello" });
    const provider = new GeminiSTTProvider();

    const fa = await provider.transcribe(audio);
    expect(fa.language).toBe("fa");
    expect(sdk.create.mock.calls[0][0].input[1].mime_type).toBe("audio/wav");

    const en = await provider.transcribe(audio, { language: "en-US" });
    expect(en.language).toBe("en");
    expect(sdk.create.mock.calls[1][0].input[0].text).toMatch(/^Transcribe this audio verbatim/);
  });

  it("returns an empty transcript (not an invented one) when the model says nothing", async () => {
    sdk.create.mockResolvedValue({});
    expect((await new GeminiSTTProvider().transcribe(audio)).text).toBe("");
    sdk.create.mockResolvedValue({ output_text: "   " });
    expect((await new GeminiSTTProvider().transcribe(audio)).text).toBe("");
  });

  it("rejects empty and oversized audio without calling the provider", async () => {
    const provider = new GeminiSTTProvider();
    await expect(provider.transcribe(Buffer.alloc(0))).rejects.toMatchObject({ status: 400, code: "INVALID_PAYLOAD" });
    await expect(provider.transcribe(Buffer.alloc(20 * 1024 * 1024 + 1)))
      .rejects.toMatchObject({ status: 413, code: "PAYLOAD_TOO_LARGE" });
    expect(sdk.create).not.toHaveBeenCalled();
  });

  it("maps provider failures to stable error codes", async () => {
    const provider = new GeminiSTTProvider();

    sdk.create.mockRejectedValueOnce(Object.assign(new Error("quota"), { status: 429 }));
    await expect(provider.transcribe(audio)).rejects.toMatchObject({ status: 429, code: "PROVIDER_RATE_LIMITED" });

    sdk.create.mockRejectedValueOnce(Object.assign(new Error("deadline"), { status: 504 }));
    await expect(provider.transcribe(audio)).rejects.toMatchObject({ status: 504, code: "PROVIDER_TIMEOUT" });

    sdk.create.mockRejectedValueOnce(Object.assign(new Error("Invalid API key"), { status: 401 }));
    await expect(provider.transcribe(audio)).rejects.toMatchObject({ status: 502, code: "STT_ERROR" });

    sdk.create.mockRejectedValueOnce(new Error("Unexpected HTTP client error: TypeError: unusable"));
    await expect(provider.transcribe(audio)).rejects.toMatchObject({ status: 502, code: "STT_ERROR" });
  });
});

describe("DevSTTProvider", () => {
  it("never fabricates a transcript", async () => {
    await expect(new DevSTTProvider().transcribe()).rejects.toMatchObject({
      status: 503, code: "PROVIDER_NOT_CONFIGURED",
    });
  });
});
