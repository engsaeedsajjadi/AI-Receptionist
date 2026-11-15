import { NextRequest } from "next/server";
import { z } from "zod";
import { and, desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { callMessages, calls } from "@/db/schema";
import { ok, parseWith } from "@/lib/api";
import { AppError } from "@/lib/errors";
import { env } from "@/lib/env";
import { enforceRateLimit } from "@/lib/rate-limit";
import { claimWebhookIdempotency, verifyWebhookRequest } from "@/lib/security";
import { withApiHandling } from "@/lib/server-core";
import { advisoryXactLock } from "@/lib/tx";

const payloadSchema = z.object({
  business_id: z.string().uuid(),
  external_call_id: z.string().min(1).max(255),
  transcript: z.string().min(1).max(20000),
  role: z.enum(["CUSTOMER", "AGENT"]).default("CUSTOMER"),
  is_final: z.boolean().default(true),
  // Provider segment identity. Retries/redeliveries MUST reuse the same
  // event_id so duplicates collapse instead of appending twice.
  event_id: z.string().min(1).max(255).optional(),
  seq: z.number().int().min(0).max(1_000_000).optional(),
});

export async function POST(req: NextRequest) {
  return withApiHandling(async () => {
    await enforceRateLimit(req, "publicWebhook");
    const { payload, idempotencyKey } = await verifyWebhookRequest(req, {
      secret: env.webhookSecret,
      previousSecrets: env.previousWebhookSecrets,
      scope: "voice:transcript",
    });
    const body = parseWith(payloadSchema, payload);
    if (!(await claimWebhookIdempotency("voice:transcript", idempotencyKey))) {
      return ok({ ok: true, duplicate: true });
    }

    const [call] = await db
      .select()
      .from(calls)
      .where(and(eq(calls.businessId, body.business_id), eq(calls.externalCallId, body.external_call_id)))
      .orderBy(desc(calls.createdAt))
      .limit(1);

    if (!call) throw new AppError(404, "CALL_NOT_FOUND", "Call not found");

    // Serialize writers per call: concurrent same-segment deliveries collapse
    // deterministically instead of duplicating the transcript cache.
    const outcome = await db.transaction(async (tx) => {
      await advisoryXactLock(tx, `transcript:${call.id}`);

      let existing: { id: string; metadata: Record<string, unknown> } | null = null;
      if (body.event_id) {
        const [row] = await tx
          .select({ id: callMessages.id, metadata: callMessages.metadata })
          .from(callMessages)
          .where(and(eq(callMessages.callId, call.id), eq(callMessages.eventId, body.event_id)))
          .limit(1);
        existing = row ?? null;
      }

      const wasFinal = existing?.metadata?.isFinal === true;
      // Final redelivery of an already-final segment: pure no-op.
      if (existing && wasFinal && body.is_final) {
        return { duplicate: true, messageId: existing.id };
      }

      const content = body.transcript.slice(0, 20000);
      const metadata = { isFinal: body.is_final, eventId: body.event_id ?? null };
      let messageId: string;
      if (existing) {
        // Partial → final progression (or partial refresh): update in place.
        await tx
          .update(callMessages)
          .set({ content, seq: body.seq ?? null, timestamp: new Date(), metadata })
          .where(eq(callMessages.id, existing.id));
        messageId = existing.id;
      } else if (body.event_id) {
        const [row] = await tx
          .insert(callMessages)
          .values({ businessId: body.business_id, callId: call.id, role: body.role, content, eventId: body.event_id, seq: body.seq ?? null, metadata })
          .onConflictDoNothing({ target: [callMessages.callId, callMessages.eventId] })
          .returning({ id: callMessages.id });
        if (!row) {
          // Lost a race inside the lock window — re-read the winner.
          const [winner] = await tx
            .select({ id: callMessages.id })
            .from(callMessages)
            .where(and(eq(callMessages.callId, call.id), eq(callMessages.eventId, body.event_id)))
            .limit(1);
          if (!winner) throw new AppError(500, "INTERNAL_ERROR", "Transcript write failed");
          return { duplicate: true, messageId: winner.id };
        }
        messageId = row.id;
      } else {
        // Legacy path (no provider event id): header-key dedup only.
        const [row] = await tx
          .insert(callMessages)
          .values({ businessId: body.business_id, callId: call.id, role: body.role, content, metadata })
          .returning({ id: callMessages.id });
        messageId = row.id;
      }

      // The calls.transcript cache only grows on NEW final segments or a
      // partial → final transition — never on redeliveries.
      const becameFinal = body.is_final && (!existing || !wasFinal);
      if (becameFinal) {
        await tx
          .update(calls)
          .set({ transcript: `${call.transcript ?? ""}\n${content}`.trim().slice(0, 100_000) })
          .where(eq(calls.id, call.id));
      }
      return { duplicate: false, messageId };
    });

    return ok({ ok: true, ...outcome });
  });
}
