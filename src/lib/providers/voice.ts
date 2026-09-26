import { AppError } from "@/lib/errors";
import { getEnv } from "@/lib/env";
import { logError, logInfo } from "@/lib/logger";
import { assertConfigured } from "@/lib/providers/types";
import { NO_VOICE_CAPABILITIES, type VoiceCapabilities } from "@/lib/providers/capabilities";

/**
 * Telephony provider abstraction.
 *
 * The production implementation is {@link GenericVoiceProvider}: a thin,
 * documented HTTP adapter over the operator's telephony API. Telephony
 * vendors in the target market (SIP trunks, cloud PBXs, voice APIs) expose
 * different protocols; the generic adapter defines ONE contract the app
 * speaks, and the operator points it at their gateway (or a small protocol
 * shim) via VOICE_API_BASE_URL / VOICE_API_KEY.
 *
 * Required telephony-gateway contract (all JSON, Bearer auth):
 *   POST {base}/calls/{providerCallId}/answer               { idempotencyKey? }
 *   POST {base}/calls/{providerCallId}/hangup            { reason? }
 *   POST {base}/calls/{providerCallId}/play              { audioUrl?, text?, language? }
 *   POST {base}/calls/{providerCallId}/transfer          { destination, timeoutSeconds?, idempotencyKey? }
 *     (idempotencyKey: gateways SHOULD dedup retries carrying the same key —
 *     the app re-issues with a stable key when recovering a crashed transfer)
 *   POST {base}/calls/{providerCallId}/stream/start      { websocketUrl, language?, mediaToken, idempotencyKey? }
 * The gateway MUST forward mediaToken verbatim as `token` in the media
 * WebSocket `start` frame. It is a short-lived per-call credential issued
 * at call-started (see src/lib/voice/media-tokens.ts) — never the static
 * VOICE_MEDIA_TOKEN, which never leaves the app/sidecar pair.
 *   POST {base}/calls/{providerCallId}/stream/stop
 *   GET  {base}/calls/{providerCallId}                   → { status, ... }
 * Inbound events arrive at /api/v1/webhooks/voice/* (HMAC-signed).
 * See README § "Voice / telephony" for the full contract.
 */

export type VoiceActionResult = {
  ok: boolean;
  providerCallId: string;
  provider: string;
  message?: string;
  raw?: unknown;
};

export type TransferResult = VoiceActionResult & {
  transferStatus: "INITIATED" | "COMPLETED" | "FAILED";
};

export type VoiceCallStatus = {
  providerCallId: string;
  status: string;
  provider: string;
  raw?: unknown;
};

export type PlayAudioInput = {
  /** Publicly reachable audio URL (preferred for telephony gateways). */
  audioUrl?: string;
  /** Fallback: gateway-side TTS text (Persian). */
  text?: string;
  language?: string;
};

export interface VoiceProvider {
  readonly name: string;
  /** Explicit capability declaration — detect features, never assume them. */
  readonly capabilities: VoiceCapabilities;
  answerCall(
    providerCallId: string,
    opts?: { requestId?: string; idempotencyKey?: string },
  ): Promise<VoiceActionResult>;
  hangupCall(providerCallId: string, opts?: { reason?: string; requestId?: string }): Promise<VoiceActionResult>;
  playAudio(providerCallId: string, audio: PlayAudioInput, opts?: { requestId?: string }): Promise<VoiceActionResult>;
  startStream(
    providerCallId: string,
    opts: { websocketUrl: string; language?: string; requestId?: string; mediaToken: string; idempotencyKey?: string },
  ): Promise<VoiceActionResult>;
  stopStream(providerCallId: string, opts?: { requestId?: string }): Promise<VoiceActionResult>;
  transferCall(
    providerCallId: string,
    destination: string,
    opts?: { timeoutSeconds?: number; requestId?: string; idempotencyKey?: string },
  ): Promise<TransferResult>;
  getCallStatus(providerCallId: string, opts?: { requestId?: string }): Promise<VoiceCallStatus>;
}

