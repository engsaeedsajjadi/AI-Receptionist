import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetEnvCache } from "@/lib/env";
import { decodeMediaSessionToken } from "@/lib/voice/media-auth";

/**
 * `bootstrapMedia` answers a newly registered inbound call and starts the audio
 * stream. A failure here must never lose the call record, so every branch
 * reports what happened instead of throwing, and the stream is started with a
 * short-lived media token scoped to exactly this tenant and call.
 */
const voice = vi.hoisted(() => ({
  answerCall: vi.fn(),
  startStream: vi.fn(),
}));

vi.mock("@/lib/providers/voice", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/providers/voice")>();
  return { ...actual, getVoiceProvider: () => voice };
});

const MEDIA_SECRET = "bootstrap-media-secret-0123456789";
const input = {
  businessSettings: {} as Record<string, unknown>,
  externalCallId: "ext-call-1",
  callId: "11111111-1111-4111-8111-111111111111",
  businessId: "22222222-2222-4222-8222-222222222222",
  requestId: "req-1",
  skip: false,
};

function configure(overrides: Record<string, string> = {}) {
  const base: Record<string, string> = {
    VOICE_PROVIDER: "generic",
    VOICE_API_BASE_URL: "https://voice.example.test",
    VOICE_API_KEY: "test-voice-key",
    VOICE_AUTO_ANSWER: "true",
    VOICE_MEDIA_PUBLIC_URL: "wss://media.example.test/stream",
    VOICE_MEDIA_TOKEN: MEDIA_SECRET,
  };
  for (const [key, value] of Object.entries({ ...base, ...overrides })) vi.stubEnv(key, value);
  resetEnvCache();
}

async function bootstrap(overrides: Partial<typeof input> = {}) {
  const { bootstrapMedia } = await import("@/app/api/v1/webhooks/voice/call-started/route");
  return bootstrapMedia({ ...input, ...overrides });
}

beforeEach(() => {
  voice.answerCall.mockReset().mockResolvedValue(undefined);
  voice.startStream.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  resetEnvCache();
});

describe("bootstrapMedia", () => {
  it("does nothing for a redelivered call-started event", async () => {
    configure();
    expect(await bootstrap({ skip: true })).toEqual({
      attempted: false, answered: false, streaming: false, reason: "duplicate",
    });
    expect(voice.answerCall).not.toHaveBeenCalled();
  });

  it("does nothing when the generic voice provider is not the configured one", async () => {
    configure({ VOICE_PROVIDER: "dev" });
    expect(await bootstrap()).toMatchObject({ attempted: false, reason: "provider_not_configured" });
    expect(voice.answerCall).not.toHaveBeenCalled();
  });

  it("honours auto-answer being disabled globally or for one business", async () => {
    configure({ VOICE_AUTO_ANSWER: "false" });
    expect(await bootstrap()).toMatchObject({ attempted: false, reason: "auto_answer_disabled" });

    configure();
    expect(await bootstrap({ businessSettings: { voice: { autoAnswer: false } } }))
      .toMatchObject({ attempted: false, reason: "auto_answer_disabled" });
    expect(voice.answerCall).not.toHaveBeenCalled();
  });

  it("lets a business opt in even when the global default is off", async () => {
    configure({ VOICE_AUTO_ANSWER: "false" });
    expect(await bootstrap({ businessSettings: { voice: { autoAnswer: true } } }))
      .toEqual({ attempted: true, answered: true, streaming: true });
  });

  it("answers the call and starts the stream with a short-lived, call-scoped media token", async () => {
    configure();
    expect(await bootstrap()).toEqual({ attempted: true, answered: true, streaming: true });

    expect(voice.answerCall).toHaveBeenCalledWith("ext-call-1", { requestId: "req-1" });
    expect(voice.startStream).toHaveBeenCalledTimes(1);
    const [externalCallId, options] = voice.startStream.mock.calls[0];
    expect(externalCallId).toBe("ext-call-1");
    expect(options).toMatchObject({
      websocketUrl: "wss://media.example.test/stream", requestId: "req-1",
      businessId: input.businessId, callId: input.callId, codec: "mulaw", sampleRate: 8000,
    });

    const claims = decodeMediaSessionToken(options.mediaToken, MEDIA_SECRET);
    expect(claims).toMatchObject({
      businessId: input.businessId, callId: input.callId, externalCallId: "ext-call-1",
    });
    const lifetime = claims!.exp - Math.floor(Date.now() / 1000);
    expect(lifetime).toBeGreaterThan(0);
    expect(lifetime).toBeLessThanOrEqual(120);
    // The token is useless with any other secret.
    expect(decodeMediaSessionToken(options.mediaToken, "another-secret-0123456789abcdef")).toBeNull();
  });

  it("reports answer_failed without starting a stream when the provider cannot answer", async () => {
    configure();
    voice.answerCall.mockRejectedValue(new Error("provider 503"));
    expect(await bootstrap()).toEqual({
      attempted: true, answered: false, streaming: false, reason: "answer_failed",
    });
    expect(voice.startStream).not.toHaveBeenCalled();
  });

  it("answers but does not stream when no public media URL is configured", async () => {
    configure({ VOICE_MEDIA_PUBLIC_URL: "" });
    expect(await bootstrap()).toEqual({
      attempted: true, answered: true, streaming: false, reason: "media_url_not_configured",
    });
    expect(voice.startStream).not.toHaveBeenCalled();
  });

  it("reports stream_start_failed (call stays answered) when the stream cannot start", async () => {
    configure();
    voice.startStream.mockRejectedValue("socket refused");
    expect(await bootstrap()).toEqual({
      attempted: true, answered: true, streaming: false, reason: "stream_start_failed",
    });
  });
});
