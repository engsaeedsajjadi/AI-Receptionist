import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildDialTwiml,
  buildInboundTwiml,
  buildStopStreamTwiml,
  escapeXml,
  TwilioVoiceProvider,
  twilioMediaFrameToAudio,
  twilioOptionsFromEnv,
  voiceProviderName,
} from "@/lib/providers/telephony/twilio";
import { resetEnvCache } from "@/lib/env";
import { AppError } from "@/lib/errors";

const ENV_SNAPSHOT = new Map<string, string | undefined>();
const stubEnv = (key: string, value: string) => {
  if (!ENV_SNAPSHOT.has(key)) ENV_SNAPSHOT.set(key, process.env[key]);
  process.env[key] = value;
  resetEnvCache();
};
afterEach(() => {
  vi.unstubAllGlobals();
  for (const [key, value] of ENV_SNAPSHOT) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  ENV_SNAPSHOT.clear();
  resetEnvCache();
});

function provider(overrides: Partial<Parameters<typeof twilioOptionsFromEnv>[0]> = {}) {
  return new TwilioVoiceProvider({
    accountSid: "AC123",
    authToken: "token",
    fromNumber: "+982100000000",
    appUrl: "https://app.example.com",
    mediaUrl: "wss://media.example.com",
    timeoutMs: 500,
    ...overrides,
  });
}

describe("Twilio options and TwiML construction", () => {
  it("reads options from the environment with sane fallbacks", () => {
    stubEnv("TWILIO_ACCOUNT_SID", "ACenv");
    stubEnv("TWILIO_AUTH_TOKEN", "env-token");
    stubEnv("TWILIO_PHONE_NUMBER", "+982111111111");
    stubEnv("APP_URL", "https://app.example.com/");
    stubEnv("VOICE_MEDIA_PUBLIC_URL", "wss://media.example.com/stream");
    const options = twilioOptionsFromEnv();
    expect(options).toMatchObject({
      accountSid: "ACenv",
      authToken: "env-token",
      fromNumber: "+982111111111",
      appUrl: "https://app.example.com", // trailing slash removed
      mediaUrl: "wss://media.example.com/stream",
      timeoutMs: 15_000,
    });
    expect(twilioOptionsFromEnv({ timeoutMs: 1000, appUrl: "https://other.example.com/" }).appUrl).toBe("https://other.example.com");
    // Overrides win over the environment.
    expect(twilioOptionsFromEnv({ accountSid: "ACoverride" }).accountSid).toBe("ACoverride");
  });

  it("builds a stream TwiML with disclosure, handoff gather and escaped values", () => {
    const base = { websocketUrl: "wss://media.example.com/media/call-1", businessId: "biz-1", token: "tok" };
    const plain = buildInboundTwiml(base);
    expect(plain).toContain("<Connect><Stream url=\"wss://media.example.com/media/call-1\">");
    expect(plain).toContain('name="businessId" value="biz-1"');
    expect(plain).not.toContain("<Say");
    expect(plain).not.toContain("<Gather");

    const full = buildInboundTwiml({
      ...base,
      callId: "call-1",
      externalCallId: "CA1",
      language: "fa-IR",
      disclosure: "این تماس توسط دستیار هوشمند پاسخ داده می‌شود",
      handoffNumber: "+982112345678",
    });
    expect(full).toContain("<Say language=\"fa-IR\">");
    expect(full).toContain('<Gather numDigits="1"');
    expect(full).toContain("api/v1/webhooks/voice/voice-dtmf");
    expect(full).toContain('name="callId" value="call-1"');

    const hostile = buildInboundTwiml({
      ...base,
      businessId: '"><Script>x</Script>',
      disclosure: "</Say><Hangup/>",
      language: '"><bad>',
    });
    expect(hostile).not.toContain("<Script>");
    expect(hostile).not.toContain("<Hangup/>");
    expect(hostile).toContain("&quot;&gt;&lt;Script&gt;");
    expect(escapeXml(`&<>"'`)).toBe("&amp;&lt;&gt;&quot;&apos;");
  });

  it("bounds the dial timeout and stops a named stream", () => {
    expect(buildDialTwiml("+989120000000")).toContain('timeout="30"');
    expect(buildDialTwiml("+989120000000", 1)).toContain('timeout="5"');
    expect(buildDialTwiml("+989120000000", 600)).toContain('timeout="120"');
    expect(buildDialTwiml('+98""><Hangup/>')).toContain("&quot;");
    const stop = buildStopStreamTwiml("ai-CA1");
    expect(stop).toContain("<Stop><Stream name=\"ai-CA1\" /></Stop>");
    expect(buildStopStreamTwiml('x"<')).toContain("&quot;");
  });

  it("maps media frames and drops anything it cannot use", () => {
    expect(twilioMediaFrameToAudio(null)).toBeNull();
    expect(twilioMediaFrameToAudio("envelope")).toBeNull();
    expect(twilioMediaFrameToAudio({ event: "connected" })).toBeNull();
    expect(twilioMediaFrameToAudio({ event: "mark" })).toBeNull();
    expect(twilioMediaFrameToAudio({ event: "start" })).toEqual({ type: "start", payload: { externalCallId: "", streamSid: "" } });
    const start = twilioMediaFrameToAudio({ event: "start", streamSid: "MZ", start: { callSid: "CA1", customParameters: { businessId: "biz-1", token: null } } });
    expect(start).toEqual({ type: "start", payload: { businessId: "biz-1", token: "", externalCallId: "CA1", streamSid: "MZ" } });
    expect(twilioMediaFrameToAudio({ event: "media", media: {} })).toBeNull();
    expect(twilioMediaFrameToAudio({ event: "media", media: { payload: "" } })).toBeNull();
    const audio = twilioMediaFrameToAudio({ event: "media", media: { payload: Buffer.from("abc").toString("base64") } });
    expect(audio).toMatchObject({ type: "audio" });
    expect((audio as { audio: Buffer }).audio.toString()).toBe("abc");
    expect(twilioMediaFrameToAudio({ event: "dtmf", dtmf: { digit: "5" } })).toEqual({ type: "dtmf", digits: "5" });
    expect(twilioMediaFrameToAudio({ event: "dtmf", dtmf: { digit: "#" } })).toEqual({ type: "dtmf", digits: "#" });
    expect(twilioMediaFrameToAudio({ event: "dtmf", dtmf: { digit: "Z" } })).toBeNull();
    expect(twilioMediaFrameToAudio({ event: "dtmf" })).toBeNull();
    expect(twilioMediaFrameToAudio({ event: "stop" })).toEqual({ type: "stop" });
  });

  it("rejects construction without credentials and reports the configured provider name", () => {
    expect(() => new TwilioVoiceProvider({ accountSid: "", authToken: "" })).toThrow(/TWILIO_ACCOUNT_SID/);
    stubEnv("VOICE_PROVIDER", "twilio");
    expect(voiceProviderName()).toBe("twilio");
    stubEnv("VOICE_PROVIDER", "generic");
    expect(voiceProviderName()).toBe("generic");
    stubEnv("VOICE_PROVIDER", "dev");
    expect(voiceProviderName()).toBe("dev");
  });
});

