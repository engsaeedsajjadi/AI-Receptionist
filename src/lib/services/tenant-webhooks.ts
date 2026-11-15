import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { auditLogs, webhookDeliveries, webhookEndpoints } from "@/db/schema";
import { parseWith } from "@/lib/api";
import { AppError } from "@/lib/errors";
import { logInfo, logWarn } from "@/lib/logger";
import { decryptMfa, encryptMfa } from "@/lib/mfa";
import { requestContext } from "@/lib/request-context";
import { metrics } from "@/lib/telemetry";
import { OUTBOX_TOPICS, TENANT_WEBHOOK_TOPICS, type OutboxTopic } from "@/lib/services/outbox";

/**
 * Outbound tenant webhooks.
 *
 * Delivery contract:
 *  - every delivery row is unique per (endpoint, idempotency key) so an outbox
 *    retry can never enqueue the same event twice,
 *  - requests carry `X-Receptionist-Signature: t=<unix>,v1=<hex hmac sha256 of
 *    "<t>.<body>">` plus `X-Receptionist-Event` and `X-Receptionist-Delivery`,
 *  - retries use exponential backoff (1s, 4s, 16s, 64s, …) and stop after
 *    MAX_DELIVERY_ATTEMPTS; exhausted deliveries are marked `dead` (dead-letter)
 *    and surfaced in the delivery log,
 *  - an endpoint with repeated consecutive failures is auto-disabled and must be
 *    re-enabled by a tenant administrator (never silently dropped).
 */

export const ENDPOINT_EVENTS = Object.values(TENANT_WEBHOOK_TOPICS).filter((value): value is string => Boolean(value));
export const MAX_DELIVERY_ATTEMPTS = 6;
export const DELIVERY_TIMEOUT_MS = 10_000;
export const AUTO_DISABLE_AFTER_FAILURES = 20;

export function deliveryBackoffMs(attempt: number): number {
  return Math.min(64_000, 1000 * 4 ** Math.max(0, attempt - 1));
}

export const WebhookEndpointSchema = z
  .object({
    url: z
      .string()
      .url()
      .max(2048)
      .refine((value) => value.startsWith("https://"), "Webhook endpoints must use https"),
    description: z.string().trim().max(255).optional(),
    events: z.array(z.string().trim().min(3).max(80)).min(1).max(30),
  })
  .strict();

/** Create an endpoint; the signing secret is returned exactly once. */
export async function createWebhookEndpoint(actor: { userId: string; businessId: string }, raw: unknown) {
  const input = parseWith(WebhookEndpointSchema, raw);
  const unknownEvents = input.events.filter((event) => !ENDPOINT_EVENTS.includes(event));
  if (unknownEvents.length) throw new AppError(400, "INVALID_PAYLOAD", `Unsupported event names: ${unknownEvents.join(", ")}`);
  const secret = `whsec_${randomBytes(24).toString("base64url")}`;
  const endpointId = randomUUID();
  const [row] = await db
    .insert(webhookEndpoints)
    .values({
      id: endpointId,
      businessId: actor.businessId,
      url: input.url,
      description: input.description ?? null,
      events: input.events,
      // Hash for fast equality checks; ciphertext (AAD = endpoint id) for HMAC signing.
      secretHash: createHash("sha256").update(secret).digest("hex"),
      secretCiphertext: encryptMfa(secret, endpointId),
      createdBy: actor.userId,
    })
    .returning({ id: webhookEndpoints.id, url: webhookEndpoints.url, events: webhookEndpoints.events, isActive: webhookEndpoints.isActive, createdAt: webhookEndpoints.createdAt });
  await db.insert(auditLogs).values({
    businessId: actor.businessId,
    actorType: "user",
    actorId: actor.userId,
    action: "webhook.endpoint_created",
    entityType: "webhook_endpoint",
    entityId: row.id,
    requestId: requestContext.getStore()?.requestId,
    metadata: { url: row.url, events: row.events },
  });
  return { ...row, secret };
}

export async function listWebhookEndpoints(businessId: string) {
  return db
    .select({
      id: webhookEndpoints.id,
      url: webhookEndpoints.url,
      description: webhookEndpoints.description,
      events: webhookEndpoints.events,
      isActive: webhookEndpoints.isActive,
      failureCount: webhookEndpoints.failureCount,
      disabledAt: webhookEndpoints.disabledAt,
      createdAt: webhookEndpoints.createdAt,
    })
    .from(webhookEndpoints)
    .where(eq(webhookEndpoints.businessId, businessId))
    .orderBy(desc(webhookEndpoints.createdAt))
    .limit(100);
}

