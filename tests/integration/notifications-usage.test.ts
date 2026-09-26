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
