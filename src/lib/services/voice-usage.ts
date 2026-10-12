import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { auditLogs, calls, usageRecords } from "@/db/schema";
import { AppError } from "@/lib/errors";
import { assertTenantScope } from "@/lib/request-context";
import { logWarn } from "@/lib/logger";
import { getEnv } from "@/lib/env";
import { reserveUsageInTransaction, settleUsage, type QuotaTx } from "@/lib/services/quotas";

/**
 * Voice usage accounting from trusted lifecycle events.
 *
 * Billable duration is NOT taken from the client. It is derived from:
 *   1. the media/telephony lifecycle the app itself observed
 *      (`media_started_at` / `connected_at` / `ended_at` written by the signed
 *      webhook and media paths), and
 *   2. the provider's signed `call-ended` report.
 * When both exist the smaller of the two wins, so a client cannot inflate a
 * bill and the app cannot bill for time it never carried audio for. The
 * difference is recorded as `durationVarianceSeconds` for reconciliation.
 *
 * STT seconds come from the media pipeline's per-turn transcription results
 * (provider-reported `durationSeconds`), accumulated on the call row — never
 * from a text length heuristic.
 */

/** Hard ceiling for a single call's reserved airtime (minutes). */
export function maxCallMinutes(): number {
  const raw = Number(process.env.VOICE_MAX_CALL_MINUTES ?? "60");
  return Number.isFinite(raw) && raw > 0 && raw <= 480 ? raw : 60;
}

/** Default per-utterance STT reservation bound (minutes). */
export function maxSttMinutes(): number {
  const raw = Number(process.env.VOICE_STT_RESERVE_MINUTES ?? "2");
  return Number.isFinite(raw) && raw > 0 && raw <= 60 ? raw : 2;
}

/** Grace added to the provider-reported duration before trusting observed time. */
export const OBSERVED_DURATION_GRACE_SECONDS = 15;

export type CallTimeline = {
  mediaStartedAt?: string | null;
  connectedAt?: string | null;
  mediaEndedAt?: string | null;
};

export const CallTimelineSchema = z
  .object({
    mediaStartedAt: z.string().datetime({ offset: true }).nullish(),
    connectedAt: z.string().datetime({ offset: true }).nullish(),
    mediaEndedAt: z.string().datetime({ offset: true }).nullish(),
  })
  .strict();

function readTimeline(metadata: Record<string, unknown> | null | undefined): CallTimeline {
  const raw = (metadata ?? {}) as Record<string, unknown>;
  return {
    mediaStartedAt: typeof raw.media_started_at === "string" ? raw.media_started_at : null,
    connectedAt: typeof raw.connected_at === "string" ? raw.connected_at : null,
    mediaEndedAt: typeof raw.media_ended_at === "string" ? raw.media_ended_at : null,
  };
}

/** Observed seconds between the first trusted lifecycle timestamp and now/end. */
export function observedSeconds(call: { startedAt: Date | null; metadata: Record<string, unknown> }, endedAt: Date): number | null {
  const timeline = readTimeline(call.metadata);
  const start = timeline.connectedAt ?? timeline.mediaStartedAt ?? call.startedAt?.toISOString() ?? null;
  if (!start) return null;
  const startMs = Date.parse(start);
  if (!Number.isFinite(startMs)) return null;
  return Math.max(0, Math.round((endedAt.getTime() - startMs) / 1000));
}

export type BillableDuration = {
  seconds: number;
  providerSeconds: number | null;
  observedSeconds: number | null;
  varianceSeconds: number;
  source: "provider" | "observed" | "provider_over_observed_grace" | "unknown";
};

/**
 * Resolve the billable duration for a completed call.
 * Never invents a duration: with neither a provider report nor an observed
 * lifecycle the result is `0` and `source: "unknown"` (the caller decides
 * whether that is acceptable — the webhook requires a provider duration).
 */
/**
 * How the signed provider duration and the app-observed timeline are combined:
 *  - `provider` (default): the telephony provider is the system of record for
 *    airtime, so its signed duration is billable. A duration that exceeds the
 *    observed timeline by more than {@link OBSERVED_DURATION_GRACE_SECONDS} is
 *    flagged as a variance and audited (never silently ignored, never silently
 *    billed twice).
 *  - `observed`: the app never bills more airtime than it carried audio for
 *    (observed timeline + grace). Use when a gateway is known to over-report.
 * Both modes record provider, observed and variance values.
 */
export type DurationTrustMode = "provider" | "observed";