describe("Twilio provider transport behaviour", () => {
  it("surfaces provider outages, rate limits and timeouts with distinct codes", async () => {
    const twilio = provider();
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 429 })));
    await expect(twilio.hangupCall("CA1")).rejects.toMatchObject({ status: 429, code: "PROVIDER_RATE_LIMITED" });

    vi.stubGlobal("fetch", vi.fn(async () => new Response("boom", { status: 503 })));
    await expect(twilio.hangupCall("CA1")).rejects.toMatchObject({ status: 502, code: "VOICE_ERROR" });

    vi.stubGlobal("fetch", vi.fn(async () => {
      const err = new Error("aborted");
      err.name = "AbortError";
      throw err;
    }));
    await expect(twilio.hangupCall("CA1")).rejects.toMatchObject({ status: 504, code: "PROVIDER_TIMEOUT" });

    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }));
    await expect(twilio.hangupCall("CA1")).rejects.toMatchObject({ status: 502, code: "VOICE_ERROR" });
  });

  it("treats an empty response body as an empty object and forwards the request id", async () => {
    const twilio = provider();
    const fetchMock = vi.fn<typeof fetch>(async () => new Response("", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await twilio.hangupCall("CA1", { requestId: "req-1" });
    expect(result.ok).toBe(true);
    const [, init] = fetchMock.mock.calls[0];
    expect((init?.headers as Record<string, string>)["X-Request-Id"]).toBe("req-1");
    expect((init?.headers as Record<string, string>).Authorization).toMatch(/^Basic /);
  });

  it("validates play and stream inputs before touching the network", async () => {
    const twilio = provider();
    await expect(twilio.playAudio("CA1", {})).rejects.toMatchObject({ status: 400, code: "INVALID_PAYLOAD" });
    await expect(twilio.startStream("CA1", { websocketUrl: "wss://x" })).rejects.toMatchObject({ status: 400 });
    await expect(twilio.startStream("CA1", { websocketUrl: "wss://x", businessId: "biz-1", codec: "pcm_s16le" })).rejects.toMatchObject({
      status: 400,
      code: "INVALID_PAYLOAD",
    });
    await expect(twilio.transferCall("CA1", "09121234567")).rejects.toMatchObject({ status: 400, code: "INVALID_PAYLOAD" });
  });

  it("plays audio as TwiML, starts a stream with tenant context and stops it", async () => {
    const twilio = provider();
    const bodies: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (_url, init) => {
        bodies.push(String(init?.body));
        return new Response(JSON.stringify({ status: "in-progress" }), { status: 200, headers: { "content-type": "application/json" } });
      }),
    );
    expect((await twilio.playAudio("CA1", { text: "سلام" })).ok).toBe(true);
    expect(bodies[0]).toContain("Say");
    expect((await twilio.playAudio("CA1", { audioUrl: "https://cdn.example/a.mp3" })).ok).toBe(true);
    expect(bodies[1]).toContain("Play");

    const stream = await twilio.startStream("CA1", {
      websocketUrl: "wss://media.example.com/media/CA1",
      businessId: "biz-1",
      callId: "call-1",
      mediaToken: "media-token",
      language: "fa-IR",
      codec: "mulaw",
    });
    expect(stream.ok).toBe(true);
    const streamUrl = decodeURIComponent(bodies[2]);
    expect(streamUrl).toContain("business_id=biz-1");
    expect(streamUrl).toContain("media_token=media-token");
    expect(streamUrl).toContain("stage=stream");

    expect((await twilio.stopStream("CA1")).ok).toBe(true);
    expect(bodies[3]).toContain("Stop");
  });

  it("reports the provider's own call status and wraps transfer failures", async () => {
    const twilio = provider();
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ status: "in-progress" }), { status: 200, headers: { "content-type": "application/json" } })),
    );
    expect(await twilio.getCallStatus("CA1")).toMatchObject({ status: "in-progress" });
    const transfer = await twilio.transferCall("CA1", "+989120000000");
    expect(transfer.transferStatus).toBe("INITIATED");
    expect(transfer.ok).toBe(true);

    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ status: "queued" }), { status: 200, headers: { "content-type": "application/json" } })));
    expect(await twilio.transferCall("CA1", "+989120000000")).toMatchObject({ transferStatus: "INITIATED" });

    // A rejected dial is a transfer failure, not a generic voice error.
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async () => new Response("nope", { status: 500 })));
    await expect(twilio.transferCall("CA1", "+989120000000")).rejects.toMatchObject({ status: 502, code: "TRANSFER_FAILED" });
  });

  it("maps status lookups to 404 and rate limits without leaking provider payloads", async () => {
    const twilio = provider();
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async () => new Response("", { status: 404 })));
    await expect(twilio.getCallStatus("CA1")).rejects.toMatchObject({ status: 404, code: "CALL_NOT_FOUND" });
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async () => new Response("", { status: 429 })));
    await expect(twilio.getCallStatus("CA1")).rejects.toMatchObject({ status: 429, code: "PROVIDER_RATE_LIMITED" });
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async () => {
      const err = new Error("aborted");
      err.name = "AbortError";
      throw err;
    }));
    await expect(twilio.getCallStatus("CA1")).rejects.toMatchObject({ status: 504, code: "PROVIDER_TIMEOUT" });
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async () => {
      throw new Error("socket hang up");
    }));
    await expect(twilio.getCallStatus("CA1")).rejects.toMatchObject({ status: 502, code: "VOICE_ERROR" });
  });

  it("verifies an inbound webhook and demands the required fields", () => {
    const twilio = provider();
    const params = { CallSid: "CA1", From: "+989120000000", To: "+982100000000", CallStatus: "ringing" };
    const url = "https://app.example.com/api/v1/webhooks/voice/inbound";
    const data = Object.keys(params)
      .sort()
      .reduce((acc, key) => acc + key + (params as Record<string, string>)[key], url);
    const signature = createHmac("sha1", "token").update(Buffer.from(data, "utf8")).digest("base64");
    expect(twilio.parseInbound({ params, signature, signatureUrl: url })).toMatchObject({ CallSid: "CA1", CallStatus: "ringing" });
    expect(() => twilio.parseInbound({ params, signature: "wrong", signatureUrl: url })).toThrow(AppError);
    expect(() => twilio.parseInbound({ params, signature: undefined, signatureUrl: url })).toThrow(/Invalid Twilio webhook signature/);
    // A signature over a body with a missing field must be recomputed, otherwise
    // the request is (correctly) rejected as tampered.
    const incomplete = { CallSid: "CA1", From: "+989120000000", To: "+982100000000", CallStatus: "" };
    const incompleteData = Object.keys(incomplete)
      .sort()
      .reduce((acc, key) => acc + key + (incomplete as Record<string, string>)[key], url);
    const incompleteSignature = createHmac("sha1", "token").update(Buffer.from(incompleteData, "utf8")).digest("base64");
    expect(() => twilio.parseInbound({ params: incomplete, signature: incompleteSignature, signatureUrl: url })).toThrow(/missing CallStatus/);
    const partial = { CallSid: "CA1" };
    const partialData = `CA1`.length === 0 ? url : url + "CallSidCA1";
    expect(() =>
      twilio.parseInbound({
        params: partial,
        signature: createHmac("sha1", "token").update(Buffer.from(partialData, "utf8")).digest("base64"),
        signatureUrl: url,
      }),
    ).toThrow(/missing From/);
  });
});
