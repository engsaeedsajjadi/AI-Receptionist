import { createHmac, timingSafeEqual } from "node:crypto";
import { AppError } from "@/lib/errors";
import { getEnv } from "@/lib/env";
import { logError, logInfo, logWarn } from "@/lib/logger";
import { metrics } from "@/lib/telemetry";
import { withCircuitBreaker } from "@/lib/circuit-breaker";
import type {
  PlayAudioInput,
  TransferResult,
  VoiceActionResult,
  VoiceCallStatus,
  VoiceProvider,
} from "@/lib/providers/voice";

/**
 * Concrete telephony adapter: Twilio Programmable Voice.
 *
 * Implements the same {@link VoiceProvider} contract as the generic gateway
 * adapter (`answer/hangup/play/stream start|stop/transfer/status`) plus the
 * protocol-specific inbound handling Twilio requires:
 *
 *  - inbound webhooks arrive form-encoded with an `X-Twilio-Signature`
 *    (HMAC-SHA1 over the URL + sorted params) which is verified here,
 *  - "answering" and "starting a media stream" are expressed as TwiML, so the
 *    adapter redirects the live call to a TwiML endpoint this app serves,
 *  - media arrives on Twilio's Media Streams WebSocket protocol — the audio
 *    codec is 8 kHz µ-law; {@link twilioMediaFrameToAudio} bridges those frames
 *    to the internal media session frames.
 *
 * IMPORTANT: no PSTN claim is made by this file. Until a real call completes
 * against a real Twilio account (see docs/LIVE-VALIDATION.md), telephony is
 * reported as BLOCKED — external credentials/acceptance required.
 */

export type TwilioOptions = {
  accountSid: string;
  authToken: string;
  fromNumber?: string;
  /** Public base URL of this app (used to build the TwiML callback URL). */
  appUrl: string;
  timeoutMs: number;
  /** Media stream WS URL (wss://…) the gateway should connect to. */
  mediaUrl?: string;
};

export type TwilioInboundEvent = {
  CallSid: string;
  From: string;
  To: string;
  CallStatus: string;
  Direction?: string;
  FromCity?: string;
  Digits?: string;
};

/**
 * Only provider-health failures (network, timeout, 5xx) feed the circuit
 * breaker; 4xx responses are caller errors and must not open the circuit.
 */
function telephonyHealthFailure(error: unknown): boolean {
  if (error instanceof AppError) return error.status >= 500 || error.status === 408;
  return true;
}

const TWILIO_API = "https://api.twilio.com/2010-04-01";

export function twilioOptionsFromEnv(overrides?: Partial<TwilioOptions>): TwilioOptions {
  const env = getEnv();
  return {
    accountSid: overrides?.accountSid ?? env.TWILIO_ACCOUNT_SID ?? "",
    authToken: overrides?.authToken ?? env.TWILIO_AUTH_TOKEN ?? "",
    fromNumber: overrides?.fromNumber ?? env.TWILIO_PHONE_NUMBER ?? "",
    appUrl: (overrides?.appUrl ?? env.APP_URL).replace(/\/$/, ""),
    timeoutMs: overrides?.timeoutMs ?? 15_000,
    mediaUrl: overrides?.mediaUrl ?? env.VOICE_MEDIA_PUBLIC_URL ?? "",
  };
}

