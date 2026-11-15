import { and, desc, eq, inArray, lt, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { auditLogs, outboxEvents } from "@/db/schema";
import { AppError } from "@/lib/errors";
import { logWarn } from "@/lib/logger";
import { metrics } from "@/lib/telemetry";
import { requestContext } from "@/lib/request-context";

/**
 * Transactional outbox.
 *
 * Domain events are written by the business transaction itself (`enqueueOutbox`
 * accepts the caller's transaction handle), so an event can never be published
 * without its state change, and a state change can never be silently published
 * without its event. Delivery (n8n automation, tenant webhooks, notifications)
 * happens in {@link processNextOutboxEvent} with leases, exponential backoff,
 * idempotency keys and a dead-letter state — provider I/O never runs inside a
 * database transaction.
 */

export const OUTBOX_TOPICS = [
  "lead.created",
  "appointment.created",
  "appointment.updated",
  "appointment.cancelled",
  "call.completed",
  "call.handoff_requested",
  "invoice.created",
  "payment.received",
  "subscription.changed",
  "user.invited",
  "tenant.suspended",
  "tenant.reactivated",
  "notification.requested",
  "knowledge.updated",
  "export.ready",
] as const;
export type OutboxTopic = (typeof OUTBOX_TOPICS)[number];
export const OutboxTopicSchema = z.enum(OUTBOX_TOPICS);

/** Topics fanned out to the tenant's own outbound webhook endpoints. */
export const TENANT_WEBHOOK_TOPICS: Partial<Record<OutboxTopic, string>> = {
  "call.completed": "call.completed",
  "call.handoff_requested": "call.handoff_requested",
  "lead.created": "lead.created",
  "appointment.created": "appointment.created",
  "appointment.updated": "appointment.updated",
  "appointment.cancelled": "appointment.cancelled",
  "invoice.created": "invoice.created",
  "payment.received": "payment.received",
  "subscription.changed": "subscription.changed",
  "knowledge.updated": "knowledge.updated",
  "export.ready": "export.ready",
  "user.invited": "user.invited",
};

/** Topics bridged to the n8n automation worker (legacy durable job queue). */
const AUTOMATION_TOPICS: Partial<
  Record<OutboxTopic, "new-lead" | "call-completed" | "appointment" | "human-handoff" | "notification">
> = {
  "lead.created": "new-lead",
  "call.completed": "call-completed",
  "appointment.created": "appointment",
  "appointment.updated": "appointment",
  "appointment.cancelled": "appointment",
  "call.handoff_requested": "human-handoff",
  "notification.requested": "notification",
};

export const MAX_OUTBOX_ATTEMPTS = 8;
export const OUTBOX_LEASE_SECONDS = 60;

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
export type OutboxExecutor = Pick<Tx, "insert">;

export type EnqueueOutboxInput = {
  businessId: string;
  topic: OutboxTopic;
  payload: Record<string, unknown>;
  /** Stable key; retries of the same logical event collapse to one row. */
  idempotencyKey: string;
  availableAt?: Date;
};

/**
 * Enqueue a domain event inside the caller's transaction.
 * Returns the created row, or `null` when the key was already used (safe retry).
 */
export async function enqueueOutbox(tx: OutboxExecutor, input: EnqueueOutboxInput) {
  const topic = OutboxTopicSchema.parse(input.topic);
  if (input.payload.businessId !== input.businessId)
    throw new AppError(400, "VALIDATION_ERROR", "Outbox payload tenant does not match row tenant");
  const rows = await tx
    .insert(outboxEvents)
    .values({
      businessId: input.businessId,
      topic,
      idempotencyKey: z.string().min(1).max(255).parse(input.idempotencyKey),
      payload: input.payload,
      availableAt: input.availableAt ?? new Date(),
    })
    .onConflictDoNothing({ target: [outboxEvents.businessId, outboxEvents.idempotencyKey] })
    .returning();
  return rows[0] ?? null;
}

export function outboxBackoffSeconds(attempt: number): number {
  return Math.min(3600, 10 * 2 ** Math.min(Math.max(attempt, 1), 10));
}

export type OutboxDelivery = {
  id: string;
  businessId: string;
  topic: OutboxTopic;
  /** Producer-supplied dedup key; consumers use it for their own idempotency. */
  idempotencyKey: string;
  payload: Record<string, unknown>;
  attempts: number;
};

export type OutboxHandler = (event: OutboxDelivery) => Promise<void>;

const handlers = new Map<OutboxTopic | "*", OutboxHandler[]>();

/** Register an additional consumer (tenant webhooks, tests, integrations). */
export function registerOutboxHandler(topic: OutboxTopic | "*", handler: OutboxHandler): void {
  handlers.set(topic, [...(handlers.get(topic) ?? []), handler]);
}

export function resetOutboxHandlers(): void {
  handlers.clear();
}

async function deliverAutomation(event: { businessId: string; topic: OutboxTopic; payload: Record<string, unknown>; idempotencyKey: string }) {
  const automationEvent = AUTOMATION_TOPICS[event.topic];
  if (!automationEvent) return;
  const { enqueueAutomationEvent } = await import("@/lib/services/jobs");
  // `enqueueAutomationEvent` is a no-op that reports `skipped` when N8N_ENABLED
  // is false: that is an explicit configuration state, not a delivery failure.
  const result = await enqueueAutomationEvent(
    automationEvent,
    { ...event.payload, businessId: event.businessId },
    { idempotencyKey: event.idempotencyKey, requestId: requestContext.getStore()?.requestId },
  );
  if (!result.ok) throw new Error(result.error ?? "Automation dispatch failed");
}

export type OutboxRunOutcome = "empty" | "delivered" | "retry" | "dead";

async function leaseAndDeliver(): Promise<{ outcome: OutboxRunOutcome; topic?: string }> {
  const claimId = crypto.randomUUID();
  const leased = await db.transaction(async (tx) => {
    // Dead-letter leases abandoned by a crashed worker.
    await tx.execute(sql`UPDATE outbox_events
      SET status = 'dead', claim_id = NULL, lease_until = NULL, updated_at = now(),
          last_error = COALESCE(last_error, 'lease expired after max attempts')
      WHERE status = 'processing' AND lease_until < now() AND attempts >= ${MAX_OUTBOX_ATTEMPTS}`);
    const selected = await tx.execute<{ id: string }>(sql`SELECT id FROM outbox_events
      WHERE attempts < ${MAX_OUTBOX_ATTEMPTS} AND (
        (status = 'pending' AND available_at <= now()) OR
        (status = 'processing' AND lease_until < now()))
      ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1`);
    const id = selected.rows[0]?.id;
    if (!id) return null;
    const [row] = await tx
      .update(outboxEvents)
      .set({
        status: "processing",
        claimId,
        attempts: sql`${outboxEvents.attempts} + 1`,
        leaseUntil: new Date(Date.now() + OUTBOX_LEASE_SECONDS * 1000),
        updatedAt: new Date(),
      })
      .where(eq(outboxEvents.id, id))
      .returning();
    return row;
  });
  if (!leased) return { outcome: "empty" };

  let error: string | null = null;
  try {
    await requestContext.run(
      { requestId: leased.id, traceId: leased.id.replaceAll("-", ""), businessId: leased.businessId },
      async () => {
        await deliverAutomation({
          businessId: leased.businessId,
          topic: leased.topic as OutboxTopic,
          payload: leased.payload,
          idempotencyKey: leased.idempotencyKey,
        });
        const delivery: OutboxDelivery = {
          id: leased.id,
          businessId: leased.businessId,
          topic: leased.topic as OutboxTopic,
          idempotencyKey: leased.idempotencyKey,
          payload: leased.payload,
          attempts: leased.attempts,
        };
        for (const handler of [...(handlers.get(delivery.topic) ?? []), ...(handlers.get("*") ?? [])]) {
          await handler(delivery);
        }
      },
    );
  } catch (err) {
    error = err instanceof Error ? err.message.slice(0, 1000) : "delivery_failed";
  }

  const exhausted = Boolean(error) && leased.attempts >= MAX_OUTBOX_ATTEMPTS;
  const outcome: OutboxRunOutcome = error ? (exhausted ? "dead" : "retry") : "delivered";
  await db
    .update(outboxEvents)
    .set({
      status: error ? (exhausted ? "dead" : "pending") : "delivered",
      availableAt: new Date(Date.now() + outboxBackoffSeconds(leased.attempts) * 1000),
      lastError: error,
      deliveredAt: error ? null : new Date(),
      claimId: null,
      leaseUntil: null,
      updatedAt: new Date(),
    })
    .where(and(eq(outboxEvents.id, leased.id), eq(outboxEvents.claimId, claimId)));

  metrics().outboxEvents.inc({ topic: leased.topic, result: outcome });
  if (error) {
    logWarn("Outbox event delivery failed", {
      businessId: leased.businessId,
      operation: `outbox.${leased.topic}`,
      status: outcome,
      attempts: String(leased.attempts),
      error,
    });
  }
  return { outcome, topic: leased.topic };
}

/**
 * Lease and process one outbox event. Returns false when the queue is empty
 * (lets a worker loop idle without spinning).
 */
export async function processNextOutboxEvent(): Promise<boolean> {
  return (await leaseAndDeliver()).outcome !== "empty";
}

/** Drain up to `limit` events and report per-outcome counts (worker + tests). */
export async function drainOutbox(limit = 50): Promise<{ processed: number; delivered: number; failed: number; dead: number }> {
  let processed = 0;
  let delivered = 0;
  let failed = 0;
  let dead = 0;
  for (let i = 0; i < limit; i++) {
    const { outcome } = await leaseAndDeliver();
    if (outcome === "empty") break;
    processed++;
    if (outcome === "delivered") delivered++;
    else if (outcome === "dead") dead++;
    else failed++;
  }
  return { processed, delivered, failed, dead };
}

export const OutboxPageSchema = z
  .object({
    businessId: z.string().uuid(),
    status: z.enum(["pending", "processing", "delivered", "dead"]).optional(),
    topic: OutboxTopicSchema.optional(),
    before: z.string().uuid().optional(),
    limit: z.coerce.number().int().min(1).max(100).default(30),
  })
  .strict();

/**
 * Tenant-scoped operator view. `businessId` is mandatory: the caller must
 * already hold an authorized tenant context (platform admin or tenant admin).
 */
export async function listOutboxEvents(input: unknown, actorId?: string) {
  const page = OutboxPageSchema.parse(input);
  if (actorId) {
    const { assertTenantAdmin } = await import("@/lib/services/platform");
    await assertTenantAdmin(actorId, page.businessId);
  }
  const rows = await db
    .select()
    .from(outboxEvents)
    .where(
      and(
        eq(outboxEvents.businessId, page.businessId),
        page.status ? eq(outboxEvents.status, page.status) : undefined,
        page.topic ? eq(outboxEvents.topic, page.topic) : undefined,
        page.before ? lt(outboxEvents.createdAt, new Date(page.before)) : undefined,
      ),
    )
    .orderBy(desc(outboxEvents.createdAt))
    .limit(page.limit + 1);
  const hasMore = rows.length > page.limit;
  const data = rows.slice(0, page.limit);
  return { data, hasMore, nextCursor: hasMore ? data[data.length - 1].createdAt.toISOString() : null };
}

export const RequeueOutboxSchema = z
  .object({ eventId: z.string().uuid(), reason: z.string().trim().min(10).max(1000) })
  .strict();

/**
 * Operator requeue of a dead-lettered event. The original event identity
 * (idempotency key) is preserved, so consumers that already processed the
 * delivery cannot act twice.
 */
export async function requeueOutboxEvent(actorId: string, input: unknown) {
  const body = RequeueOutboxSchema.parse(input);
  const { requirePlatformAdmin } = await import("@/lib/services/platform");
  return db.transaction(async (tx) => {
    await requirePlatformAdmin(tx, actorId, true);
    const [event] = await tx.select().from(outboxEvents).where(eq(outboxEvents.id, body.eventId)).for("update");
    if (!event) throw new AppError(404, "NOT_FOUND", "Outbox event not found");
    if (event.status !== "dead") throw new AppError(409, "CONFLICT", "Only dead-lettered events can be requeued");
    await tx
      .update(outboxEvents)
      .set({ status: "pending", attempts: 0, availableAt: new Date(), leaseUntil: null, claimId: null, lastError: null, updatedAt: new Date() })
      .where(eq(outboxEvents.id, event.id));
    await tx.insert(auditLogs).values({
      businessId: event.businessId,
      actorType: "platform_admin",
      actorId,
      action: "outbox.requeued",
      entityType: "outbox_event",
      entityId: event.id,
      requestId: requestContext.getStore()?.requestId,
      metadata: { reason: body.reason, topic: event.topic, attempts: event.attempts },
    });
    return { id: event.id, status: "pending" as const };
  });
}

/** Operational counts (no tenant identifiers) for readiness and the control plane. */
export async function outboxHealth(): Promise<{ pending: number; processing: number; dead: number }> {
  const rows = await db
    .select({ status: outboxEvents.status, count: sql<number>`count(*)::int` })
    .from(outboxEvents)
    .where(inArray(outboxEvents.status, ["pending", "processing", "dead"]))
    .groupBy(outboxEvents.status);
  const read = (status: string) => rows.find((row) => row.status === status)?.count ?? 0;
  return { pending: read("pending"), processing: read("processing"), dead: read("dead") };
}

/** One worker tick: outbox events first. Returns the number processed. */
export async function runOutboxWorkerTick(limit = 25): Promise<{ processed: number }> {
  const { processed } = await drainOutbox(limit);
  return { processed };
}
