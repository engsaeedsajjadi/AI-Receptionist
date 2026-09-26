import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { calls } from "@/db/schema";
import { AppError } from "@/lib/errors";
import { getEnv } from "@/lib/env";
import { logWarn } from "@/lib/logger";
import { getVoiceProvider } from "@/lib/providers/voice";
import { issueMediaToken, verifyMediaToken } from "@/lib/voice/media-tokens";

/**
 * Fail-closed media bootstrap (§3).
 *
 * Invariant: `call-started` never answers a call unless the FULL media chain
 * for that call is validated and usable. Three disjoint outcomes:
 *
 * A) Config incomplete/invalid → graceful HTTP 200, `answered: false`, an
 *    honest machine-readable reason — and `answerCall()` is NEVER invoked.
 *    Configuration failure = `200 + no answer`, never `answer + broken
 *    media` (no caller is ever connected to silence by design).
 * B) Transient provider failure (after all config validated) → throws a
 *    retryable 502. The route records the inbox event FAILED, and a
 *    redelivery reconciles: already-answered stages are skipped, pending
 *    stages re-run with STABLE provider operation keys so capable gateways
 *    dedup (`answer:{callId}` / `stream:{callId}`).
 * C) Full success → `answered + streaming`, HTTP 200.
 *
 * Ordering (enforced, tested): validate config → mint + self-verify the
 * per-call token → answerCall() → startStream(). The mint-verify round-trip
 * before answer catches token-secret skew while the call is still safely
 * unanswered.
 */

export type MediaConfigReason =
  | "duplicate"
  | "auto_answer_disabled"
  | "voice_provider_not_configured"
  | "media_public_url_missing"
  | "media_token_missing"
  | "media_config_invalid";

export type MediaBootstrap = {
  attempted: boolean;
  answered: boolean;
  streaming: boolean;
  reason?: string;
};

export type MediaBootstrapConfig = {
  provider: string;
  gatewayBaseUrl: string;
  gatewayApiKey: string;
  autoAnswer: boolean;
  mediaPublicUrl: string;
  mediaTokenSecret: string;
  mediaTokenTtlSeconds: number;
};

/**
 * Pure prerequisite validation (§3.A). Never throws for config problems —
 * returns the honest skip reason (fail-closed 200, not 500).
 */
export function validateMediaBootstrapConfig(
  cfg: MediaBootstrapConfig,
): { ok: true } | { ok: false; reason: Exclude<MediaConfigReason, "duplicate"> } {
  if (cfg.provider !== "generic" || !cfg.gatewayBaseUrl.trim() || !cfg.gatewayApiKey.trim()) {
    return { ok: false, reason: "voice_provider_not_configured" };
  }
  if (!cfg.autoAnswer) return { ok: false, reason: "auto_answer_disabled" };
  if (!cfg.mediaPublicUrl.trim()) return { ok: false, reason: "media_public_url_missing" };
  try {
    const url = new URL(cfg.mediaPublicUrl.trim());
    // The gateway must open a media WebSocket to this URL — anything else
    // would fail AFTER answer, which is exactly what fail-closed prevents.
    if (url.protocol !== "ws:" && url.protocol !== "wss:") {
      return { ok: false, reason: "media_config_invalid" };
    }
  } catch {
    return { ok: false, reason: "media_config_invalid" };
  }
  if (!cfg.mediaTokenSecret) return { ok: false, reason: "media_token_missing" };
  if (!Number.isFinite(cfg.mediaTokenTtlSeconds) || cfg.mediaTokenTtlSeconds <= 0) {
    return { ok: false, reason: "media_config_invalid" };
  }
  return { ok: true };
}

/**
 * Resolve the effective config from env + per-business voice settings.
 * Pure validation of the result stays in `validateMediaBootstrapConfig`
 * (unit-testable without env manipulation).
 */
export function resolveMediaBootstrapConfig(businessSettings?: Record<string, unknown>): MediaBootstrapConfig {
  const e = getEnv();
  const voiceSettings = (businessSettings?.voice as Record<string, unknown> | undefined) ?? {};
  const autoAnswer =
    typeof voiceSettings.autoAnswer === "boolean" ? voiceSettings.autoAnswer : e.VOICE_AUTO_ANSWER;
  return {
    provider: e.VOICE_PROVIDER,
    gatewayBaseUrl: e.VOICE_API_BASE_URL,
    gatewayApiKey: e.VOICE_API_KEY,
    autoAnswer,
    mediaPublicUrl: e.VOICE_MEDIA_PUBLIC_URL,
    mediaTokenSecret: e.VOICE_MEDIA_TOKEN,
    mediaTokenTtlSeconds: e.VOICE_MEDIA_TOKEN_TTL_SECONDS,
  };
}

/** Durable per-call bootstrap progress (calls.metadata.bootstrap). */
export type BootstrapState = { answered: boolean; streaming: boolean };

export function parseBootstrapState(metadata: unknown): BootstrapState {
  const bootstrap = (metadata as { bootstrap?: unknown } | null)?.bootstrap as
    | { answered?: unknown; streaming?: unknown }
    | undefined;
  return { answered: bootstrap?.answered === true, streaming: bootstrap?.streaming === true };
}

/**
 * Stable provider operation keys (§3.B): every (re)try of the same call
 * carries the same key so gateways with idempotency support dedup a
 * retried answer/stream instead of double-executing it.
 */