/** Twilio signature: base64(HMAC-SHA1(authToken, url + sorted(params) joined)). */
export function verifyTwilioSignature(input: {
  authToken: string;
  url: string;
  params: Record<string, string>;
  signature: string;
}): boolean {
  if (!input.authToken || !input.signature) return false;
  const data = Object.keys(input.params)
    .sort()
    .reduce((acc, key) => acc + key + input.params[key], input.url);
  const expected = createHmac("sha1", input.authToken).update(Buffer.from(data, "utf8")).digest("base64");
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(input.signature, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

/** XML-escape untrusted values before embedding them in TwiML. */
export function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export type TwimlStreamInput = {
  websocketUrl: string;
  token?: string;
  businessId: string;
  callId?: string;
  externalCallId?: string;
  language?: string;
  /** Spoken disclosure before the AI takes over (recording/assistant notice). */
  disclosure?: string;
  /** Digits the caller may press to reach a human (e.g. "0"); empty disables. */
  handoffDigits?: string;
  handoffNumber?: string;
};

/** Build the TwiML that greets the caller and attaches Twilio Media Streams. */
export function buildInboundTwiml(input: TwimlStreamInput): string {
  const parameters = [
    ["token", input.token ?? ""],
    ["businessId", input.businessId],
    ["callId", input.callId ?? ""],
    ["externalCallId", input.externalCallId ?? ""],
  ]
    .filter(([, value]) => Boolean(value))
    .map(([name, value]) => `<Parameter name="${name}" value="${escapeXml(value)}" />`)
    .join("");
  const say = input.disclosure
    ? `<Say language="${escapeXml(input.language ?? "fa-IR")}">${escapeXml(input.disclosure)}</Say>`
    : "";
  const gather = input.handoffNumber
    ? `<Gather numDigits="1" timeout="3" action="${escapeXml(`${input.websocketUrl.replace(/^wss/, "https").replace(/\/media.*$/, "")}/api/v1/webhooks/voice/voice-dtmf`)}" method="POST" />`
    : "";
  return `<?xml version="1.0" encoding="UTF-8"?><Response>${say}${gather}<Connect><Stream url="${escapeXml(
    input.websocketUrl,
  )}">${parameters}</Stream></Connect></Response>`;
}

/** TwiML that speaks a message and hangs up (used when a call cannot proceed). */
export function buildRejectTwiml(message: string, language = "fa-IR"): string {
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Say language="${escapeXml(language)}">${escapeXml(
    message,
  )}</Say><Hangup /></Response>`;
}

/** TwiML that dials a human destination (transfer/fallback). */
export function buildDialTwiml(destination: string, timeoutSeconds = 30): string {
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Dial timeout="${Math.max(
    5,
    Math.min(120, timeoutSeconds),
  )}">${escapeXml(destination)}</Dial></Response>`;
}

/** TwiML that stops a named media stream without ending the call. */
export function buildStopStreamTwiml(streamName: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Stop><Stream name="${escapeXml(
    streamName,
  )}" /></Stop><Pause length="1" /></Response>`;
}

/**
 * Translate one Twilio Media Streams envelope into the internal media frame.
 * Unknown/irrelevant events (connected/mark) return null.
 */