export const WebhookEndpointUpdateSchema = z
  .object({
    endpointId: z.string().uuid(),
    url: z.string().url().max(2048).optional(),
    description: z.string().trim().max(255).optional(),
    events: z.array(z.string().trim().min(3).max(80)).min(1).max(30).optional(),
    isActive: z.boolean().optional(),
    rotateSecret: z.boolean().optional(),
  })
  .strict();

/** Update/rotate an endpoint. Rotation returns the new secret once. */
export async function updateWebhookEndpoint(actor: { userId: string; businessId: string }, raw: unknown) {
  const input = parseWith(WebhookEndpointUpdateSchema, raw);
  if (input.url && !input.url.startsWith("https://")) throw new AppError(400, "INVALID_PAYLOAD", "Webhook endpoints must use https");
  if (input.events) {
    const unknownEvents = input.events.filter((event) => !ENDPOINT_EVENTS.includes(event));
    if (unknownEvents.length) throw new AppError(400, "INVALID_PAYLOAD", `Unsupported event names: ${unknownEvents.join(", ")}`);
  }
  const secret = input.rotateSecret ? `whsec_${randomBytes(24).toString("base64url")}` : null;
  const [row] = await db
    .update(webhookEndpoints)
    .set({
      ...(input.url ? { url: input.url } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.events ? { events: input.events } : {}),
      ...(input.isActive !== undefined ? { isActive: input.isActive, disabledAt: input.isActive ? null : new Date(), failureCount: input.isActive ? 0 : undefined } : {}),
      ...(secret ? { secretHash: createHash("sha256").update(secret).digest("hex"), secretCiphertext: encryptMfa(secret, input.endpointId) } : {}),
      updatedAt: new Date(),
    })
    .where(and(eq(webhookEndpoints.id, input.endpointId), eq(webhookEndpoints.businessId, actor.businessId)))
    .returning({ id: webhookEndpoints.id, url: webhookEndpoints.url, events: webhookEndpoints.events, isActive: webhookEndpoints.isActive });
  if (!row) throw new AppError(404, "NOT_FOUND", "Webhook endpoint not found");
  await db.insert(auditLogs).values({
    businessId: actor.businessId,
    actorType: "user",
    actorId: actor.userId,
    action: secret ? "webhook.secret_rotated" : "webhook.endpoint_updated",
    entityType: "webhook_endpoint",
    entityId: row.id,
    requestId: requestContext.getStore()?.requestId,
    metadata: { url: row.url, events: row.events, isActive: row.isActive },
  });
  return { ...row, ...(secret ? { secret } : {}) };
}

export async function deleteWebhookEndpoint(actor: { userId: string; businessId: string }, endpointId: string) {
  const [row] = await db
    .delete(webhookEndpoints)
    .where(and(eq(webhookEndpoints.id, endpointId), eq(webhookEndpoints.businessId, actor.businessId)))
    .returning({ id: webhookEndpoints.id, url: webhookEndpoints.url });
  if (!row) throw new AppError(404, "NOT_FOUND", "Webhook endpoint not found");
  await db.insert(auditLogs).values({
    businessId: actor.businessId,
    actorType: "user",
    actorId: actor.userId,
    action: "webhook.endpoint_deleted",
    entityType: "webhook_endpoint",
    entityId: row.id,
    requestId: requestContext.getStore()?.requestId,
    metadata: { url: row.url },
  });
  return row;
}

export function signWebhookPayload(secret: string, body: string, timestamp = Math.floor(Date.now() / 1000)): string {
  const signature = createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
  return `t=${timestamp},v1=${signature}`;
}

/** Verify a signature we produced (used by tests and by customer SDK samples). */
export function verifyWebhookSignature(input: { secret: string; body: string; header: string; toleranceSeconds?: number }): boolean {
  const parts = Object.fromEntries(input.header.split(",").map((piece) => piece.split("=") as [string, string]));
  const timestamp = Number(parts.t);
  if (!Number.isFinite(timestamp)) return false;
  if (Math.abs(Date.now() / 1000 - timestamp) > (input.toleranceSeconds ?? 300)) return false;
  const expected = signWebhookPayload(input.secret, input.body, timestamp);
  return expected === input.header;
}

/**
 * Fan an outbox event out to the tenant's endpoints. Called by the outbox
 * worker for every delivered event; the delivery rows carry their own retry
 * state so the outbox itself can retry independently.
 */
