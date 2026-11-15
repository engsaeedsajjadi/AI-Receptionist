import { beforeEach, describe, expect, it, vi } from "vitest";

const sdk = vi.hoisted(() => ({
  create: vi.fn(),
}));

vi.mock("@google/genai", () => ({
  GoogleGenAI: class {
    interactions = { create: sdk.create };
  },
}));

vi.mock("@/lib/env", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/env")>()),
  getEnv: () => ({
    COMPATIBLE_LLM_API_KEY: "test-api-key",
    TTS_MODEL: "gemini-3.8-flash-lite-tts",
    TTS_VOICE: "Kore",
    TTS_PROVIDER: "gemini",
  }),
}));

import { GeminiTTSProvider } from "@/lib/providers/tts";

const success = {
  output_audio: {
    data: Buffer.from("test-audio").toString("base64"),
  },
};

const connectionError = () =>
  Object.assign(
    new Error("Unexpected HTTP client error: TypeError: unusable"),
    { name: "APIConnectionError" },
  );

beforeEach(() => {
  sdk.create.mockReset();
});

describe("Gemini TTS retry policy", () => {
  it("recovers after a temporary SDK connection error", async () => {
    sdk.create
      .mockRejectedValueOnce(connectionError())
      .mockResolvedValueOnce(success);

    const provider = new GeminiTTSProvider();

    const result = await provider.synthesize("سلام", {
      voice: "Kore",
      format: "wav",
    });

    expect(result.audio.toString()).toBe("test-audio");
    expect(sdk.create).toHaveBeenCalledTimes(2);
  });

  it("does not retry a permanent HTTP 401 error", async () => {
    const error = Object.assign(new Error("Invalid API key"), {
      status: 401,
    });

    sdk.create.mockRejectedValue(error);

    const provider = new GeminiTTSProvider();

    await expect(
      provider.synthesize("سلام"),
    ).rejects.toThrow();

    expect(sdk.create).toHaveBeenCalledTimes(1);
  });

  it("stops after three failed connection attempts", async () => {
    sdk.create.mockRejectedValue(connectionError());

    const provider = new GeminiTTSProvider();

    await expect(
      provider.synthesize("سلام"),
    ).rejects.toThrow();

    expect(sdk.create).toHaveBeenCalledTimes(3);
  });
});