export function durationTrustMode(): DurationTrustMode {
  return process.env.VOICE_DURATION_TRUST_MODE === "observed" ? "observed" : "provider";
}

export function resolveBillableDuration(
  input: { providerSeconds: number | null; observed: number | null },
  mode: DurationTrustMode = durationTrustMode(),
): BillableDuration {
  const provider = input.providerSeconds === null ? null : Math.max(0, Math.round(input.providerSeconds));
  const observed = input.observed === null ? null : Math.max(0, Math.round(input.observed));
  if (provider !== null && observed !== null) {
    const ceiling = observed + OBSERVED_DURATION_GRACE_SECONDS;
    if (provider > ceiling) {
      const variance = provider - observed;
      // The provider's signed report is authoritative by default; the observed
      // timeline bounds what the app actually carried. `observed` mode caps the
      // bill, `provider` mode bills the report and flags the variance.
      const seconds = mode === "observed" ? observed : provider;
      return {
        seconds,
        providerSeconds: provider,
        observedSeconds: observed,
        varianceSeconds: variance,
        source: mode === "observed" ? "observed" : "provider_over_observed_grace",
      };
    }
    return { seconds: provider, providerSeconds: provider, observedSeconds: observed, varianceSeconds: Math.abs(observed - provider), source: "provider" };
  }
  if (provider !== null) return { seconds: provider, providerSeconds: provider, observedSeconds: null, varianceSeconds: 0, source: "provider" };
  if (observed !== null) return { seconds: observed, providerSeconds: null, observedSeconds: observed, varianceSeconds: 0, source: "observed" };
  return { seconds: 0, providerSeconds: null, observedSeconds: null, varianceSeconds: 0, source: "unknown" };
}

/**
 * Reserve airtime + speech-to-text capacity for a call in the SAME transaction
 * as the call row, keyed to the call id (so a retried admission cannot
 * double-reserve).
 */
export async function reserveCallQuota(tx: QuotaTx, businessId: string, callId: string) {
  return reserveUsageInTransaction(tx, businessId, `voice-call:${callId}`, {
    voice_minutes: maxCallMinutes(),
    stt_minutes: maxCallMinutes() * maxSttMinutes(),
  });
}

export type SettleCallInput = {
  businessId: string;
  callId: string;
  /** Provider-reported duration from the signed call-ended webhook. */
  providerSeconds: number;
  endedAt?: Date;
  requestId?: string;
  sttSecondsReported?: number | null;
};

/**
 * Settle a finished call:
 *  - `voice_minutes` settles to the trusted duration (never above the
 *    reservation — overruns are recorded and surfaced),
 *  - `stt_minutes` settles to provider-reported transcription seconds,
 *  - `usage_records` rows are written once (idempotent key),
 *  - the trusted timestamp and variance are persisted on the call row.
 *
 * Idempotent: a duplicated `call-ended` delivery finds the reservation already
 * settled and returns without adding usage.
 */
