import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { db, closeDb } from "@/db";
import { outboxEvents, webhookDeliveries, webhookEndpoints } from "@/db/schema";
import {
  createWebhookEndpoint,
  deleteWebhookEndpoint,
  deliveryBackoffMs,
  fanOutTenantEvent,
  listWebhookDeliveries,
  listWebhookEndpoints,
  MAX_DELIVERY_ATTEMPTS,
  requeueWebhookDelivery,
  runWebhookDeliveryTick,
  signWebhookPayload,
  updateWebhookEndpoint,
  verifyWebhookSignature,
  webhookHealth,
  webhookTopicCatalog,
} from "@/lib/services/tenant-webhooks";
import { enqueueOutbox, resetOutboxHandlers, runOutboxWorkerTick } from "@/lib/services/outbox";
import { registerDefaultOutboxHandlers, resetDefaultOutboxHandlers } from "@/lib/services/outbox-handlers";
import { createBusiness, createUser } from "../helpers/fixtures";
import { ensureDbReady, hasTestDatabase, itDb, truncateAll } from "../helpers/db";

async function tenant() {
  const business = await createBusiness();
  const { user } = await createUser(business.id, "ADMIN");
  return { business, actor: { userId: user.id, businessId: business.id } };
}

/** Register a fake endpoint receiver and capture outbound calls. */
function receiver(responses: Array<{ status: number } | "timeout"> = [{ status: 200 }]) {
  const calls: Array<{ url: string; headers: Record<string, string>; body: string }> = [];
  let index = 0;
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    const headers = (init.headers ?? {}) as Record<string, string>;
    calls.push({ url: String(url), headers, body: String(init.body ?? "") });
    const next = responses[Math.min(index, responses.length - 1)];
    index += 1;
    if (next === "timeout") {
      const error = new Error("aborted");
      error.name = "AbortError";
      throw error;
    }
    return new Response("{}", { status: next.status });
  });
  return calls;
}