type GenericVoiceOptions = {
  baseURL: string;
  apiKey: string;
  timeoutMs: number;
  maxRetries: number;
};

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export class GenericVoiceProvider implements VoiceProvider {
  readonly name = "generic";
  /**
   * Honest contract of the generic telephony gateway: turn-based playback
   * (whole audio file / gateway TTS), media input over WebSocket, SIP-style
   * transfer. No sample-level duplex audio, no DTMF, no provider recording.
   */
  readonly capabilities: VoiceCapabilities = {
    supportsTransfer: true,
    supportsStreamingInput: true,
    supportsSendAudio: false,
    supportsBidirectionalAudio: false,
    supportsDTMF: false,
    supportsRecording: false,
    playbackModes: ["audio-url", "gateway-tts"],
    streamingProtocol: "websocket",
  };
  private baseURL: string;
  private apiKey: string;
  private timeoutMs: number;
  private maxRetries: number;

  constructor(overrides?: Partial<GenericVoiceOptions>) {
    const e = getEnv();
    this.baseURL = (overrides?.baseURL ?? e.VOICE_API_BASE_URL).replace(/\/$/, "");
    this.apiKey = overrides?.apiKey ?? e.VOICE_API_KEY;
    this.timeoutMs = overrides?.timeoutMs ?? 15_000;
    this.maxRetries = overrides?.maxRetries ?? 2;
    assertConfigured(
      Boolean(this.baseURL && this.apiKey),
      "VOICE_API_BASE_URL and VOICE_API_KEY are required for VOICE_PROVIDER=generic",
    );
  }

  private async request<T>(method: string, path: string, body?: unknown, requestId?: string): Promise<T> {
    let lastError: unknown = null;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const res = await fetch(`${this.baseURL}${path}`, {
          method,
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            "Content-Type": "application/json",
            ...(requestId ? { "X-Request-Id": requestId } : {}),
          },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: controller.signal,
        });
        clearTimeout(timer);
        const text = await res.text();
        let parsed: unknown = null;
        try {
          parsed = text ? (JSON.parse(text) as unknown) : null;
        } catch {
          parsed = { raw: text };
        }
        if (!res.ok) {
          if (res.status === 429) {
            throw new AppError(429, "PROVIDER_RATE_LIMITED", "Voice gateway rate limited", { detail: parsed });
          }
          throw new AppError(502, "VOICE_ERROR", `Voice gateway error (HTTP ${res.status})`, { detail: parsed });
        }
        return parsed as T;
      } catch (err) {
        clearTimeout(timer);
        lastError = err;
        if (err instanceof AppError && err.code !== "VOICE_ERROR") throw err;
        const aborted = err instanceof Error && err.name === "AbortError";
        logError("Voice gateway request failed", {
          requestId,
          provider: this.name,
          operation: `voice.${method} ${path}`,
          status: "error",
          error: err,
        });
        if (attempt < this.maxRetries && (aborted || err instanceof TypeError || err instanceof AppError)) {
          await sleep(250 * 2 ** attempt);
          continue;
        }
        if (aborted) throw new AppError(504, "PROVIDER_TIMEOUT", "Voice gateway timeout");
        throw err instanceof AppError ? err : new AppError(502, "VOICE_ERROR", "Voice gateway unreachable");
      }
    }
    throw lastError instanceof AppError ? lastError : new AppError(502, "VOICE_ERROR", "Voice gateway request failed");
  }

  async answerCall(
    providerCallId: string,
    opts?: { requestId?: string; idempotencyKey?: string },
  ): Promise<VoiceActionResult> {
    const raw = await this.request<unknown>(
      "POST",
      `/calls/${encodeURIComponent(providerCallId)}/answer`,
      { ...(opts?.idempotencyKey ? { idempotencyKey: opts.idempotencyKey } : {}) },
      opts?.requestId,
    );
    logInfo("Voice call answered", { requestId: opts?.requestId, provider: this.name, operation: "voice.answer" });
    return { ok: true, providerCallId, provider: this.name, raw };
  }

  async hangupCall(
    providerCallId: string,
    opts?: { reason?: string; requestId?: string },
  ): Promise<VoiceActionResult> {
    const raw = await this.request<unknown>(
      "POST",
      `/calls/${encodeURIComponent(providerCallId)}/hangup`,
      { reason: opts?.reason ?? "completed" },
      opts?.requestId,
    );
    return { ok: true, providerCallId, provider: this.name, raw };
  }

  async playAudio(
    providerCallId: string,
    audio: PlayAudioInput,
    opts?: { requestId?: string },
  ): Promise<VoiceActionResult> {
    if (!audio.audioUrl && !audio.text) {
      throw new AppError(400, "INVALID_PAYLOAD", "playAudio requires audioUrl or text");
    }
    const raw = await this.request<unknown>(
      "POST",
      `/calls/${encodeURIComponent(providerCallId)}/play`,
      { audioUrl: audio.audioUrl, text: audio.text, language: audio.language ?? getEnv().VOICE_DEFAULT_LANGUAGE },
      opts?.requestId,
    );
    return { ok: true, providerCallId, provider: this.name, raw };
  }

  async startStream(
    providerCallId: string,
    opts: { websocketUrl: string; language?: string; requestId?: string; mediaToken: string; idempotencyKey?: string },
  ): Promise<VoiceActionResult> {
    if (!opts.mediaToken) {
      throw new AppError(500, "INTERNAL_ERROR", "startStream requires a per-call media token");
    }
    const raw = await this.request<unknown>(
      "POST",
      `/calls/${encodeURIComponent(providerCallId)}/stream/start`,
      {
        websocketUrl: opts.websocketUrl,
        language: opts.language ?? getEnv().VOICE_DEFAULT_LANGUAGE,
        mediaToken: opts.mediaToken,
        ...(opts?.idempotencyKey ? { idempotencyKey: opts.idempotencyKey } : {}),
      },
      opts.requestId,
    );
    return { ok: true, providerCallId, provider: this.name, raw };
  }

  async stopStream(providerCallId: string, opts?: { requestId?: string }): Promise<VoiceActionResult> {
    const raw = await this.request<unknown>(
      "POST",
      `/calls/${encodeURIComponent(providerCallId)}/stream/stop`,
      {},
      opts?.requestId,
    );
    return { ok: true, providerCallId, provider: this.name, raw };
  }

  async transferCall(
    providerCallId: string,
    destination: string,
    opts?: { timeoutSeconds?: number; requestId?: string; idempotencyKey?: string },
  ): Promise<TransferResult> {
    if (!destination) throw new AppError(400, "INVALID_PAYLOAD", "Transfer destination is required");
    try {
      const raw = await this.request<{ status?: string }>(
        "POST",
        `/calls/${encodeURIComponent(providerCallId)}/transfer`,
        {
          destination,
          timeoutSeconds: opts?.timeoutSeconds ?? 30,
          ...(opts?.idempotencyKey ? { idempotencyKey: opts.idempotencyKey } : {}),
        },
        opts?.requestId,
      );
      const status = String(raw?.status ?? "initiated").toLowerCase();
      return {
        ok: true,
        providerCallId,
        provider: this.name,
        transferStatus: status === "completed" ? "COMPLETED" : "INITIATED",
        raw,
      };
    } catch (err) {
      if (err instanceof AppError && (err.code === "VOICE_ERROR" || err.code === "PROVIDER_TIMEOUT")) {
        throw new AppError(502, "TRANSFER_FAILED", "Call transfer failed at the voice gateway", {
          cause: err.message,
        });
      }
      throw err;
    }
  }

  async getCallStatus(providerCallId: string, opts?: { requestId?: string }): Promise<VoiceCallStatus> {
    const raw = await this.request<{ status?: string }>(
      "GET",
      `/calls/${encodeURIComponent(providerCallId)}`,
      undefined,
      opts?.requestId,
    );
    return { providerCallId, status: String(raw?.status ?? "unknown"), provider: this.name, raw };
  }
}