export async function settleCallUsage(input: SettleCallInput) {
  assertTenantScope(input.businessId);
  z.string().uuid().parse(input.callId);
  const endedAt = input.endedAt ?? new Date();
  const [call] = await db
    .select()
    .from(calls)
    .where(and(eq(calls.id, input.callId), eq(calls.businessId, input.businessId)))
    .limit(1);
  if (!call) throw new AppError(404, "CALL_NOT_FOUND", "Call not found");

  const observed = observedSeconds({ startedAt: call.startedAt, metadata: call.metadata }, endedAt);
  const billable = resolveBillableDuration({ providerSeconds: input.providerSeconds, observed });
  const sttSeconds = input.sttSecondsReported ?? (typeof call.metadata.stt_seconds === "number" ? Number(call.metadata.stt_seconds) : 0);

  const [reservation] = await db
    .select({ id: sql<string>`id` })
    .from(sql`quota_reservations`)
    .where(sql`business_id = ${input.businessId} AND idempotency_key = ${`voice-call:${input.callId}`}`)
    .limit(1);

  let settled: { overrun: boolean } = { overrun: false };
  if (reservation?.id) {
    settled = await settleUsage(input.businessId, reservation.id, {
      voice_minutes: billable.seconds / 60,
      stt_minutes: Math.min(sttSeconds, maxCallMinutes() * maxSttMinutes() * 60) / 60,
    });
  } else {
    logWarn("Call usage settled without a reservation; recording consumption for reconciliation", {
      businessId: input.businessId,
      callId: input.callId,
      operation: "voice.settle",
      status: "missing_reservation",
    });
  }

  const usageKey = `call-ended:${input.callId}`;
  await db.transaction(async (tx) => {
    await tx
      .insert(usageRecords)
      .values([
        {
          businessId: input.businessId,
          type: "voice_minutes",
          quantity: (billable.seconds / 60).toFixed(4),
          unit: "minute",
          provider: "voice",
          idempotencyKey: usageKey,
          metadata: {
            callId: input.callId,
            externalCallId: call.externalCallId,
            providerSeconds: billable.providerSeconds,
            observedSeconds: billable.observedSeconds,
            varianceSeconds: billable.varianceSeconds,
            durationSource: billable.source,
          },
        },
        {
          businessId: input.businessId,
          type: "stt_minutes",
          quantity: (Math.max(0, sttSeconds) / 60).toFixed(4),
          unit: "minute",
          provider: "stt",
          idempotencyKey: `${usageKey}:stt`,
          metadata: { callId: input.callId, sttSeconds },
        },
      ])
      .onConflictDoNothing({ target: [usageRecords.businessId, usageRecords.idempotencyKey] });

    await tx
      .update(calls)
      .set({
        durationSeconds: billable.seconds,
        metadata: {
          ...call.metadata,
          media_ended_at: endedAt.toISOString(),
          billable_seconds: billable.seconds,
          duration_source: billable.source,
          duration_variance_seconds: billable.varianceSeconds,
          stt_seconds: Math.max(0, sttSeconds),
          usage_settled_at: new Date().toISOString(),
        },
      })
      .where(and(eq(calls.id, input.callId), eq(calls.businessId, input.businessId)));

    if (settled.overrun || billable.source === "provider_over_observed_grace") {
      await tx.insert(auditLogs).values({
        businessId: input.businessId,
        actorType: "system",
        action: "quota.voice_duration_variance",
        entityType: "call",
        entityId: input.callId,
        requestId: input.requestId,
        metadata: {
          providerSeconds: billable.providerSeconds,
          observedSeconds: billable.observedSeconds,
          varianceSeconds: billable.varianceSeconds,
          durationSource: billable.source,
          overrun: settled.overrun,
        },
      });
    }
  });

  return { ...billable, callId: input.callId, sttSeconds: Math.max(0, sttSeconds), overrun: settled.overrun };
}

/**
 * Accumulate provider-reported STT seconds for a call (media pipeline).
 * Uses a row lock so concurrent utterances cannot lose an increment.
 */
export async function addSttSeconds(businessId: string, callId: string, seconds: number): Promise<void> {
  assertTenantScope(businessId);
  if (!Number.isFinite(seconds) || seconds <= 0) return;
  await db.transaction(async (tx) => {
    const [call] = await tx.select({ metadata: calls.metadata }).from(calls)
      .where(and(eq(calls.id, callId), eq(calls.businessId, businessId))).for("update");
    if (!call) return;
    const current = typeof call.metadata.stt_seconds === "number" ? Number(call.metadata.stt_seconds) : 0;
    await tx.update(calls).set({ metadata: { ...call.metadata, stt_seconds: current + seconds } })
      .where(and(eq(calls.id, callId), eq(calls.businessId, businessId)));
  });
}

/** Stamp a trusted lifecycle instant (media start/connect) on the call row. */
export async function recordCallLifecycle(businessId: string, callId: string, event: "media_started" | "connected" | "media_ended", at = new Date()): Promise<void> {
  assertTenantScope(businessId);
  await db.transaction(async (tx) => {
    const [call] = await tx.select({ metadata: calls.metadata }).from(calls)
      .where(and(eq(calls.id, callId), eq(calls.businessId, businessId))).for("update");
    if (!call) throw new AppError(404, "CALL_NOT_FOUND", "Call not found");
    const key = `media_${event}_at`;
    const existing = call.metadata[key];
    // First timestamp wins: replays cannot extend a billable window.
    if (typeof existing === "string") return;
    await tx.update(calls).set({ metadata: { ...call.metadata, [key]: at.toISOString() } })
      .where(and(eq(calls.id, callId), eq(calls.businessId, businessId)));
  });
}

/** Voice-specific environment sanity used by readiness and docs. */
export function voiceQuotaConfig() {
  const env = getEnv();
  return { maxCallMinutes: maxCallMinutes(), sttReserveMinutes: maxSttMinutes(), mediaCodec: env.VOICE_MEDIA_CODEC, sampleRate: env.VOICE_MEDIA_SAMPLE_RATE };
}
