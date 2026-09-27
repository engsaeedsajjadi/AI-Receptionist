import { afterAll, beforeAll, describe, expect } from "vitest";
import { and, eq } from "drizzle-orm";
import { closeDb, db } from "@/db";
import { calls, notifications } from "@/db/schema";
import { ensureDbReady, hasTestDatabase, itDb, truncateAll } from "../helpers/db";
import { createBusiness } from "../helpers/fixtures";

const runIntegration = hasTestDatabase();
let seq = 0;

/** Render settled race outcomes for failure diagnostics (printed only on mismatch). */
function fmtSettled(results: PromiseSettledResult<unknown>[]): string {
  return JSON.stringify(
    results.map((r) =>
      r.status === "fulfilled"
        ? { status: "fulfilled", value: r.value }
        : {
            status: "rejected",
            code: (r.reason as { code?: unknown })?.code,
            httpStatus: (r.reason as { status?: unknown })?.status,
            message: r.reason instanceof Error ? r.reason.message : String(r.reason),
          },
    ),
  );
}

async function seedCall(
  businessId: string,
  overrides: Partial<typeof calls.$inferInsert> = {},
) {
  const [row] = await db
    .insert(calls)
    .values({
      businessId,
      externalCallId: `handoff-${Date.now()}-${seq++}`,
      phoneNumber: "09123456789",
      status: "IN_PROGRESS",
      ...overrides,
    })
    .returning();
  return row;
}