export function mediaOperationKeys(callId: string): { answer: string; stream: string } {
  return { answer: `answer:${callId}`, stream: `stream:${callId}` };
}

/**
 * Record one completed bootstrap stage. Values are idempotent flags that
 * only ever flip false → true, so concurrent recorders converge instead of
 * corrupting each other (last-write-wins is safe here).
 */
export async function recordBootstrapProgress(
  businessId: string,
  callId: string,
  patch: { answered?: true; streaming?: true },
): Promise<void> {
  const [row] = await db
    .select({ metadata: calls.metadata })
    .from(calls)
    .where(and(eq(calls.id, callId), eq(calls.businessId, businessId)))
    .limit(1);
  if (!row) return;
  const prev = parseBootstrapState(row.metadata);
  const stamp = new Date().toISOString();
  await db
    .update(calls)
    .set({
      metadata: {
        ...((row.metadata as Record<string, unknown> | null) ?? {}),
        bootstrap: {
          answered: prev.answered || patch.answered === true,
          streaming: prev.streaming || patch.streaming === true,
          ...(patch.answered === true ? { answeredAt: stamp } : {}),
          ...(patch.streaming === true ? { streamingAt: stamp } : {}),
        },
      },
    })
    .where(and(eq(calls.id, callId), eq(calls.businessId, businessId)));
}

/**
 * Answer + start media streaming for a call, fail-closed (§3).
 *
 * - `bootstrapState` (from the call row) drives reconciliation: stages a
 *   previous attempt completed are skipped, pending stages re-run.
 * - Returns a report for config skips / duplicates / full success.
 * - THROWS retryable AppError(502, VOICE_ERROR) for transient provider
 *   failures (answer_failed / stream_start_failed). Callers must record
 *   the failure durably (inbox FAILED) so redelivery retries.
 */
export async function bootstrapMedia(input: {
  businessId: string;
  businessSettings: Record<string, unknown>;
  callId: string;
  externalCallId: string;
  requestId: string;
  bootstrapState: BootstrapState;
}): Promise<MediaBootstrap> {
  const { bootstrapState } = input;
  // Already fully bootstrapped: report the true state, run nothing.
  if (bootstrapState.answered && bootstrapState.streaming) {
    return { attempted: false, answered: true, streaming: true, reason: "duplicate" };
  }

  // (1) Validate provider/config BEFORE any provider operation runs.
  const cfg = resolveMediaBootstrapConfig(input.businessSettings);
  const valid = validateMediaBootstrapConfig(cfg);
  if (!valid.ok) {
    return {
      attempted: false,
      answered: bootstrapState.answered,
      streaming: bootstrapState.streaming,
      reason: valid.reason,
    };
  }

  // (2) Mint + self-verify the per-call token BEFORE answering. The token
  // itself goes to the gateway only — never logged, never returned.
  let mediaToken: string;
  try {
    mediaToken = issueMediaToken({
      businessId: input.businessId,
      callId: input.callId,
      externalCallId: input.externalCallId,
      ttlSeconds: cfg.mediaTokenTtlSeconds,
      secret: cfg.mediaTokenSecret,
    });
    const claims = verifyMediaToken(mediaToken, cfg.mediaTokenSecret);
    if (claims.callId !== input.callId || claims.businessId !== input.businessId) {
      throw new Error("Media token binding mismatch");
    }
  } catch {
    return {
      attempted: false,
      answered: bootstrapState.answered,
      streaming: bootstrapState.streaming,
      reason: "media_config_invalid",
    };
  }

  const voice = getVoiceProvider();
  const keys = mediaOperationKeys(input.callId);

  // (3) Answer — skipped when a previous attempt already answered.
  if (!bootstrapState.answered) {
    try {
      await voice.answerCall(input.externalCallId, { requestId: input.requestId, idempotencyKey: keys.answer });
    } catch (err) {
      logWarn("Voice answer failed (retryable; call record kept)", {
        requestId: input.requestId,
        operation: "voice.answer",
        status: "error",
        error: err instanceof Error ? err.message : String(err),
      });
      throw new AppError(502, "VOICE_ERROR", "Voice answer failed", {
        stage: "answer",
        reason: "answer_failed",
      });
    }
    await recordBootstrapProgress(input.businessId, input.callId, { answered: true });
  }

  // (4) Stream — skipped when already streaming.
  if (!bootstrapState.streaming) {
    try {
      await voice.startStream(input.externalCallId, {
        websocketUrl: cfg.mediaPublicUrl,
        requestId: input.requestId,
        mediaToken,
        idempotencyKey: keys.stream,
      });
    } catch (err) {
      // Answer is durably recorded above: a redelivery reconciles by
      // running this stage only (no duplicate answer).
      logWarn("Voice stream start failed (retryable; call answered, no media yet)", {
        requestId: input.requestId,
        operation: "voice.stream.start",
        status: "error",
        error: err instanceof Error ? err.message : String(err),
      });
      throw new AppError(502, "VOICE_ERROR", "Voice stream start failed", {
        stage: "stream",
        reason: "stream_start_failed",
      });
    }
    await recordBootstrapProgress(input.businessId, input.callId, { streaming: true });
  }

  return { attempted: true, answered: true, streaming: true };
}
