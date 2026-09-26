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
import { claimWebhookIdempotency, verifyWebhookRequest } from "@/lib/security";
import { withApiHandling } from "@/lib/server-core";
import { deriveToolExecId, executeIdempotentToolCall, executeToolCall } from "@/lib/tools/registry";

const payloadSchema = z.object({
  business_id: z.string().uuid(),
  external_call_id: z.string().min(1).max(255),
  tool: z.string().min(1).max(100),
  arguments: z.record(z.string(), z.unknown()).default({}),
  // Provider execution identity. Retries MUST reuse the same event_id so a
  // redelivery returns the STORED outcome instead of re-executing the tool.
  // The execution id is derived from event_id + tool + canonical args (same
  // scheme as the agent runtime): a provider that reuses one event_id for
  // different tools/args must NOT cause cross-tool outcome replay.
  event_id: z.string().min(1).max(255).optional(),
});

function toResponse(result: { status: string; data?: unknown; error?: string }, duplicate: boolean) {
  return ok({
    ok: result.status === "SUCCESS",
    duplicate,
    status: result.status,
    result: result.data,
    error: result.error,
  });
}

export async function POST(req: NextRequest) {
  return withApiHandling(async (rid) => {
    await enforceRateLimit(req, "publicWebhook");
    const { payload, idempotencyKey } = await verifyWebhookRequest(req, {
      secret: env.webhookSecret,
      scope: "voice:tool-call",
    });
    const body = parseWith(payloadSchema, payload);
    if (!(await claimWebhookIdempotency("voice:tool-call", idempotencyKey))) {
      return ok({ ok: true, duplicate: true });
    }

    const [call] = await db
      .select()
      .from(calls)
      .where(and(eq(calls.businessId, body.business_id), eq(calls.externalCallId, body.external_call_id)))
      .orderBy(desc(calls.createdAt))
      .limit(1);

    if (!call) throw new AppError(404, "CALL_NOT_FOUND", "Call not found");

    // Event-scoped execution: same (event_id, tool, args) → stored outcome,
    // never a rerun. The derived id shares one namespace with the agent
    // runtime loop (P0-3) via executeIdempotentToolCall, so the same
    // operation delivered via both paths still collapses — while a reused
    // provider event_id can never replay across different tools/args.
    if (body.event_id) {
      const outcome = await executeIdempotentToolCall({
        businessId: body.business_id,
        callId: call.id,
        toolExecId: deriveToolExecId(body.event_id, body.tool, body.arguments),
        tool: body.tool,
        args: body.arguments,
        requestId: rid,
        actor: "voice-webhook",
      });

      logInfo("Voice tool call executed", {
        requestId: rid,
        businessId: body.business_id,
        callId: call.id,
        operation: `tool.${body.tool}`,
        status: outcome.result.status,
      });
      return toResponse(outcome.result, outcome.duplicate);
    }

    // Legacy path (no provider event id): header-key dedup only.
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
    return toResponse(result, false);
  });
}