export async function fanOutTenantEvent(input: {
  businessId: string;
  topic: OutboxTopic;
  payload: Record<string, unknown>;
  idempotencyKey: string;
}): Promise<number> {
  const eventName = TENANT_WEBHOOK_TOPICS[input.topic];
  if (!eventName) return 0;
  const endpoints = await db
    .select({ id: webhookEndpoints.id, events: webhookEndpoints.events })
    .from(webhookEndpoints)
    .where(and(eq(webhookEndpoints.businessId, input.businessId), eq(webhookEndpoints.isActive, true)));
  const targets = endpoints.filter((endpoint) => (endpoint.events ?? []).includes(eventName));
  if (targets.length === 0) return 0;
  const body = {
    id: input.idempotencyKey,
    event: eventName,
    createdAt: new Date().toISOString(),
    data: input.payload,
  };
  let created = 0;
  for (const endpoint of targets) {
    const inserted = await db
      .insert(webhookDeliveries)
      .values({
        businessId: input.businessId,
        endpointId: endpoint.id,
        event: eventName,
        idempotencyKey: input.idempotencyKey,
        payload: body as unknown as Record<string, unknown>,
        status: "pending",
      })
      .onConflictDoNothing({ target: [webhookDeliveries.endpointId, webhookDeliveries.idempotencyKey] })
      .returning({ id: webhookDeliveries.id });
    created += inserted.length;
  }
  return created;
}

type DeliveryOutcome = { status: number | null; error: string | null };

