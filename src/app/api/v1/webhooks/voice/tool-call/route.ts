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
import { advisoryXactLock } from "@/lib/tx";
import { executeToolCall, type ToolResult } from "@/lib/tools/registry";

const payloadSchema = z.object({
  business_id: z.string().uuid(),
  external_call_id: z.string().min(1).max(255),
  tool: z.string().min(1).max(100),
  arguments: z.record(z.string(), z.unknown()).default({}),
  // Provider execution identity. Retries MUST reuse the same event_id so a
  // redelivery returns the STORED outcome instead of re-executing the tool.
  event_id: z.string().min(1).max(255).optional(),
});

type StoredOutcome = { status: string; data?: unknown; error?: string | null };

function toResponse(result: ToolResult, duplicate: boolean) {
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
      previousSecrets: env.previousWebhookSecrets,
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

    // Event-scoped execution: same event_id → stored outcome, never a rerun.
    // The advisory lock serializes concurrent duplicates so only one writer
    // executes; the loser reads the stored outcome.
    if (body.event_id) {
      const eventId = body.event_id;
      const outcome = await db.transaction(async (tx) => {
        await advisoryXactLock(tx, `tool-exec:${call.id}:${eventId}`);
        const [existing] = await tx
          .select({ metadata: callMessages.metadata })
          .from(callMessages)
          .where(and(eq(callMessages.callId, call.id), eq(callMessages.eventId, eventId)))
          .limit(1);
        if (existing) {
          const stored = (existing.metadata as Record<string, unknown>)?.outcome as StoredOutcome | undefined;
          if (stored && typeof stored.status === "string") {
            return {
              result: {
                status: stored.status,
                data: stored.data,
                error: stored.error ?? undefined,
              } as ToolResult,
              duplicate: true,
            };
          }
          // Row exists but holds no outcome (shouldn't happen) — treat as duplicate, no rerun.
          return {
            result: { status: "FAILED", error: "Tool execution already recorded" } as ToolResult,
            duplicate: true,
          };
        }

        const result = await executeToolCall({
          businessId: body.business_id,
          callId: call.id,
          tool: body.tool,
          args: body.arguments,
          requestId: rid,
          actor: "voice-webhook",
        });

        await tx
          .insert(callMessages)
          .values({
            businessId: body.business_id,
            callId: call.id,
            role: "TOOL",
            content: JSON.stringify({ tool: body.tool, status: result.status }),
            eventId,
            metadata: {
              tool: body.tool,
              status: result.status,
              requestId: rid,
              outcome: { status: result.status, data: result.data ?? null, error: result.error ?? null } satisfies StoredOutcome,
            },
          })
          .onConflictDoNothing({ target: [callMessages.callId, callMessages.eventId] });

        return { result, duplicate: false };
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
      businessId: body.business_id,
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
