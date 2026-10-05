import { afterEach, describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";
import {
  buildDialTwiml,
  buildInboundTwiml,
  buildRejectTwiml,
  buildStopStreamTwiml,
  escapeXml,
  TwilioVoiceProvider,
  twilioMediaFrameToAudio,
  verifyTwilioSignature,
} from "@/lib/providers/telephony/twilio";
import { AppError } from "@/lib/errors";

const AUTH_TOKEN = "test-auth-token-0123456789";

function sign(url: string, params: Record<string, string>, token = AUTH_TOKEN): string {
  const data = Object.keys(params)
    .sort()
    .reduce((acc, key) => acc + key + params[key], url);
  return createHmac("sha1", token).update(Buffer.from(data, "utf8")).digest("base64");
}

describe("Twilio signature verification", () => {
  it("accepts a signature computed over the URL and sorted params", () => {
    const params = { CallSid: "CA1", From: "+989120000000", To: "+982100000000", CallStatus: "ringing" };
    const url = "https://app.example.com/api/v1/webhooks/voice/inbound";
    expect(verifyTwilioSignature({ authToken: AUTH_TOKEN, url, params, signature: sign(url, params) })).toBe(true);
  });

  it("rejects tampered params, wrong tokens and empty signatures", () => {
    const params = { CallSid: "CA1", From: "+989120000000" };
    const url = "https://app.example.com/hook";
    const signature = sign(url, params);
    expect(verifyTwilioSignature({ authToken: AUTH_TOKEN, url, params: { ...params, CallSid: "CA2" }, signature })).toBe(false);
    expect(verifyTwilioSignature({ authToken: "other-token", url, params, signature })).toBe(false);
    expect(verifyTwilioSignature({ authToken: AUTH_TOKEN, url, params, signature: "" })).toBe(false);
    expect(verifyTwilioSignature({ authToken: "", url, params, signature })).toBe(false);
  });

  it("parses a verified inbound webhook and refuses unsigned ones", () => {
    const params = { CallSid: "CA9", From: "+989121111111", To: "+982177777777", CallStatus: "ringing", Direction: "inbound" };
    const url = "https://app.example.com/api/v1/webhooks/voice/inbound";
    const provider = new TwilioVoiceProvider({ accountSid: "AC1", authToken: AUTH_TOKEN, appUrl: "https://app.example.com" });
    const event = provider.parseInbound({ params, signature: sign(url, params), signatureUrl: url });
    expect(event.CallSid).toBe("CA9");
    expect(event.To).toBe("+982177777777");
    expect(() => provider.parseInbound({ params, signature: "nope", signatureUrl: url })).toThrowError(AppError);
    expect(() =>
      provider.parseInbound({ params: { ...params, CallSid: "" }, signature: sign(url, { ...params, CallSid: "" }), signatureUrl: url }),
    ).toThrowError(/missing CallSid/);
  });
});

describe("TwiML builders", () => {
  it("greets, discloses and connects a media stream with signed parameters", () => {
    const twiml = buildInboundTwiml({
      websocketUrl: "wss://media.example.com/media",
      token: "v1.payload.sig",
      businessId: "biz-1",
      callId: "call-1",
      externalCallId: "CA1",
      disclosure: "این تماس ضبط می‌شود",
    });
    expect(twiml).toContain("<Connect><Stream url=\"wss://media.example.com/media\">");
    expect(twiml).toContain("<Parameter name=\"token\" value=\"v1.payload.sig\" />");
    expect(twiml).toContain("<Parameter name=\"businessId\" value=\"biz-1\" />");
    expect(twiml).toContain("<Parameter name=\"callId\" value=\"call-1\" />");
    expect(twiml).toContain("<Say language=\"fa-IR\">");
    expect(twiml.startsWith("<?xml")).toBe(true);
  });

  it("never emits unescaped caller-controlled XML", () => {
    const twiml = buildInboundTwiml({
      websocketUrl: "wss://media.example.com/media",
      businessId: "biz<1>",
      token: "\"><Hangup/>",
    });
    expect(twiml).not.toContain("<Hangup/>");
    expect(twiml).toContain("&quot;&gt;&lt;Hangup/&gt;");
    expect(escapeXml("<script>alert(1)</script>")).toBe("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  it("rejects calls and dials humans with bounded timeouts", () => {
    expect(buildRejectTwiml("خطا")).toContain("<Hangup />");
    expect(buildDialTwiml("+989121234567", 500)).toContain("<Dial timeout=\"120\">+989121234567</Dial>");
    expect(buildDialTwiml("+989121234567", 1)).toContain("<Dial timeout=\"5\">");
    expect(buildStopStreamTwiml("ai-CA1")).toContain("<Stop><Stream name=\"ai-CA1\" /></Stop>");
  });
});

describe("Twilio media stream envelopes", () => {
  it("translates start/media/dtmf/stop and ignores the rest", () => {
    const start = twilioMediaFrameToAudio({
      event: "start",
      streamSid: "MZ1",
      start: { streamSid: "MZ1", callSid: "CA1", customParameters: { token: "abc", businessId: "biz-1", callId: "c1" } },
    });
    expect(start).toEqual({ type: "start", payload: { token: "abc", businessId: "biz-1", callId: "c1", externalCallId: "CA1", streamSid: "MZ1" } });

    const media = twilioMediaFrameToAudio({ event: "media", media: { payload: Buffer.from([1, 2, 3]).toString("base64") } });
    expect(media?.type).toBe("audio");
    expect(media && media.type === "audio" ? [...media.audio] : []).toEqual([1, 2, 3]);

    expect(twilioMediaFrameToAudio({ event: "dtmf", dtmf: { digit: "0" } })).toEqual({ type: "dtmf", digits: "0" });
    expect(twilioMediaFrameToAudio({ event: "dtmf", dtmf: { digit: "Z" } })).toBeNull();
    expect(twilioMediaFrameToAudio({ event: "stop" })).toEqual({ type: "stop" });
    expect(twilioMediaFrameToAudio({ event: "mark" })).toBeNull();
    expect(twilioMediaFrameToAudio({ event: "media", media: { payload: "" } })).toBeNull();
    expect(twilioMediaFrameToAudio(null)).toBeNull();
  });
});

describe("TwilioVoiceProvider REST adapter", () => {
  const options = {
    accountSid: "AC-test",
    authToken: AUTH_TOKEN,
    appUrl: "https://app.example.com",
    fromNumber: "+982100000000",
    mediaUrl: "wss://media.example.com/media",
  };

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function captureFetch(response: unknown = { sid: "CA1", status: "in-progress" }, status = 200) {
    const calls: Array<{ url: string; body: string; init: RequestInit }> = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), body: String(init.body ?? ""), init });
      return new Response(JSON.stringify(response), { status, headers: { "content-type": "application/json" } });
    });
    return calls;
  }

  it("requires credentials before any network call", () => {
    expect(() => new TwilioVoiceProvider({ accountSid: "", authToken: "" })).toThrowError(/TWILIO_ACCOUNT_SID/);
  });

  it("answers a call by redirecting it to the signed TwiML endpoint", async () => {
    const calls = captureFetch();
    const provider = new TwilioVoiceProvider(options);
    const result = await provider.answerCall("CA1", { requestId: "r1" });
    expect(result.ok).toBe(true);
    expect(calls[0].url).toBe("https://api.twilio.com/2010-04-01/Accounts/AC-test/Calls/CA1.json");
    const body = new URLSearchParams(calls[0].body);
    expect(body.get("Url")).toContain("/api/v1/webhooks/voice/twiml?stage=answer");
    expect(body.get("Method")).toBe("POST");
  });

  it("hangs up, plays audio and validates play input", async () => {
    const calls = captureFetch();
    const provider = new TwilioVoiceProvider(options);
    await provider.hangupCall("CA1", { reason: "completed" });
    expect(new URLSearchParams(calls[0].body).get("Status")).toBe("completed");
    await provider.playAudio("CA1", { text: "سلام <دنیا>" });
    expect(new URLSearchParams(calls[1].body).get("Twiml")).toContain("&lt;دنیا&gt;");
    await expect(provider.playAudio("CA1", {})).rejects.toThrowError(/audioUrl or text/);
  });

  it("starts a stream only for μ-law with tenant context", async () => {
    const calls = captureFetch();
    const provider = new TwilioVoiceProvider(options);
    const started = await provider.startStream("CA1", {
      websocketUrl: "wss://media.example.com/media",
      businessId: "biz-1",
      callId: "call-1",
      mediaToken: "tok",
      codec: "mulaw",
    });
    expect(started.ok).toBe(true);
    const body = new URLSearchParams(calls[0].body);
    expect(body.get("Url")).toContain("stage=stream");
    expect(body.get("Method")).toBe("POST");
    await expect(provider.startStream("CA1", { websocketUrl: "wss://m", businessId: "biz-1", codec: "pcm_s16le" })).rejects.toThrowError(
      /requires mulaw/,
    );
    await expect(provider.startStream("CA1", { websocketUrl: "wss://m", codec: "mulaw" })).rejects.toThrowError(/requires businessId/);
  });

  it("transfers only to E.164 numbers and reports INITIATED until the provider says otherwise", async () => {
    const calls = captureFetch({ status: "queued" });
    const provider = new TwilioVoiceProvider(options);
    const transfer = await provider.transferCall("CA1", "+989121234567", { timeoutSeconds: 20 });
    expect(transfer.transferStatus).toBe("INITIATED");
    expect(new URLSearchParams(calls[0].body).get("Twiml")).toContain("<Dial timeout=\"20\">+989121234567</Dial>");
    await expect(provider.transferCall("CA1", "09121234567")).rejects.toThrowError(/E.164/);
  });

  it("maps provider failures honestly (rate limit, timeout, outage)", async () => {
    const provider = new TwilioVoiceProvider(options);
    vi.stubGlobal("fetch", async () => new Response("{}", { status: 429 }));
    await expect(provider.getCallStatus("CA1")).rejects.toMatchObject({ code: "PROVIDER_RATE_LIMITED" });

    vi.stubGlobal("fetch", async () => {
      const error = new Error("aborted");
      error.name = "AbortError";
      throw error;
    });
    await expect(provider.hangupCall("CA1")).rejects.toMatchObject({ code: "PROVIDER_TIMEOUT" });

    vi.stubGlobal("fetch", async () => {
      throw new TypeError("fetch failed");
    });
    await expect(provider.getCallStatus("CA1")).rejects.toMatchObject({ code: "VOICE_ERROR" });
  });

  it("reports status from the provider resource", async () => {
    captureFetch({ status: "completed" });
    const provider = new TwilioVoiceProvider(options);
    const status = await provider.getCallStatus("CA1");
    expect(status).toMatchObject({ providerCallId: "CA1", status: "completed", provider: "twilio" });
  });
});
