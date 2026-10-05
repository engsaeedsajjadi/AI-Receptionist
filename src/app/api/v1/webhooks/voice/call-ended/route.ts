import { NextRequest } from "next/server";
import { z } from "zod";
import { and, desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { calls } from "@/db/schema";
import { ok, parseWith } from "@/lib/api";
import { AppError } from "@/lib/errors";
import { env } from "@/lib/env";
import { logInfo } from "@/lib/logger";
import { enforceRateLimit } from "@/lib/rate-limit";
import { claimWebhookIdempotency, verifyWebhookRequest } from "@/lib/security";
import { completeCall, generateCallSummary } from "@/lib/services/calls";
import { settleCallUsage } from "@/lib/services/voice-usage";
import { withApiHandling } from "@/lib/server-core";

/**
 * Trusted call-ended lifecycle event.
 *
 * Usage is settled from this signed provider report plus the lifecycle the app
 * observed itself (never from a client-supplied billable duration). The
 * webhook is HMAC-signed, timestamp-bounded and idempotency-claimed, so a
 * duplicated delivery cannot duplicate usage or extend a subscription window.
 */
const payloadSchema = z.object({
  business_id: z.string().uuid(),
  external_call_id: z.string().min(1).max(255),
  duration_seconds: z.coerce.number().min(0).max(24 * 3600).default(0),
  billable_seconds: z.coerce.number().min(0).max(24 * 3600).optional(),
  stt_seconds: z.coerce.number().min(0).max(24 * 3600).optional(),
  answered_at: z.string().datetime({ offset: true }).optional(),
  ended_at: z.string().datetime({ offset: true }).optional(),
  summary: z.string().max(8000).optional(),
  recording_url: z.string().url().max(2048).optional(),
  status: z.enum(["COMPLETED", "MISSED", "FAILED", "TRANSFERRED"]).default("COMPLETED"),
});

export async function POST(req: NextRequest) {
  return withApiHandling(async (rid) => {
    await enforceRateLimit(req, "publicWebhook");
    const { payload, idempotencyKey } = await verifyWebhookRequest(req, {
      secret: env.webhookSecret,
      previousSecrets: env.previousWebhookSecrets,
      scope: "voice:call-ended",
    });
    const body = parseWith(payloadSchema, payload);
    if (!(await claimWebhookIdempotency("voice:call-ended", idempotencyKey))) {
      return ok({ ok: true, duplicate: true });
    }

    const [call] = await db
      .select()
      .from(calls)
      .where(and(eq(calls.businessId, body.business_id), eq(calls.externalCallId, body.external_call_id)))
      .orderBy(desc(calls.createdAt))
      .limit(1);

    if (!call) throw new AppError(404, "CALL_NOT_FOUND", "Call not found");

    const endedAt = body.ended_at ? new Date(body.ended_at) : new Date();
    if (body.recording_url && call.recordingUrl !== body.recording_url) {
      await db
        .update(calls)
        .set({ recordingUrl: body.recording_url })
        .where(and(eq(calls.id, call.id), eq(calls.businessId, body.business_id)));
    }

    // Trusted duration settlement (voice_minutes + stt_minutes meters).
    const usage = await settleCallUsage({
      businessId: body.business_id,
      callId: call.id,
      providerSeconds: body.billable_seconds ?? body.duration_seconds,
      sttSecondsReported: body.stt_seconds ?? null,
      endedAt,
      requestId: rid,
    });

    // Shared completion path: transcript kept as-is, summary only from the
    // provider payload or the LLM — never a fabricated placeholder.
    const completed = await completeCall(body.business_id, call.id, {
      summary: body.summary,
      requestId: rid,
    });
    if (!completed.summary) {
      await generateCallSummary(body.business_id, call.id, { requestId: rid });
    }

    logInfo("Call ended", {
      requestId: rid,
      businessId: body.business_id,
      callId: call.id,
      operation: "voice.call-ended",
      status: completed.status,
      durationSource: usage.source,
      billableSeconds: usage.seconds,
    });

    return ok({
      ok: true,
      billable_seconds: usage.seconds,
      duration_source: usage.source,
      overrun: usage.overrun,
    });
  });
}
