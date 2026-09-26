import { NextRequest } from "next/server";
import { z } from "zod";
import { and, desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { callMessages, calls } from "@/db/schema";
import { ok, parseWith } from "@/lib/api";
import { AppError } from "@/lib/errors";
import { env } from "@/lib/env";
import { logInfo } from "@/lib/logger";
import { enforceRateLimit } from "@/lib/rate-limit";
import { verifyWebhookRequest } from "@/lib/security";
import { withApiHandling } from "@/lib/server-core";
import { executeToolCall } from "@/lib/tools/registry";

const payloadSchema = z.object({
  business_id: z.string().uuid(),
  external_call_id: z.string().min(1).max(255),
  tool: z.string().min(1).max(100),
  arguments: z.record(z.string(), z.unknown()).default({}),
});

export async function POST(req: NextRequest) {
  return withApiHandling(async (rid) => {
    await enforceRateLimit(req, "publicWebhook");
    const { payload, duplicate } = await verifyWebhookRequest(req, {
      secret: env.webhookSecret,
      scope: "voice:tool-call",
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

    const result = await executeToolCall({
      businessId: body.business_id,
      callId: call.id,
      tool: body.tool,
      args: body.arguments,
      requestId: rid,
      actor: "voice-webhook",
    });

    await db.insert(callMessages).values({
      callId: call.id,
      role: "TOOL",
      content: JSON.stringify({ tool: body.tool, status: result.status }),
      metadata: { tool: body.tool, status: result.status, requestId: rid },
    });

    logInfo("Voice tool call executed", {
      requestId: rid,
      businessId: body.business_id,
      callId: call.id,
      operation: `tool.${body.tool}`,
      status: result.status,
    });

    return ok({ ok: result.status === "SUCCESS", status: result.status, result: result.data, error: result.error });
  });
}