describe.skipIf(!hasTestDatabase())("outbound tenant webhooks", () => {
  beforeAll(async () => {
    await ensureDbReady();
    await truncateAll();
    // Endpoint signing secrets are encrypted at rest; the key is configured by
    // this suite explicitly (never a development default).
    vi.stubEnv("IDENTITY_ENCRYPTION_KEY", "c1".repeat(32));
  });
  afterAll(async () => {
    vi.unstubAllEnvs();
    await truncateAll();
    await closeDb();
  });
  beforeEach(async () => {
    // Each test starts from an empty tenant/delivery state.
    await truncateAll();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  itDb("registers endpoints with https-only URLs and returns the secret once", async () => {
    const { actor } = await tenant();
    const endpoint = await createWebhookEndpoint(actor, { url: "https://crm.example.com/hooks/receptionist", events: ["lead.created", "call.completed"], description: "CRM" });
    expect(endpoint.secret.startsWith("whsec_")).toBe(true);

    const rows = await db.select().from(webhookEndpoints).where(eq(webhookEndpoints.businessId, actor.businessId));
    expect(rows).toHaveLength(1);
    // Only the hash and ciphertext are persisted; the plaintext secret is not.
    expect(JSON.stringify(rows[0])).not.toContain(endpoint.secret);
    expect(rows[0].secretHash).toHaveLength(64);

    await expect(createWebhookEndpoint(actor, { url: "http://insecure.example.com/hook", events: ["lead.created"] })).rejects.toMatchObject({ status: 400 });
    await expect(createWebhookEndpoint(actor, { url: "https://x.example.com/hook", events: ["nope.event"] })).rejects.toMatchObject({ status: 400 });
    await expect(createWebhookEndpoint(actor, { url: "not-a-url", events: ["lead.created"] })).rejects.toMatchObject({ status: 400 });
  });

  itDb("rotates secrets, toggles activity and deletes (tenant-scoped)", async () => {
    const a = await tenant();
    const b = await tenant();
    const endpoint = await createWebhookEndpoint(a.actor, { url: "https://a.example.com/hook", events: ["lead.created"] });
    const rotated = await updateWebhookEndpoint(a.actor, { endpointId: endpoint.id, rotateSecret: true });
    expect(rotated.secret).not.toBe(endpoint.secret);

    const [row] = await db.select().from(webhookEndpoints).where(eq(webhookEndpoints.id, endpoint.id));
    expect(row.secretHash).toBe((await import("node:crypto")).createHash("sha256").update(rotated.secret!).digest("hex"));

    await updateWebhookEndpoint(a.actor, { endpointId: endpoint.id, isActive: false });
    expect((await listWebhookEndpoints(a.business.id))[0].isActive).toBe(false);
    await updateWebhookEndpoint(a.actor, { endpointId: endpoint.id, events: ["call.completed"] });
    expect((await listWebhookEndpoints(a.business.id))[0].events).toEqual(["call.completed"]);

    // Another tenant cannot touch it.
    await expect(updateWebhookEndpoint(b.actor, { endpointId: endpoint.id, isActive: true })).rejects.toMatchObject({ status: 404 });
    await expect(deleteWebhookEndpoint(b.actor, endpoint.id)).rejects.toMatchObject({ status: 404 });
    expect((await listWebhookEndpoints(b.business.id)).length).toBe(0);
  });

  itDb("fans out only subscribed events and deduplicates per delivery key", async () => {
    const a = await tenant();
    await createWebhookEndpoint(a.actor, { url: "https://a.example.com/hook", events: ["lead.created"] });
    await createWebhookEndpoint(a.actor, { url: "https://a.example.com/other", events: ["call.completed"] });

    const created = await fanOutTenantEvent({ businessId: a.business.id, topic: "lead.created", payload: { id: "lead-1" }, idempotencyKey: "lead.created:lead-1" });
    expect(created).toBe(1);
    const again = await fanOutTenantEvent({ businessId: a.business.id, topic: "lead.created", payload: { id: "lead-1" }, idempotencyKey: "lead.created:lead-1" });
    expect(again).toBe(0);
    // Unsubscribed topics are not delivered anywhere.
    expect(await fanOutTenantEvent({ businessId: a.business.id, topic: "tenant.suspended", payload: {}, idempotencyKey: "x" })).toBe(0);
  });

  itDb("delivers a signed payload, records status and clears endpoint failures", async () => {
    const { business, actor } = await tenant();
    const endpoint = await createWebhookEndpoint(actor, { url: "https://crm.example.com/hook", events: ["lead.created"] });
    await db.update(webhookEndpoints).set({ failureCount: 3 }).where(eq(webhookEndpoints.id, endpoint.id));
    await fanOutTenantEvent({ businessId: business.id, topic: "lead.created", payload: { leadId: "lead-9" }, idempotencyKey: "lead.created:lead-9" });

    const calls = receiver([{ status: 200 }]);
    const result = await runWebhookDeliveryTick();
    expect(result).toMatchObject({ attempted: 1, delivered: 1, failed: 0, dead: 0 });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://crm.example.com/hook");
    expect(calls[0].headers["x-receptionist-event"]).toBe("lead.created");
    expect(verifyWebhookSignature({ secret: endpoint.secret, body: calls[0].body, header: calls[0].headers["x-receptionist-signature"] })).toBe(true);
    expect(JSON.parse(calls[0].body)).toMatchObject({ event: "lead.created", data: { leadId: "lead-9" } });

    const [row] = await db.select().from(webhookDeliveries).where(eq(webhookDeliveries.endpointId, endpoint.id));
    expect(row.status).toBe("delivered");
    expect(row.responseStatus).toBe(200);
    expect(row.deliveredAt).not.toBeNull();
    expect((await db.select().from(webhookEndpoints).where(eq(webhookEndpoints.id, endpoint.id)))[0].failureCount).toBe(0);

    // A stale signature is rejected by the verifier.
    expect(verifyWebhookSignature({ secret: endpoint.secret, body: calls[0].body, header: `t=${Math.floor(Date.now() / 1000) - 4000},v1=deadbeef` })).toBe(false);
  });

  itDb("retries with backoff, dead-letters after the cap, and requeues dead deliveries", async () => {
    const { business, actor } = await tenant();
    const endpoint = await createWebhookEndpoint(actor, { url: "https://down.example.com/hook", events: ["lead.created"] });
    await fanOutTenantEvent({ businessId: business.id, topic: "lead.created", payload: { leadId: "lead-x" }, idempotencyKey: "lead.created:lead-x" });
    const [delivery] = await db.select().from(webhookDeliveries).where(eq(webhookDeliveries.endpointId, endpoint.id));

    receiver([{ status: 500 }]);
    const first = await runWebhookDeliveryTick();
    expect(first).toMatchObject({ attempted: 1, delivered: 0, failed: 1, dead: 0 });
    let [row] = await db.select().from(webhookDeliveries).where(eq(webhookDeliveries.id, delivery.id));
    expect(row.status).toBe("pending");
    expect(row.attempts).toBe(1);
    expect(row.lastError).toBe("http_500");

    // Backoff: an immediate re-run must not retry (window has not elapsed).
    const immediate = await runWebhookDeliveryTick();
    expect(immediate.attempted).toBe(0);
    expect(deliveryBackoffMs(1)).toBe(1000);
    expect(deliveryBackoffMs(4)).toBe(64_000);

    // Simulate an exhausted delivery: attempts at the cap become dead.
    await db.update(webhookDeliveries).set({ attempts: MAX_DELIVERY_ATTEMPTS - 1, updatedAt: new Date(Date.now() - 120_000) }).where(eq(webhookDeliveries.id, delivery.id));
    const exhausted = await runWebhookDeliveryTick();
    expect(exhausted).toMatchObject({ attempted: 1, failed: 1, dead: 1 });
    [row] = await db.select().from(webhookDeliveries).where(eq(webhookDeliveries.id, delivery.id));
    expect(row.status).toBe("dead");

    const requeued = await requeueWebhookDelivery(business.id, delivery.id);
    expect(requeued.id).toBe(delivery.id);
    [row] = await db.select().from(webhookDeliveries).where(eq(webhookDeliveries.id, delivery.id));
    expect(row).toMatchObject({ status: "pending", attempts: 0, lastError: null });
    await expect(requeueWebhookDelivery(business.id, delivery.id)).rejects.toMatchObject({ status: 404 });
  });

  itDb("auto-disables endpoints after repeated failures and never retries disabled endpoints", async () => {
    const { business, actor } = await tenant();
    const endpoint = await createWebhookEndpoint(actor, { url: "https://always-down.example.com/hook", events: ["lead.created"] });
    const { AUTO_DISABLE_AFTER_FAILURES } = await import("@/lib/services/tenant-webhooks");
    await db.update(webhookEndpoints).set({ failureCount: AUTO_DISABLE_AFTER_FAILURES - 1 }).where(eq(webhookEndpoints.id, endpoint.id));
    await fanOutTenantEvent({ businessId: business.id, topic: "lead.created", payload: {}, idempotencyKey: "lead.created:auto-disable" });
    receiver([{ status: 503 }]);
    await runWebhookDeliveryTick();
    const [row] = await db.select().from(webhookEndpoints).where(eq(webhookEndpoints.id, endpoint.id));
    expect(row.isActive).toBe(false);
    expect(row.disabledAt).not.toBeNull();
    expect((await runWebhookDeliveryTick()).attempted).toBe(0);
    // Re-enabling resets the failure counter.
    await updateWebhookEndpoint(actor, { endpointId: endpoint.id, isActive: true });
    expect((await db.select().from(webhookEndpoints).where(eq(webhookEndpoints.id, endpoint.id)))[0].failureCount).toBe(0);
  });

  itDb("the outbox worker fans delivered events out to endpoints", async () => {
    resetOutboxHandlers();
    resetDefaultOutboxHandlers();
    registerDefaultOutboxHandlers();
    const { business, actor } = await tenant();
    const endpoint = await createWebhookEndpoint(actor, { url: "https://crm.example.com/hook", events: ["call.completed"] });
    await db.transaction(async (tx) => {
      await enqueueOutbox(tx, {
        businessId: business.id,
        topic: "call.completed",
        idempotencyKey: "call.completed:abc",
        payload: { businessId: business.id, callId: "abc" },
      });
    });
    receiver([{ status: 200 }]);
    const ticks = await runOutboxWorkerTick();
    expect(ticks.processed).toBeGreaterThanOrEqual(1);
    const deliveries = await db.select().from(webhookDeliveries).where(eq(webhookDeliveries.endpointId, endpoint.id));
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0].event).toBe("call.completed");
    const [outboxRow] = await db.select().from(outboxEvents).where(eq(outboxEvents.idempotencyKey, "call.completed:abc"));
    expect(outboxRow.status).toBe("delivered");
  });

  itDb("exposes delivery log, health summary and the topic catalog", async () => {
    const { business, actor } = await tenant();
    const endpoint = await createWebhookEndpoint(actor, { url: "https://log.example.com/hook", events: ["lead.created"] });
    await fanOutTenantEvent({ businessId: business.id, topic: "lead.created", payload: {}, idempotencyKey: "lead.created:log" });
    receiver([{ status: 200 }]);
    await runWebhookDeliveryTick();

    const log = await listWebhookDeliveries(business.id, { status: "delivered", limit: 10 });
    expect(log).toHaveLength(1);
    expect(log[0].endpointId).toBe(endpoint.id);
    expect(JSON.stringify(log)).not.toContain("payload");
    expect(await listWebhookDeliveries(business.id, { status: "dead" })).toHaveLength(0);

    const health = await webhookHealth();
    expect(health.deliveries.delivered).toBeGreaterThanOrEqual(1);
    expect(health.activeEndpoints).toBeGreaterThanOrEqual(1);
    expect(health.maxAttempts).toBe(MAX_DELIVERY_ATTEMPTS);
    expect(webhookTopicCatalog().length).toBeGreaterThan(5);
  });

  itDb("signature helper is deterministic and rejects malformed headers", async () => {
    const header = signWebhookPayload("whsec_test", '{"a":1}', 1_700_000_000);
    expect(header.startsWith("t=1700000000,v1=")).toBe(true);
    expect(signWebhookPayload("whsec_test", '{"a":1}', 1_700_000_000)).toBe(header);
    expect(verifyWebhookSignature({ secret: "whsec_test", body: '{"a":1}', header: "garbage", toleranceSeconds: 10 ** 9 })).toBe(false);
    expect(verifyWebhookSignature({ secret: "whsec_other", body: '{"a":1}', header, toleranceSeconds: 10 ** 9 })).toBe(false);
  });

  itDb("never leaks another tenant's deliveries through the log", async () => {
    const a = await tenant();
    const b = await tenant();
    await createWebhookEndpoint(a.actor, { url: "https://a.example.com/hook", events: ["lead.created"] });
    await createWebhookEndpoint(b.actor, { url: "https://b.example.com/hook", events: ["lead.created"] });
    await fanOutTenantEvent({ businessId: a.business.id, topic: "lead.created", payload: {}, idempotencyKey: "lead.created:tenant-a" });
    await fanOutTenantEvent({ businessId: b.business.id, topic: "lead.created", payload: {}, idempotencyKey: "lead.created:tenant-b" });
    const logA = await listWebhookDeliveries(a.business.id, {});
    expect(logA).toHaveLength(1);
    const [endpointA] = await db.select().from(webhookEndpoints).where(eq(webhookEndpoints.businessId, a.business.id));
    expect(logA[0].endpointId).toBe(endpointA.id);
    expect((await listWebhookDeliveries(b.business.id, {}))).toHaveLength(1);
  });

  itDb("delivery tick survives an undecryptable secret without crashing", async () => {
    const { business, actor } = await tenant();
    const endpoint = await createWebhookEndpoint(actor, { url: "https://x.example.com/hook", events: ["lead.created"] });
    await db.update(webhookEndpoints).set({ secretCiphertext: "corrupted.value.here" }).where(eq(webhookEndpoints.id, endpoint.id));
    await fanOutTenantEvent({ businessId: business.id, topic: "lead.created", payload: {}, idempotencyKey: "lead.created:corrupt" });
    const result = await runWebhookDeliveryTick();
    expect(result.dead).toBe(1);
    const [row] = await db
      .select()
      .from(webhookDeliveries)
      .where(and(eq(webhookDeliveries.endpointId, endpoint.id), eq(webhookDeliveries.idempotencyKey, "lead.created:corrupt")));
    expect(row).toMatchObject({ status: "dead", lastError: "secret_undecryptable" });
  });

  itDb("delivery timeout is recorded as a failure, not a success", async () => {
    const { business, actor } = await tenant();
    await createWebhookEndpoint(actor, { url: "https://slow.example.com/hook", events: ["lead.created"] });
    await fanOutTenantEvent({ businessId: business.id, topic: "lead.created", payload: {}, idempotencyKey: "lead.created:slow" });
    receiver(["timeout"]);
    const result = await runWebhookDeliveryTick();
    expect(result).toMatchObject({ failed: 1, delivered: 0 });
    const [row] = await db.select().from(webhookDeliveries).where(eq(webhookDeliveries.businessId, business.id));
    expect(row.lastError).toBe("timeout");
  });
});

describe.skipIf(!hasTestDatabase())("outbox handler wiring", () => {
  beforeAll(async () => {
    await ensureDbReady();
    await truncateAll();
  });
  afterAll(async () => {
    await truncateAll();
    await closeDb();
  });
  beforeEach(async () => {
    await truncateAll();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  itDb("queues a notification for notification.requested events", async () => {
    resetOutboxHandlers();
    resetDefaultOutboxHandlers();
    registerDefaultOutboxHandlers();
    const business = await createBusiness();
    const { enqueueOutbox: enqueue, runOutboxWorkerTick: tick } = await import("@/lib/services/outbox");
    await db.transaction(async (tx) => {
      await enqueue(tx, {
        businessId: business.id,
        topic: "notification.requested",
        idempotencyKey: "notification.requested:test-1",
        payload: { businessId: business.id, type: "system", title: "اعلان آزمایشی", message: "پیام آزمایشی", userId: null, channel: "internal" },
      });
    });
    await tick();
    const { notifications } = await import("@/db/schema");
    const rows = await db.select().from(notifications).where(eq(notifications.businessId, business.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ title: "اعلان آزمایشی", status: "SENT", channel: "internal" });
  });

});
