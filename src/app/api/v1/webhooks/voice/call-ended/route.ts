import { NextRequest } from "next/server";
import { z } from "zod";
import { and, desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { calls, usageRecords } from "@/db/schema";
import { ok, parseWith } from "@/lib/api";
import { AppError } from "@/lib/errors";
import { env } from "@/lib/env";
import { logInfo } from "@/lib/logger";
import { enforceRateLimit } from "@/lib/rate-limit";
import { verifyWebhookRequest } from "@/lib/security";
import { completeCall, generateCallSummary } from "@/lib/services/calls";
import { withApiHandling } from "@/lib/server-core";

const payloadSchema = z.object({
  business_id: z.string().uuid(),
  external_call_id: z.string().min(1).max(255),
  duration_seconds: z.coerce.number().min(0).max(24 * 3600).default(0),
  summary: z.string().max(8000).optional(),
  recording_url: z.string().url().max(2048).optional(),
  status: z.enum(["COMPLETED", "MISSED", "FAILED", "TRANSFERRED"]).default("COMPLETED"),
});

export async function POST(req: NextRequest) {
  return withApiHandling(async (rid) => {
    await enforceRateLimit(req, "publicWebhook");
    const { payload, duplicate } = await verifyWebhookRequest(req, {
      secret: env.webhookSecret,
      scope: "voice:call-ended",
    });
    if (duplicate) return ok({ ok: true, duplicate: true });

    const body = parseWith(payloadSchema, payload);

    const [call] = await db
      .select()
      .from(calls)
      .where(and(eq(calls.businessId, body.business_id), eq(calls.externalCallId, body.external_call_id)))
      .orderBy(desc(calls.createdAt))
      .limit(1);

    if (!call) throw new AppError(404, "CALL_NOT_FOUND", "Call not found");

    await db.transaction(async (tx) => {
      await tx
        .update(calls)
        .set({
          durationSeconds: Math.round(body.duration_seconds),
          recordingUrl: body.recording_url ?? call.recordingUrl,
        })
        .where(eq(calls.id, call.id));

      await tx
        .insert(usageRecords)
        .values({
          businessId: body.business_id,
          type: "voice_minutes",
          quantity: (body.duration_seconds / 60).toFixed(2),
          unit: "minute",
          provider: "voice",
          idempotencyKey: `call-ended:${call.id}`,
          metadata: { callId: call.id, externalCallId: body.external_call_id },
        })
        .onConflictDoNothing({ target: [usageRecords.businessId, usageRecords.idempotencyKey] });
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
    });

    return ok({ ok: true });
  });
}
