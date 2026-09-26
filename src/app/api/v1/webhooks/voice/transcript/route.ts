import { NextRequest } from "next/server";
import { z } from "zod";
import { and, desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { callMessages, calls } from "@/db/schema";
import { ok, parseWith } from "@/lib/api";
import { AppError } from "@/lib/errors";
import { env } from "@/lib/env";
import { enforceRateLimit } from "@/lib/rate-limit";
import { verifyWebhookRequest } from "@/lib/security";
import { withApiHandling } from "@/lib/server-core";

const payloadSchema = z.object({
  business_id: z.string().uuid(),
  external_call_id: z.string().min(1).max(255),
  transcript: z.string().min(1).max(20000),
  role: z.enum(["CUSTOMER", "AGENT"]).default("CUSTOMER"),
  is_final: z.boolean().default(true),
});

export async function POST(req: NextRequest) {
  return withApiHandling(async () => {
    await enforceRateLimit(req, "publicWebhook");
    const { payload, duplicate } = await verifyWebhookRequest(req, {
      secret: env.webhookSecret,
      scope: "voice:transcript",
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
      await tx.insert(callMessages).values({
        callId: call.id,
        role: body.role,
        content: body.transcript,
        metadata: { isFinal: body.is_final },
      });
      if (body.is_final) {
        await tx
          .update(calls)
          .set({ transcript: `${call.transcript ?? ""}\n${body.transcript}`.trim().slice(0, 100_000) })
          .where(eq(calls.id, call.id));
      }
    });

    return ok({ ok: true });
  });
}
