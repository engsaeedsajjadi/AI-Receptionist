import { afterAll, beforeAll, describe, expect, vi } from "vitest";
import { closeDb } from "@/db";

// Throwing-provider fixture: the sms channel throws instead of returning a
// result, pinning notify()'s fail-closed guard. All other channels delegate
// to the real providers, so the rest of this file is unaffected.
vi.mock("@/lib/providers/notifications", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/providers/notifications")>();
  return {
    ...real,
    getNotificationProvider: (channel: string) => {
      if (channel === "sms") {
        return {
          channel,
          send: async () => {
            throw new Error("boom-transport");
          },
        };
      }
      return real.getNotificationProvider(channel as never);
    },
  };
});
import { ensureDbReady, hasTestDatabase, itDb, truncateAll } from "../helpers/db";
import { createBusiness } from "../helpers/fixtures";

const runIntegration = hasTestDatabase();

describe.skipIf(!runIntegration)("notifications + usage idempotency (real database)", () => {
  let businessId: string;

  beforeAll(async () => {
    if (!(await ensureDbReady())) return;
    await truncateAll();
    businessId = (await createBusiness("Notify Biz")).id;
  });

  afterAll(async () => {
    if (runIntegration) {
      await truncateAll().catch(() => undefined);
      await closeDb();
    }
  });

  itDb("concurrent same-key notifications collapse to one row", async () => {
    const { notify } = await import("@/lib/services/notifications");
    const { db } = await import("@/db");
    const { notifications } = await import("@/db/schema");
    const { and, eq } = await import("drizzle-orm");
    const key = `race-${Date.now()}`;
    const input = {
      businessId,
      type: "test",
      title: "Race",
      message: "M",
      idempotencyKey: key,
      channel: "internal" as const,
    };
    const [a, b] = await Promise.all([notify(input), notify(input)]);
    expect([a.duplicate, b.duplicate].sort()).toEqual([false, true]);
    expect(a.id).toBe(b.id);
    const rows = await db
      .select()
      .from(notifications)
      .where(and(eq(notifications.businessId, businessId), eq(notifications.idempotencyKey, key)));
    expect(rows).toHaveLength(1);
  });

  itDb("delivers the same notification once for an idempotency key", async () => {
    const { notify } = await import("@/lib/services/notifications");
    const first = await notify({
      businessId,
      type: "test",
      title: "T",
      message: "M",
      idempotencyKey: "idem-1",
      channel: "internal",
    });
    const second = await notify({
      businessId,
      type: "test",
      title: "T",
      message: "M",
      idempotencyKey: "idem-1",
      channel: "internal",
    });
    expect(first.delivered).toBe(true);
    expect(first.duplicate).toBe(false);
    expect(second.id).toBe(first.id);
    expect(second.duplicate).toBe(true);
  });

  itDb("records usage once for an idempotency key", async () => {
    const { recordUsage } = await import("@/lib/services/usage");
    const first = await recordUsage({
      businessId,
      type: "calls",
      quantity: 1,
      unit: "count",
      idempotencyKey: "usage-1",
    });
    const second = await recordUsage({
      businessId,
      type: "calls",
      quantity: 1,
      unit: "count",
      idempotencyKey: "usage-1",
    });
    expect(first.recorded).toBe(true);
    expect(second.recorded).toBe(false);
  });

  itDb("email without SMTP fails closed with a recorded error", async () => {
    const { notify } = await import("@/lib/services/notifications");
    const { db } = await import("@/db");
    const { notifications } = await import("@/db/schema");
    const { eq } = await import("drizzle-orm");
    const key = `email-fail-${Date.now()}`;
    const result = await notify({
      businessId,
      type: "test",
      title: "No SMTP",
      message: "M",
      channel: "email",
      recipient: "ops@example.com",
      idempotencyKey: key,
    });
    expect(result.delivered).toBe(false);
    expect(result.duplicate).toBe(false);
    const [row] = await db.select().from(notifications).where(eq(notifications.id, result.id)).limit(1);
    expect(row.status).toBe("FAILED");
    expect(row.errorMessage).toMatch(/SMTP/i);
  });

  itDb("duplicate of a FAILED key is honest (no silent retry, no second row)", async () => {
    const { notify } = await import("@/lib/services/notifications");
    const { db } = await import("@/db");
    const { notifications } = await import("@/db/schema");
    const { and, eq } = await import("drizzle-orm");
    const key = `email-faildup-${Date.now()}`;
    const input = {
      businessId,
      type: "test",
      title: "T",
      message: "M",
      channel: "email" as const,
      recipient: "ops@example.com",
      idempotencyKey: key,
    };
    await notify(input);
    const second = await notify(input);
    expect(second).toMatchObject({ delivered: false, duplicate: true });
    const rows = await db
      .select()
      .from(notifications)
      .where(and(eq(notifications.businessId, businessId), eq(notifications.idempotencyKey, key)));
    expect(rows).toHaveLength(1);
  });

  itDb("throwing provider is recorded FAILED, never thrown or stuck PENDING", async () => {
    const { notify } = await import("@/lib/services/notifications");
    const { db } = await import("@/db");
    const { notifications } = await import("@/db/schema");
    const { eq } = await import("drizzle-orm");
    const result = await notify({
      businessId,
      type: "test",
      title: "Throw",
      message: "M",
      channel: "sms",
      recipient: "+989121234567",
    });
    expect(result.delivered).toBe(false);
    const [row] = await db.select().from(notifications).where(eq(notifications.id, result.id)).limit(1);
    expect(row.status).toBe("FAILED");
    expect(row.errorMessage).toBe("boom-transport");
  });

  itDb("retryNotification re-attempts FAILED only; concurrent retries collapse", async () => {
    const { notify, retryNotification } = await import("@/lib/services/notifications");
    const { db } = await import("@/db");
    const { notifications } = await import("@/db/schema");
    const { eq } = await import("drizzle-orm");
    const failed = await notify({
      businessId,
      type: "test",
      title: "Retry me",
      message: "M",
      channel: "email",
      recipient: "ops@example.com",
    });
    expect(failed.delivered).toBe(false);
    // Still no SMTP: the retry honestly fails again (attempt was made).
    const retried = await retryNotification(businessId, failed.id);
    expect(retried).toMatchObject({ id: failed.id, delivered: false, duplicate: false });

    // Non-FAILED rows are not retryable.
    const sent = await notify({
      businessId,
      type: "test",
      title: "Sent",
      message: "M",
      channel: "internal",
    });
    expect(sent.delivered).toBe(true);
    await expect(retryNotification(businessId, sent.id)).rejects.toMatchObject({ code: "CONFLICT" });

    // Concurrent retries: exactly one attempt runs.
    const pair = await Promise.allSettled([
      retryNotification(businessId, failed.id),
      retryNotification(businessId, failed.id),
    ]);
    expect(pair.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(pair.filter((r) => r.status === "rejected")).toHaveLength(1);
    const [row] = await db.select().from(notifications).where(eq(notifications.id, failed.id)).limit(1);
    expect(row.status).toBe("FAILED");
  });

  itDb("reaper fails stale PENDING rows and spares fresh ones", async () => {
    const { reapStaleNotifications } = await import("@/lib/services/notifications");
    const { db } = await import("@/db");
    const { notifications } = await import("@/db/schema");
    const { eq } = await import("drizzle-orm");
    const [stale] = await db
      .insert(notifications)
      .values({
        businessId,
        type: "test",
        channel: "email",
        title: "Stuck",
        message: "M",
        status: "PENDING",
        createdAt: new Date(Date.now() - 3600_000),
      })
      .returning();
    const [fresh] = await db
      .insert(notifications)
      .values({
        businessId,
        type: "test",
        channel: "email",
        title: "Fresh",
        message: "M",
        status: "PENDING",
      })
      .returning();
    expect(await reapStaleNotifications(600)).toEqual({ reaped: 1 });
    const [staleRow] = await db.select().from(notifications).where(eq(notifications.id, stale.id)).limit(1);
    expect(staleRow.status).toBe("FAILED");
    expect(staleRow.errorMessage).toBe("delivery_unconfirmed");
    const [freshRow] = await db.select().from(notifications).where(eq(notifications.id, fresh.id)).limit(1);
    expect(freshRow.status).toBe("PENDING");
    expect(await reapStaleNotifications(3600)).toEqual({ reaped: 0 });
  });

  itDb("estimates cost on usage rows", async () => {
    const { recordUsage } = await import("@/lib/services/usage");
    const { costUsd } = await recordUsage({
      businessId,
      type: "llm_input_tokens",
      quantity: 1000,
      unit: "token",
      provider: "openai",
    });
    expect(costUsd).toBeGreaterThan(0);
  });
});