describe.skipIf(!runIntegration)("handoff state machine (real database)", () => {
  let businessId: string;

  beforeAll(async () => {
    if (!(await ensureDbReady())) return;
    await truncateAll();
    businessId = (await createBusiness("Handoff Biz")).id;
  });

  afterAll(async () => {
    if (runIntegration) {
      await truncateAll().catch(() => undefined);
      await closeDb();
    }
  });

  itDb("transitionCall rejects illegal transitions and leaves state untouched", async () => {
    const { transitionCall } = await import("@/lib/services/calls");
    const call = await seedCall(businessId, { status: "COMPLETED" });
    await expect(transitionCall(businessId, call.id, "IN_PROGRESS")).rejects.toMatchObject({
      status: 409,
      code: "CONFLICT",
    });
    const [row] = await db.select().from(calls).where(eq(calls.id, call.id)).limit(1);
    expect(row.status).toBe("COMPLETED");
  });

  itDb("concurrent transitions serialize: exactly one wins", async () => {
    const { transitionCall } = await import("@/lib/services/calls");
    const call = await seedCall(businessId, { status: "IN_PROGRESS" });
    const results = await Promise.allSettled([
      transitionCall(businessId, call.id, "COMPLETED"),
      transitionCall(businessId, call.id, "TRANSFER_REQUESTED"),
    ]);
    expect(results.filter((r) => r.status === "fulfilled"), fmtSettled(results)).toHaveLength(1);
    const rejected = results.filter((r) => r.status === "rejected");
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({ code: "CONFLICT" });
    // Cleanup: a TRANSFER_REQUESTED winner must not pollute the reaper test.
    await db.delete(calls).where(eq(calls.id, call.id));
  });

  itDb("transfer with dev voice provider fails honestly + notifies + registers callback", async () => {
    const { requestTransfer } = await import("@/lib/services/calls");
    const call = await seedCall(businessId, { status: "IN_PROGRESS" });
    const result = await requestTransfer(businessId, call.id, { destination: "09123456760" });
    expect(result.status).toBe("TRANSFER_FAILED");
    expect(result.destination).toBe("09123456760");
    expect(result.message).toContain("پیگیری");
    const [row] = await db.select().from(calls).where(eq(calls.id, call.id)).limit(1);
    expect(row.status).toBe("TRANSFER_FAILED");
    expect(row.transferTo).toBe("09123456760");
    const notifs = await db
      .select({ type: notifications.type })
      .from(notifications)
      .where(eq(notifications.businessId, businessId));
    const types = notifs.map((n) => n.type);
    expect(types).toContain("human_handoff");
    expect(types.filter((t) => t === "callback_requested")).toHaveLength(1);
  });

  itDb("transfer without any destination fails closed with a callback", async () => {
    const { requestTransfer } = await import("@/lib/services/calls");
    const call = await seedCall(businessId, { status: "IN_PROGRESS" });
    const result = await requestTransfer(businessId, call.id, {});
    expect(result.status).toBe("TRANSFER_FAILED");
    expect(result.destination).toBeNull();
    const [row] = await db.select().from(calls).where(eq(calls.id, call.id)).limit(1);
    expect(row.status).toBe("TRANSFER_FAILED");
    expect(row.transferTo).toBeNull();
  });

  itDb("transfer on a finished call is 409 and changes nothing", async () => {
    const { requestTransfer } = await import("@/lib/services/calls");
    const call = await seedCall(businessId, { status: "COMPLETED" });
    await expect(requestTransfer(businessId, call.id, { destination: "09123456760" })).rejects.toMatchObject({
      status: 409,
      code: "TRANSFER_UNAVAILABLE",
    });
    const [row] = await db.select().from(calls).where(eq(calls.id, call.id)).limit(1);
    expect(row.status).toBe("COMPLETED");
  });

  itDb("concurrent transfers: one proceeds, the other gets TRANSFER_IN_PROGRESS", async () => {
    const { requestTransfer } = await import("@/lib/services/calls");
    const call = await seedCall(businessId, { status: "IN_PROGRESS" });
    const results = await Promise.allSettled([
      requestTransfer(businessId, call.id, { destination: "09123456760" }),
      requestTransfer(businessId, call.id, { destination: "09123456761" }),
    ]);
    const won = results.filter((r) => r.status === "fulfilled");
    const lost = results.filter((r) => r.status === "rejected");
    expect(won, fmtSettled(results)).toHaveLength(1);
    expect(lost, fmtSettled(results)).toHaveLength(1);
    expect((lost[0] as PromiseRejectedResult).reason).toMatchObject({ code: "TRANSFER_IN_PROGRESS" });
    // Single callback registration despite two attempts (stable key).
    const callbacks = await db
      .select({ id: notifications.id })
      .from(notifications)
      .where(
        and(
          eq(notifications.businessId, businessId),
          eq(notifications.type, "callback_requested"),
          eq(notifications.idempotencyKey, `callback:${call.id}`),
        ),
      );
    expect(callbacks).toHaveLength(1);
  });

  itDb("TRANSFER_FAILED allows operator retry (no wedged state)", async () => {
    const { requestTransfer } = await import("@/lib/services/calls");
    const call = await seedCall(businessId, { status: "TRANSFER_FAILED" });
    const result = await requestTransfer(businessId, call.id, { destination: "09123456760" });
    // Dev provider still fails — but the claim was accepted (no 409).
    expect(result.status).toBe("TRANSFER_FAILED");
  });

  itDb("reaper fails stuck transfers and spares fresh ones", async () => {
    const { reapStuckTransfers } = await import("@/lib/services/calls");
    const stuck = await seedCall(businessId, {
      status: "TRANSFERRING",
      transferRequestedAt: new Date(Date.now() - 3600_000),
    });
    const fresh = await seedCall(businessId, {
      status: "TRANSFERRING",
      transferRequestedAt: new Date(),
    });
    const first = await reapStuckTransfers(300);
    expect(first.reaped).toBeGreaterThanOrEqual(1);
    const [stuckRow] = await db.select().from(calls).where(eq(calls.id, stuck.id)).limit(1);
    expect(stuckRow.status).toBe("TRANSFER_FAILED");
    const [freshRow] = await db.select().from(calls).where(eq(calls.id, fresh.id)).limit(1);
    expect(freshRow.status).toBe("TRANSFERRING");
    const callbacks = await db
      .select({ id: notifications.id })
      .from(notifications)
      .where(
        and(
          eq(notifications.businessId, businessId),
          eq(notifications.type, "callback_requested"),
          eq(notifications.idempotencyKey, `callback:${stuck.id}`),
        ),
      );
    expect(callbacks).toHaveLength(1);
    // Second run reaps `fresh` (now stale-eligible); the conditional claim
    // makes re-reaping `stuck` impossible. Counts stay >= so other files'
    // future transfer rows could never break this test — per-row states
    // are the precise assertions.
    expect((await reapStuckTransfers(0)).reaped).toBeGreaterThanOrEqual(1);
    const [freshRow2] = await db.select().from(calls).where(eq(calls.id, fresh.id)).limit(1);
    expect(freshRow2.status).toBe("TRANSFER_FAILED");
  });
});
