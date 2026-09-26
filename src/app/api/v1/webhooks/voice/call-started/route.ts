import { NextRequest } from "next/server";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { businesses, calls, usageRecords } from "@/db/schema";
import { ok, parseWith } from "@/lib/api";
import { AppError, tooManyRequests } from "@/lib/errors";
import { env } from "@/lib/env";
import { logInfo } from "@/lib/logger";
import { resolveBusinessByCalledNumber } from "@/lib/services/phone-routing";
import { normalizePersianText, normalizePhone } from "@/lib/normalization";
import { enforceRateLimit } from "@/lib/rate-limit";
import { verifyWebhookRequest } from "@/lib/security";
import { withApiHandling } from "@/lib/server-core";
import { bootstrapMedia, parseBootstrapState } from "@/lib/voice/media-bootstrap";
import {
  canonicalPayloadHash,
  claimWebhookInbox,
  completeWebhookInbox,
  failWebhookInbox,
} from "@/lib/webhook-inbox";

const payloadSchema = z
  .object({
    business_id: z.string().uuid().optional(),
    called_number: z.string().min(1).max(30).optional(),
    external_call_id: z.string().min(1).max(255),
  phone_number: z.string().min(1).max(30),
  agent_id: z.string().uuid().optional(),
  direction: z.enum(["INBOUND", "OUTBOUND"]).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .refine((b) => b.business_id ?? b.called_number, {
    message: "Either business_id or called_number is required",
  });

export async function POST(req: NextRequest) {
  return withApiHandling(async (rid) => {
    await enforceRateLimit(req, "publicWebhook");
    // 1. Authenticate → 2. validate → 3. resolve tenant → 4. claim inbox.
    // Invalid payloads and unroutable tenants must never burn a key.
    const { payload, idempotencyKey } = await verifyWebhookRequest(req, {
      secret: env.webhookSecret,
      scope: "voice:call-started",
    });
    const body = parseWith(payloadSchema, payload);

    // Tenant resolution: the HMAC authenticates the gateway, not the tenant.
    // Prefer deterministic called-number routing; a business_id asserted by
    // the gateway is accepted only when it agrees with the route.
    let businessId: string | null = body.business_id ?? null;
    let routing: Record<string, unknown> = { method: "business_id" };
    if (body.called_number) {
      const route = await resolveBusinessByCalledNumber(body.called_number);
      if (!route.ok) {
        if (route.reason === "AMBIGUOUS_NUMBER") {
          throw new AppError(
            409,
            "CONFLICT",
            "Called number matches multiple businesses; refusing to guess the tenant",
          );
        }
        throw new AppError(404, "BUSINESS_NOT_FOUND", "No business is configured for the called number");
      }
      if (businessId && businessId !== route.businessId) {
        throw new AppError(400, "INVALID_PAYLOAD", "business_id does not match the business routed by called_number");
      }
      businessId = route.businessId;
      routing = { method: "called_number", via: route.via, matchedNumber: route.matchedNumber };
    }
    if (!businessId) throw new AppError(400, "INVALID_PAYLOAD", "Either business_id or called_number is required");

    const [business] = await db
      .select({ id: businesses.id, settings: businesses.settings })
      .from(businesses)
      .where(eq(businesses.id, businessId))
      .limit(1);
    if (!business) throw new AppError(404, "BUSINESS_NOT_FOUND", "Business not found");

    // Durable inbox claim (PG, §1). The hash covers the VALIDATED body so
    // retries that spell defaults differently still collapse.
    const inbox = await claimWebhookInbox({
      scope: "voice:call-started",
      key: idempotencyKey,
      payloadHash: canonicalPayloadHash(body),
      businessId,
    });
    if (inbox.decision === "duplicate") return ok({ ok: true, duplicate: true });
    if (inbox.decision === "conflict") {
      throw new AppError(
        409,
        "WEBHOOK_PAYLOAD_CONFLICT",
        "Idempotency key was already used with a different payload",
      );
    }
    if (inbox.decision === "busy") throw tooManyRequests(inbox.retryAfterSeconds);

    try {
      const phoneNumber = normalizePhone(body.phone_number) ?? normalizePersianText(body.phone_number);

      // Idempotent insert: concurrent duplicate deliveries (different header
      // keys) collapse on the (businessId, externalCallId) unique constraint.
      // Usage is recorded exactly once — only for the winning insert.
      // The duplicate path ALSO reads metadata: the media bootstrap state
      // (answered/streaming) drives retry reconciliation (§3) — a redelivery
      // re-runs pending stages instead of skipping blindly or duplicating.
      const [inserted] = await db
        .insert(calls)
        .values({
          businessId: businessId,
          externalCallId: body.external_call_id,
          phoneNumber,
          agentId: body.agent_id ?? null,
          direction: body.direction ?? "INBOUND",
          status: "RINGING",
          startedAt: new Date(),
          metadata: { ...(body.metadata ?? {}), idempotencyKey, routing },
        })
        .onConflictDoNothing({ target: [calls.businessId, calls.externalCallId] })
        .returning({ id: calls.id });

      let callId = inserted?.id ?? null;
      const created = Boolean(inserted);
      let bootstrapState = { answered: false, streaming: false };
      if (!inserted) {
        const [existing] = await db
          .select({ id: calls.id, metadata: calls.metadata })
          .from(calls)
          .where(and(eq(calls.businessId, businessId), eq(calls.externalCallId, body.external_call_id)))
          .limit(1);
        callId = existing?.id ?? null;
        bootstrapState = parseBootstrapState(existing?.metadata);
      }
      if (!callId) {
        // Conflicted on insert but the row vanished — should never happen.
        throw new AppError(500, "INTERNAL_ERROR", "Call registration failed");
      }

      if (created) {
        await db
          .insert(usageRecords)
          .values({
            businessId: businessId,
            type: "calls",
            quantity: "1",
            unit: "count",
            idempotencyKey: `call-started:${callId}`,
            metadata: { event: "call_started", callId, externalCallId: body.external_call_id },
          })
          .onConflictDoNothing({ target: [usageRecords.businessId, usageRecords.idempotencyKey] });
      }

      // Fail-closed media bootstrap (§3): config problems yield an honest
      // 200 report with answered:false (the gateway keeps ringing); transient
      // provider failures THROW a retryable 502 (the inbox records FAILED so
      // redelivery reconciles). The call RECORD is the source of truth and
      // is already persisted either way.
      const media = await bootstrapMedia({
        businessId: businessId,
        businessSettings: (business.settings as Record<string, unknown>) ?? {},
        callId,
        externalCallId: body.external_call_id,
        requestId: rid,
        bootstrapState,
      });

      logInfo("Inbound call started", {
        requestId: rid,
        businessId: businessId,
        callId,
        operation: "voice.call-started",
        status: created ? "ok" : "duplicate",
      });

      await completeWebhookInbox(inbox.eventId, inbox.leaseToken, { callId, duplicate: !created, media });
      return ok({ ok: true, callId, duplicate: !created, media, routing });
    } catch (err) {
      // Record the failure so the NEXT redelivery re-processes (retryable)
      // instead of collapsing as a false duplicate.
      await failWebhookInbox(inbox.eventId, inbox.leaseToken, err);
      throw err;
    }
  });
}
