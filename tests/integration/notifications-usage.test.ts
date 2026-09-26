import { afterAll, beforeAll, describe, expect } from "vitest";
import { closeDb } from "@/db";
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