/**
 * Development voice provider. NEVER pretends a phone call happened — every
 * operation throws a configuration error. Used only to fail clearly.
 */
export class DevVoiceProvider implements VoiceProvider {
  readonly name = "dev";
  readonly capabilities: VoiceCapabilities = NO_VOICE_CAPABILITIES;
  private fail(): never {
    throw new AppError(
      503,
      "PROVIDER_NOT_CONFIGURED",
      "Voice provider is not configured. Set VOICE_PROVIDER=generic with VOICE_API_BASE_URL and VOICE_API_KEY.",
    );
  }
  async answerCall(): Promise<VoiceActionResult> {
    this.fail();
  }
  async hangupCall(): Promise<VoiceActionResult> {
    this.fail();
  }
  async playAudio(): Promise<VoiceActionResult> {
    this.fail();
  }
  async startStream(): Promise<VoiceActionResult> {
    this.fail();
  }
  async stopStream(): Promise<VoiceActionResult> {
    this.fail();
  }
  async transferCall(): Promise<TransferResult> {
    this.fail();
  }
  async getCallStatus(): Promise<VoiceCallStatus> {
    this.fail();
  }
}

export function getVoiceProvider(): VoiceProvider {
  switch (getEnv().VOICE_PROVIDER) {
    case "generic":
      return new GenericVoiceProvider();
    case "dev":
      return new DevVoiceProvider();
  }
}
