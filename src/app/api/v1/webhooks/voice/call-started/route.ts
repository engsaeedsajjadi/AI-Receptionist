import { NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/db";
import { businesses, calls, usageRecords } from "@/db/schema";
import { ok, parseWith } from "@/lib/api";
import { AppError } from "@/lib/errors";
import { env } from "@/lib/env";
import { logInfo } from "@/lib/logger";
import { normalizePersianText, normalizePhone } from "@/lib/normalization";
import { enforceRateLimit } from "@/lib/rate-limit";
import { verifyWebhookRequest } from "@/lib/security";
import { withApiHandling } from "@/lib/server-core";
import { eq } from "drizzle-orm";

const payloadSchema = z.object({
  business_id: z.string().uuid(),
  external_call_id: z.string().min(1).max(255),
  phone_number: z.string().min(1).max(30),
  agent_id: z.string().uuid().optional(),
  direction: z.enum(["INBOUND", "OUTBOUND"]).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export async function POST(req: NextRequest) {
  return withApiHandling(async (rid) => {
    await enforceRateLimit(req, "publicWebhook");
    const { payload, duplicate, idempotencyKey } = await verifyWebhookRequest(req, {
      secret: env.webhookSecret,
      scope: "voice:call-started",
    });
    if (duplicate) return ok({ ok: true, duplicate: true });

    const body = parseWith(payloadSchema, payload);

    const [business] = await db.select({ id: businesses.id }).from(businesses).where(eq(businesses.id, body.business_id)).limit(1);
    if (!business) throw new AppError(404, "BUSINESS_NOT_FOUND", "Business not found");

    const phoneNumber = normalizePhone(body.phone_number) ?? normalizePersianText(body.phone_number);

    await db.transaction(async (tx) => {
      await tx.insert(calls).values({
        businessId: body.business_id,
        externalCallId: body.external_call_id,
        phoneNumber,
        agentId: body.agent_id ?? null,
        direction: body.direction ?? "INBOUND",
        status: "RINGING",
        startedAt: new Date(),
        metadata: { ...(body.metadata ?? {}), idempotencyKey },
      });
      await tx.insert(usageRecords).values({
        businessId: body.business_id,
        type: "calls",
        quantity: "1",
        unit: "count",
        metadata: { event: "call_started", externalCallId: body.external_call_id },
      });
    });

    logInfo("Inbound call started", {
      requestId: rid,
      businessId: body.business_id,
      operation: "voice.call-started",
      status: "ok",
    });

    return ok({ ok: true });
  });
}
