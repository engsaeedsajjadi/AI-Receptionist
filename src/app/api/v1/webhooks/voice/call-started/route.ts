import { createHmac } from "node:crypto";
import { NextRequest } from "next/server";
import { db } from "@/db";
import { calls, usageRecords } from "@/db/schema";
import { ApiError, ok } from "@/lib/api";
import { env } from "@/lib/env";
import { normalizePersianText } from "@/lib/normalization";
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
    if (!businessId || !externalCallId) throw new ApiError(400, "INVALID_PAYLOAD", "business_id and external_call_id required");

    await db.insert(calls).values({
      businessId,
      externalCallId,
      phoneNumber: normalizePersianText(String(body.phone_number ?? "")),
      direction: "INBOUND",
      status: "ANSWERED",
      startedAt: new Date(),
      metadata: body,
    });

    await db.insert(usageRecords).values({
      businessId,
      type: "voice_minutes",
      quantity: "0",
      unit: "minute",
      metadata: { event: "call_started" },
    });

    return ok({ ok: true });
  });
}
