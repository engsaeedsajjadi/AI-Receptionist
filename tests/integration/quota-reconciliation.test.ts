import { beforeAll, afterAll, describe, expect } from "vitest";
import { NextRequest } from "next/server";
import { and, eq } from "drizzle-orm";
import { db, closeDb } from "@/db";
import { auditLogs, businesses, quotaBuckets, quotaReservations, users } from "@/db/schema";
import { issueAuthTokens } from "@/lib/auth";
import { reserveUsage, settleUsage, reconcileQuotaReservation, listQuotaReservations } from "@/lib/services/quotas";
import { GET, POST } from "@/app/api/v1/platform/quota-reservations/route";
import { createBusiness, createUser } from "../helpers/fixtures";
import { ensureDbReady, hasTestDatabase, itDb, truncateAll } from "../helpers/db";

const req = (token: string, body?: unknown, query = "") => new NextRequest(`http://localhost/api/v1/platform/quota-reservations${query}`, {
  method: body ? "POST" : "GET", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "x-real-ip": crypto.randomUUID() },
  ...(body ? { body: JSON.stringify(body) } : {}),
});
async function setup() {
  const target = await createBusiness(), platform = await createBusiness();
  const { user } = await createUser(platform.id);
  await db.update(users).set({ role: "SUPER_ADMIN", mfaEnabled: true }).where(eq(users.id, user.id));
  const token = (await issueAuthTokens({ userId: user.id, businessId: platform.id, role: "SUPER_ADMIN" })).accessToken;
  return { businessId: target.id, actorId: user.id, token };
}
async function oldReservation(businessId: string, key = crypto.randomUUID()) {
  const result = await reserveUsage(businessId, key, { tts_characters: 10 }, new Date("2020-01-31T23:59:59Z"));
  await db.update(quotaReservations).set({ createdAt: new Date(Date.now() - 3600_000) }).where(eq(quotaReservations.id, result.id));
  return result;
}
const release = (businessId: string, id: string) => ({ businessId, id, action: "release", reason: "Provider confirmed no execution", evidenceReference: "support-ticket-123", executionStopped: true, noUsageConfirmed: true });
const settle = (businessId: string, id: string, amount = 7) => ({ businessId, id, action: "settle", reason: "Provider confirmed billed usage", evidenceReference: "provider-request-123", executionStopped: true, actual: { tts_characters: amount } });
async function events(id: string) {
  return db.select().from(auditLogs).where(and(eq(auditLogs.entityId, id), eq(auditLogs.action, "quota.reservation_reconciled")));
}
describe.skipIf(!hasTestDatabase())("operator quota reconciliation", () => {
  beforeAll(async () => { await ensureDbReady(); await truncateAll(); });
  afterAll(async () => { await truncateAll(); await closeDb(); });
  itDb("requires live platform privilege and MFA for both list and write", async () => {
    const { businessId, actorId, token } = await setup(), r = await oldReservation(businessId);
    for (const change of [{ role: "ADMIN" as const, mfaEnabled: true }, { role: "SUPER_ADMIN" as const, mfaEnabled: false }]) {
      await db.update(users).set(change).where(eq(users.id, actorId));
      expect((await GET(req(token, undefined, `?businessId=${businessId}`))).status).toBe(403);
      expect((await POST(req(token, release(businessId, r.id)))).status).toBe(403);
    }
    expect(await events(r.id)).toHaveLength(0);
    expect((await db.select().from(quotaReservations).where(eq(quotaReservations.id, r.id)))[0].status).toBe("reserved");
  });
  itDb("scopes pagination to the requested tenant and only returns aged open reservations by default", async () => {
    const { businessId, actorId, token } = await setup();
    const old = await Promise.all([oldReservation(businessId), oldReservation(businessId), oldReservation(businessId)]);
    const other = await createBusiness(); await oldReservation(other.id);
    await reserveUsage(businessId, "recent", { tts_characters: 1 });
    const response = await GET(req(token, undefined, `?businessId=${businessId}&limit=2`));
    expect(response.status).toBe(200);
    const first = await response.json();
    expect(first.data).toHaveLength(2); expect(first.hasMore).toBe(true);
    const next = await listQuotaReservations(actorId, { businessId, limit: 2, after: first.nextCursor });
    expect(next.data).toHaveLength(1); expect(next.hasMore).toBe(false); expect(next.nextCursor).toBeNull();
    expect([...first.data, ...next.data].map((row: { id: string }) => row.id).sort()).toEqual(old.map(row => row.id).sort());
    expect((await GET(req(token, undefined, `?businessId=${businessId}&limit=101`))).status).toBe(400);
    expect((await GET(req(token))).status).toBe(400);
  });
  itDb("rejects recent execution, missing evidence, missing attestations and changed meter sets", async () => {
    const { businessId, token } = await setup();
    const recent = await reserveUsage(businessId, "running", { tts_characters: 10 });
    expect((await POST(req(token, release(businessId, recent.id)))).status).toBe(409);
    const old = await oldReservation(businessId);
    for (const body of [
      { ...release(businessId, old.id), reason: "short" },
      { ...release(businessId, old.id), evidenceReference: "" },
      { ...release(businessId, old.id), executionStopped: false },
      { ...release(businessId, old.id), noUsageConfirmed: false },
      { ...settle(businessId, old.id), actual: { embedding_tokens: 3 } },
      { ...settle(businessId, old.id), actual: { tts_characters: -1 } },
    ]) expect((await POST(req(token, body))).status).toBe(400);
    expect(await events(old.id)).toHaveLength(0);
  });
  itDb("settles original window exactly once under concurrency and preserves an audited overrun", async () => {
    const { businessId, actorId, token } = await setup(), r = await oldReservation(businessId);
    const responses = await Promise.all(Array.from({ length: 8 }, () => POST(req(token, settle(businessId, r.id, 14)))));
    expect(responses.every(res => res.status === 200)).toBe(true);
    const bodies = await Promise.all(responses.map(res => res.json()));
    expect(bodies.filter(body => body.changed)).toHaveLength(1);
    expect(bodies.every(body => body.overrun)).toBe(true);
    const [bucket] = await db.select().from(quotaBuckets).where(eq(quotaBuckets.businessId, businessId));
    expect(bucket.windowStart.toISOString()).toBe("2020-01-01T00:00:00.000Z");
    expect(bucket.consumed).toBe("14.0000"); expect(bucket.reserved).toBe("0.0000");
    const audit = await events(r.id); expect(audit).toHaveLength(1); expect(audit[0].actorId).toBe(actorId);
    expect(audit[0].metadata).toMatchObject({ action: "settle", overrun: true, evidenceReference: "provider-request-123" });
    expect(audit[0].requestId).toBeTruthy();
    expect((await POST(req(token, settle(businessId, r.id, 15)))).status).toBe(409);
    expect((await POST(req(token, release(businessId, r.id)))).status).toBe(409);
  });
  itDb("can release suspended tenant reservations without mutating completed history", async () => {
    const { businessId, actorId } = await setup(), r = await oldReservation(businessId);
    await db.update(businesses).set({ isActive: false }).where(eq(businesses.id, businessId));
    expect(await reconcileQuotaReservation(actorId, release(businessId, r.id))).toMatchObject({ changed: true, status: "released" });
    expect(await reconcileQuotaReservation(actorId, release(businessId, r.id))).toMatchObject({ changed: false });
    await expect(settleUsage(businessId, r.id, { tts_characters: 1 })).rejects.toMatchObject({ status: 409 });
    const [bucket] = await db.select().from(quotaBuckets).where(eq(quotaBuckets.businessId, businessId));
    expect(bucket.consumed).toBe("0.0000"); expect(bucket.reserved).toBe("0.0000");
    expect(await events(r.id)).toHaveLength(1);
  });
  itDb("rejects mismatched tenant IDs and concurrent conflicting finalizations", async () => {
    const { businessId, actorId } = await setup(), r = await oldReservation(businessId);
    const other = await createBusiness();
    await expect(reconcileQuotaReservation(actorId, release(other.id, r.id))).rejects.toMatchObject({ status: 404 });
    await expect(reconcileQuotaReservation(actorId, release(businessId, crypto.randomUUID()))).rejects.toMatchObject({ status: 404 });
    const results = await Promise.allSettled([reconcileQuotaReservation(actorId, release(businessId, r.id)), reconcileQuotaReservation(actorId, settle(businessId, r.id))]);
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter(r => r.status === "rejected")).toHaveLength(1);
    expect(await events(r.id)).toHaveLength(1);
  });
  itDb("missing accounting bucket fails without finalizing the reservation or creating audit success", async () => {
    const { businessId, actorId } = await setup(), r = await oldReservation(businessId);
    await db.delete(quotaBuckets).where(eq(quotaBuckets.businessId, businessId));
    await expect(reconcileQuotaReservation(actorId, release(businessId, r.id))).rejects.toMatchObject({ status: 409 });
    expect((await db.select().from(quotaReservations).where(eq(quotaReservations.id, r.id)))[0].status).toBe("reserved");
    expect(await events(r.id)).toHaveLength(0);
  });
});