async function postDelivery(input: { url: string; secret: string; deliveryId: string; event: string; body: string }): Promise<DeliveryOutcome> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DELIVERY_TIMEOUT_MS);
  try {
    const res = await fetch(input.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "user-agent": "ai-receptionist-webhooks/1",
        "x-receptionist-event": input.event,
        "x-receptionist-delivery": input.deliveryId,
        "x-receptionist-signature": signWebhookPayload(input.secret, input.body),
      },
      body: input.body,
      signal: controller.signal,
    });
    // Drain the body so the connection can be reused, never log its content.
    await res.text().catch(() => "");
    return { status: res.status, error: res.ok ? null : `http_${res.status}` };
  } catch (err) {
    const aborted = err instanceof Error && err.name === "AbortError";
    return { status: null, error: aborted ? "timeout" : err instanceof Error ? err.message.slice(0, 200) : "delivery_error" };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Attempt due deliveries. Returns counts for observability. Safe to run
 * concurrently (each row is claimed with a conditional status update).
 */
export async function runWebhookDeliveryTick(limit = 20, now = new Date()): Promise<{ attempted: number; delivered: number; failed: number; dead: number }> {
  const due = await db
    .select({
      id: webhookDeliveries.id,
      businessId: webhookDeliveries.businessId,
      endpointId: webhookDeliveries.endpointId,
      event: webhookDeliveries.event,
      payload: webhookDeliveries.payload,
      attempts: webhookDeliveries.attempts,
      updatedAt: webhookDeliveries.updatedAt,
      url: webhookEndpoints.url,
      secretCiphertext: webhookEndpoints.secretCiphertext,
      endpointActive: webhookEndpoints.isActive,
    })
    .from(webhookDeliveries)
    .innerJoin(webhookEndpoints, eq(webhookEndpoints.id, webhookDeliveries.endpointId))
    .where(and(eq(webhookDeliveries.status, "pending"), eq(webhookEndpoints.isActive, true)))
    .orderBy(webhookDeliveries.createdAt)
    .limit(limit);

  let attempted = 0;
  let delivered = 0;
  let failed = 0;
  let dead = 0;
  for (const row of due) {
    // Retry only after the exponential backoff window has elapsed.
    if (row.attempts > 0 && row.updatedAt.getTime() + deliveryBackoffMs(row.attempts) > now.getTime()) continue;
    const claiming = await db
      .update(webhookDeliveries)
      .set({ status: "pending", attempts: row.attempts + 1, updatedAt: new Date() })
      .where(and(eq(webhookDeliveries.id, row.id), eq(webhookDeliveries.attempts, row.attempts), eq(webhookDeliveries.status, "pending")))
      .returning({ id: webhookDeliveries.id });
    if (claiming.length === 0) continue; // another worker took it
    attempted += 1;
    const body = JSON.stringify(row.payload);
    let secret: string;
    try {
      secret = decryptMfa(row.secretCiphertext, row.endpointId);
    } catch (err) {
      await db
        .update(webhookDeliveries)
        .set({ status: "dead", lastError: "secret_undecryptable", updatedAt: new Date() })
        .where(eq(webhookDeliveries.id, row.id));
      logWarn("Webhook secret could not be decrypted", {
        businessId: row.businessId,
        operation: "webhook.deliver",
        status: "dead",
        error: err instanceof Error ? err.message : String(err),
      });
      dead += 1;
      continue;
    }
    const outcome = await postDelivery({ url: row.url, secret, deliveryId: row.id, event: row.event, body });
    const exhausted = row.attempts + 1 >= MAX_DELIVERY_ATTEMPTS;
    if (outcome.error === null) {
      delivered += 1;
      await db
        .update(webhookDeliveries)
        .set({ status: "delivered", deliveredAt: new Date(), responseStatus: outcome.status, lastError: null, updatedAt: new Date() })
        .where(eq(webhookDeliveries.id, row.id));
      await db.update(webhookEndpoints).set({ failureCount: 0, updatedAt: new Date() }).where(eq(webhookEndpoints.id, row.endpointId));
      metrics().webhookDeliveries.inc({ result: "delivered" });
    } else {
      failed += 1;
      if (exhausted) dead += 1;
      await db
        .update(webhookDeliveries)
        .set({ status: exhausted ? "dead" : "pending", responseStatus: outcome.status, lastError: outcome.error, updatedAt: new Date() })
        .where(eq(webhookDeliveries.id, row.id));
      const [endpoint] = await db
        .update(webhookEndpoints)
        .set({ failureCount: sql`${webhookEndpoints.failureCount} + 1`, updatedAt: new Date() })
        .where(eq(webhookEndpoints.id, row.endpointId))
        .returning({ failureCount: webhookEndpoints.failureCount });
      metrics().webhookDeliveries.inc({ result: exhausted ? "dead" : "failed" });
      if (endpoint && endpoint.failureCount >= AUTO_DISABLE_AFTER_FAILURES) {
        await db
          .update(webhookEndpoints)
          .set({ isActive: false, disabledAt: new Date(), updatedAt: new Date() })
          .where(eq(webhookEndpoints.id, row.endpointId));
        logWarn("Webhook endpoint auto-disabled after repeated failures", {
          businessId: row.businessId,
          operation: "webhook.endpoint_disabled",
          status: "disabled",
        });
      }
    }
  }
  if (attempted > 0) {
    logInfo("Webhook delivery tick completed", {
      operation: "webhook.tick",
      status: "ok",
    });
  }
  return { attempted, delivered, failed, dead };
}

export const DeliveryQuerySchema = z
  .object({
    endpointId: z.string().uuid().optional(),
    status: z.enum(["pending", "delivered", "failed", "dead"]).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  })
  .strict();

/** Delivery log (no payload secrets, no response bodies). */
export async function listWebhookDeliveries(businessId: string, raw: unknown) {
  const query = parseWith(DeliveryQuerySchema, raw);
  return db
    .select({
      id: webhookDeliveries.id,
      endpointId: webhookDeliveries.endpointId,
      event: webhookDeliveries.event,
      status: webhookDeliveries.status,
      attempts: webhookDeliveries.attempts,
      responseStatus: webhookDeliveries.responseStatus,
      lastError: webhookDeliveries.lastError,
      deliveredAt: webhookDeliveries.deliveredAt,
      createdAt: webhookDeliveries.createdAt,
    })
    .from(webhookDeliveries)
    .where(
      and(
        eq(webhookDeliveries.businessId, businessId),
        query.endpointId ? eq(webhookDeliveries.endpointId, query.endpointId) : sql`TRUE`,
        query.status ? eq(webhookDeliveries.status, query.status) : sql`TRUE`,
      ),
    )
    .orderBy(desc(webhookDeliveries.createdAt))
    .limit(query.limit);
}

/** Requeue a dead delivery (platform/support operation, audited by caller). */
export async function requeueWebhookDelivery(businessId: string, deliveryId: string) {
  const [row] = await db
    .update(webhookDeliveries)
    .set({ status: "pending", attempts: 0, lastError: null, updatedAt: new Date() })
    .where(and(eq(webhookDeliveries.id, deliveryId), eq(webhookDeliveries.businessId, businessId), eq(webhookDeliveries.status, "dead")))
    .returning({ id: webhookDeliveries.id });
  if (!row) throw new AppError(404, "NOT_FOUND", "Dead delivery not found");
  return row;
}

/** Health summary for the platform control plane. */
export async function webhookHealth() {
  const rows = await db
    .select({ status: webhookDeliveries.status, count: sql<string>`count(*)::text` })
    .from(webhookDeliveries)
    .groupBy(webhookDeliveries.status);
  const endpoints = await db.select({ count: sql<string>`count(*)::text` }).from(webhookEndpoints).where(isNull(webhookEndpoints.disabledAt));
  const counts: Record<string, number> = { pending: 0, delivered: 0, failed: 0, dead: 0 };
  for (const row of rows) counts[row.status] = Number(row.count);
  return { deliveries: counts, activeEndpoints: Number(endpoints[0]?.count ?? 0), maxAttempts: MAX_DELIVERY_ATTEMPTS };
}

/** Topic → tenant event mapping (exposed for documentation and tests). */
export function webhookTopicCatalog(): Array<{ topic: OutboxTopic; event: string }> {
  return OUTBOX_TOPICS.filter((topic) => TENANT_WEBHOOK_TOPICS[topic]).map((topic) => ({ topic, event: TENANT_WEBHOOK_TOPICS[topic]! }));
}
