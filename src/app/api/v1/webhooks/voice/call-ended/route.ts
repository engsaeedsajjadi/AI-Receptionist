import { createHmac } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { NextRequest } from "next/server";
import { db } from "@/db";
import { calls, usageRecords } from "@/db/schema";
import { ApiError, ok } from "@/lib/api";
import { env } from "@/lib/env";
import { isWebhookReplay, withApiHandling } from "@/lib/server-core";

export async function POST(req: NextRequest) {
  return withApiHandling(async () => {
    const raw = await req.text();
    const signature = req.headers.get("x-webhook-signature");
    const idempotencyKey = req.headers.get("x-idempotency-key");

    if (!signature || !idempotencyKey) throw new ApiError(401, "UNAUTHORIZED", "Missing webhook headers");
    if (isWebhookReplay(idempotencyKey)) return ok({ ok: true, duplicate: true });

    const expected = createHmac("sha256", env.webhookSecret).update(raw).digest("hex");
    if (signature !== expected) throw new ApiError(401, "UNAUTHORIZED", "Invalid webhook signature");

    const body = JSON.parse(raw) as Record<string, unknown>;
    const businessId = String(body.business_id ?? "");
    const externalCallId = String(body.external_call_id ?? "");
    const duration = Number(body.duration_seconds ?? 0);

    const [call] = await db
      .select()
      .from(calls)
      .where(and(eq(calls.businessId, businessId), eq(calls.externalCallId, externalCallId)))
      .orderBy(desc(calls.createdAt))
      .limit(1);

    if (!call) throw new ApiError(404, "CALL_NOT_FOUND", "Call not found");

    await db
      .update(calls)
      .set({
        status: "COMPLETED",
        endedAt: new Date(),
        durationSeconds: duration,
        summary: typeof body.summary === "string" ? body.summary : "خلاصه تماس ثبت شد",
        recordingUrl: String(body.recording_url ?? "") || null,
      })
      .where(eq(calls.id, call.id));

    await db.insert(usageRecords).values({
      businessId,
      type: "voice_minutes",
      quantity: (duration / 60).toFixed(2),
      unit: "minute",
      metadata: { callId: call.id },
    });

    return ok({ ok: true });
  });
}