export function twilioMediaFrameToAudio(
  envelope: unknown,
): { type: "start"; payload: Record<string, string> } | { type: "audio"; audio: Buffer } | { type: "dtmf"; digits: string } | { type: "stop" } | null {
  if (typeof envelope !== "object" || envelope === null) return null;
  const event = envelope as { event?: string; start?: Record<string, unknown>; media?: { payload?: string }; dtmf?: { digit?: string }; streamSid?: string };
  switch (event.event) {
    case "start": {
      const start = (event.start ?? {}) as Record<string, unknown>;
      const custom = (start.customParameters ?? {}) as Record<string, unknown>;
      const params: Record<string, string> = {};
      for (const [key, value] of Object.entries(custom)) params[key] = String(value ?? "");
      params.externalCallId = String(start.callSid ?? params.externalCallId ?? "");
      params.streamSid = String(start.streamSid ?? event.streamSid ?? "");
      return { type: "start", payload: params };
    }
    case "media": {
      const payload = event.media?.payload;
      if (typeof payload !== "string" || payload.length === 0) return null;
      return { type: "audio", audio: Buffer.from(payload, "base64") };
    }
    case "dtmf": {
      const digit = event.dtmf?.digit;
      return typeof digit === "string" && /^[0-9*#A-D]$/.test(digit) ? { type: "dtmf", digits: digit } : null;
    }
    case "stop":
      return { type: "stop" };
    default:
      return null;
  }
}

export class TwilioVoiceProvider implements VoiceProvider {
  readonly name = "twilio";
  private options: TwilioOptions;

  constructor(overrides?: Partial<TwilioOptions>) {
    this.options = twilioOptionsFromEnv(overrides);
    if (!this.options.accountSid || !this.options.authToken) {
      throw new AppError(
        503,
        "PROVIDER_NOT_CONFIGURED",
        "TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN are required for VOICE_PROVIDER=twilio",
      );
    }
  }

  private authHeader(): string {
    return `Basic ${Buffer.from(`${this.options.accountSid}:${this.options.authToken}`).toString("base64")}`;
  }

  private async updateCall(
    providerCallId: string,
    body: Record<string, string>,
    requestId?: string,
  ): Promise<Record<string, unknown>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs);
    const url = `${TWILIO_API}/Accounts/${encodeURIComponent(this.options.accountSid)}/Calls/${encodeURIComponent(providerCallId)}.json`;
    try {
      return await withCircuitBreaker(
        "telephony:twilio",
        async () => {
          const res = await fetch(url, {
            method: "POST",
            headers: {
              Authorization: this.authHeader(),
              "Content-Type": "application/x-www-form-urlencoded",
              ...(requestId ? { "X-Request-Id": requestId } : {}),
            },
            body: new URLSearchParams(body).toString(),
            signal: controller.signal,
          });
          const text = await res.text();
          const json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
          if (!res.ok) {
            metrics().providerErrors.inc({ provider: this.name, operation: "telephony" });
            if (res.status === 429)
              throw new AppError(429, "PROVIDER_RATE_LIMITED", "Twilio rate limited", { detail: json });
            throw new AppError(502, "VOICE_ERROR", `Twilio error (HTTP ${res.status})`, { detail: json });
          }
          return json;
        },
        { shouldCountFailure: telephonyHealthFailure },
      );
    } catch (err) {
      const aborted = err instanceof Error && err.name === "AbortError";
      metrics().providerErrors.inc({ provider: this.name, operation: "telephony" });
      logError("Twilio request failed", {
        requestId,
        provider: this.name,
        operation: "voice.twilio",
        status: "error",
        error: err instanceof Error ? err.message : String(err),
      });
      if (aborted) throw new AppError(504, "PROVIDER_TIMEOUT", "Twilio request timeout");
      throw err instanceof AppError ? err : new AppError(502, "VOICE_ERROR", "Twilio unreachable");
    } finally {
      clearTimeout(timer);
    }
  }

  private async getCall(providerCallId: string, requestId?: string): Promise<Record<string, unknown>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs);
    const url = `${TWILIO_API}/Accounts/${encodeURIComponent(this.options.accountSid)}/Calls/${encodeURIComponent(providerCallId)}.json`;
    try {
      const json = await withCircuitBreaker(
        "telephony:twilio",
        async () => {
          const res = await fetch(url, {
            headers: { Authorization: this.authHeader(), ...(requestId ? { "X-Request-Id": requestId } : {}) },
            signal: controller.signal,
          });
          const text = await res.text();
          const payload = text ? (JSON.parse(text) as Record<string, unknown>) : {};
          if (res.ok) return payload;
          metrics().providerErrors.inc({ provider: this.name, operation: "telephony" });
          if (res.status === 429)
            throw new AppError(429, "PROVIDER_RATE_LIMITED", "Twilio rate limited", { detail: payload });
          throw new AppError(
            res.status === 404 ? 404 : 502,
            res.status === 404 ? "CALL_NOT_FOUND" : "VOICE_ERROR",
            `Twilio error (HTTP ${res.status})`,
            { detail: payload },
          );
        },
        { shouldCountFailure: telephonyHealthFailure },
      );
      return json;
    } catch (err) {
      if (err instanceof AppError) throw err;
      const aborted = err instanceof Error && err.name === "AbortError";
      metrics().providerErrors.inc({ provider: this.name, operation: "telephony" });
      if (aborted) throw new AppError(504, "PROVIDER_TIMEOUT", "Twilio request timeout");
      throw new AppError(502, "VOICE_ERROR", "Twilio unreachable");
    } finally {
      clearTimeout(timer);
    }
  }



  /** TwiML endpoint this adapter redirects live calls to. */
  twimlUrl(params: Record<string, string>): string {
    const query = new URLSearchParams(params).toString();
    return `${this.options.appUrl}/api/v1/webhooks/voice/twiml?${query}`;
  }

  async answerCall(providerCallId: string, opts?: { requestId?: string }): Promise<VoiceActionResult> {
    // Answering an inbound call = pointing the call at TwiML that greets the
    // caller. The actual TwiML is served by our own endpoint so the greeting,
    // disclosure and stream parameters stay under application control.
    const raw = await this.updateCall(
      providerCallId,
      { Url: this.twimlUrl({ stage: "answer", external_call_id: providerCallId }), Method: "POST" },
      opts?.requestId,
    );
    logInfo("Twilio call answered", { requestId: opts?.requestId, provider: this.name, operation: "voice.answer" });
    return { ok: true, providerCallId, provider: this.name, raw };
  }

  async hangupCall(providerCallId: string, opts?: { reason?: string; requestId?: string }): Promise<VoiceActionResult> {
    const raw = await this.updateCall(providerCallId, { Status: "completed" }, opts?.requestId);
    return { ok: true, providerCallId, provider: this.name, raw };
  }

  async playAudio(providerCallId: string, audio: PlayAudioInput, opts?: { requestId?: string }): Promise<VoiceActionResult> {
    if (!audio.audioUrl && !audio.text) {
      throw new AppError(400, "INVALID_PAYLOAD", "playAudio requires audioUrl or text");
    }
    const inner = audio.audioUrl
      ? `<Play>${escapeXml(audio.audioUrl)}</Play>`
      : `<Say language="${escapeXml(audio.language ?? getEnv().VOICE_DEFAULT_LANGUAGE)}">${escapeXml(audio.text ?? "")}</Say>`;
    const raw = await this.updateCall(
      providerCallId,
      { Twiml: `<?xml version="1.0" encoding="UTF-8"?><Response>${inner}</Response>` },
      opts?.requestId,
    );
    return { ok: true, providerCallId, provider: this.name, raw };
  }

  async startStream(
    providerCallId: string,
    opts: {
      websocketUrl: string;
      language?: string;
      requestId?: string;
      businessId?: string;
      callId?: string;
      mediaToken?: string;
      codec?: string;
      sampleRate?: number;
    },
  ): Promise<VoiceActionResult> {
    if (!opts.businessId) throw new AppError(400, "INVALID_PAYLOAD", "startStream requires businessId for the media session token");
    // Twilio media streams are µ-law 8 kHz; anything else must be transcoded by
    // the caller, so refuse a mismatched codec instead of producing silence.
    if (opts.codec && opts.codec !== "mulaw" && opts.codec !== "unknown") {
      throw new AppError(400, "INVALID_PAYLOAD", `Twilio Media Streams requires mulaw audio (got ${opts.codec})`);
    }
    const params: Record<string, string> = {
      stage: "stream",
      external_call_id: providerCallId,
      business_id: opts.businessId,
      websocket_url: opts.websocketUrl,
      method: "POST",
    };
    if (opts.callId) params.call_id = opts.callId;
    if (opts.mediaToken) params.media_token = opts.mediaToken;
    if (opts.language) params.language = opts.language;
    const raw = await this.updateCall(providerCallId, { Url: this.twimlUrl(params), Method: "POST" }, opts.requestId);
    return { ok: true, providerCallId, provider: this.name, raw };
  }

  async stopStream(providerCallId: string, opts?: { requestId?: string }): Promise<VoiceActionResult> {
    const streamName = `ai-${providerCallId}`;
    const raw = await this.updateCall(
      providerCallId,
      { Twiml: buildStopStreamTwiml(streamName) },
      opts?.requestId,
    );
    return { ok: true, providerCallId, provider: this.name, raw };
  }

  async transferCall(
    providerCallId: string,
    destination: string,
    opts?: { timeoutSeconds?: number; requestId?: string },
  ): Promise<TransferResult> {
    if (!/^\+[1-9]\d{6,14}$/.test(destination)) {
      throw new AppError(400, "INVALID_PAYLOAD", "Transfer destination must be an E.164 number");
    }
    try {
      const raw = await this.updateCall(
        providerCallId,
        { Twiml: buildDialTwiml(destination, opts?.timeoutSeconds ?? 30) },
        opts?.requestId,
      );
      // Observe the provider's own status rather than claiming the human
      // answered: polling once right after redirect is honest about "INITIATED".
      const status = String(raw.status ?? "queued").toLowerCase();
      return {
        ok: true,
        providerCallId,
        provider: this.name,
        transferStatus: status === "in-progress" ? "INITIATED" : "INITIATED",
        raw,
      };
    } catch (err) {
      logWarn("Twilio transfer failed", {
        requestId: opts?.requestId,
        provider: this.name,
        operation: "voice.transfer",
        status: "error",
        error: err instanceof Error ? err.message : String(err),
      });
      if (err instanceof AppError) {
        throw new AppError(502, "TRANSFER_FAILED", "Call transfer failed at Twilio", { cause: err.message });
      }
      throw err;
    }
  }

  async getCallStatus(providerCallId: string, opts?: { requestId?: string }): Promise<VoiceCallStatus> {
    const raw = await this.getCall(providerCallId, opts?.requestId);
    return { providerCallId, status: String(raw.status ?? "unknown"), provider: this.name, raw };
  }

  /**
   * Verify + normalise an inbound Twilio webhook (call started / answered).
   * `signatureUrl` must be the exact public URL Twilio signed (including the
   * query string); TRUST_PROXY must be true when running behind a proxy.
   */
  parseInbound(input: {
    params: Record<string, string>;
    signature: string | undefined;
    signatureUrl: string;
  }): TwilioInboundEvent {
    const verified = verifyTwilioSignature({
      authToken: this.options.authToken,
      url: input.signatureUrl,
      params: input.params,
      signature: input.signature ?? "",
    });
    if (!verified) throw new AppError(401, "INVALID_SIGNATURE", "Invalid Twilio webhook signature");
    const required = ["CallSid", "From", "To", "CallStatus"];
    for (const key of required) {
      if (!input.params[key]) throw new AppError(400, "INVALID_PAYLOAD", `Twilio webhook is missing ${key}`);
    }
    return {
      CallSid: input.params.CallSid,
      From: input.params.From,
      To: input.params.To,
      CallStatus: input.params.CallStatus,
      Direction: input.params.Direction,
      FromCity: input.params.FromCity,
      Digits: input.params.Digits,
    };
  }
}

export function voiceProviderName(): "twilio" | "generic" | "dev" {
  const configured = getEnv().VOICE_PROVIDER;
  return configured === "twilio" ? "twilio" : configured === "generic" ? "generic" : "dev";
}
