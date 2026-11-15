import { metrics } from "@/lib/telemetry";
import { beforeAll, afterAll, describe, expect, vi } from "vitest";
import { NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { closeDb, db } from "@/db";
import { agents, auditLogs, businesses, quotaBuckets, quotaOverrides, quotaReservations, subscriptions, users } from "@/db/schema";
import { AppError } from "@/lib/errors";
import { issueAuthTokens } from "@/lib/auth";
import { reserveUsage, settleUsage, releaseUsage, getQuotaStatus, withUsageReservation, inventoryQuota } from "@/lib/services/quotas";
import { meteredCompletion, meteredEmbeddings, meteredSpeech } from "@/lib/services/metered-ai";
import { PATCH as override } from "@/app/api/v1/platform/quotas/route";
import { GET as status } from "@/app/api/v1/billing/quotas/route";
import { POST as activate } from "@/app/api/v1/agents/[id]/activate/route";
import { createBusiness, createUser } from "../helpers/fixtures";
import { ensureDbReady, hasTestDatabase, itDb, truncateAll } from "../helpers/db";
const limit = (hard: number | null, soft: number | null = null, grace = 0) => ({ hard, soft, grace });
const req = (token: string, body?: unknown) => new NextRequest("http://localhost/api/v1/platform/quotas", { method: body ? "PATCH" : "GET", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "x-real-ip": crypto.randomUUID() }, ...(body ? { body: JSON.stringify(body) } : {}) });
async function tenant(policy: typeof quotaOverrides.$inferInsert.policy = {}) {
  const business = await createBusiness(); await db.insert(quotaOverrides).values({ businessId: business.id, policy }); return business.id;
}
describe.skipIf(!hasTestDatabase())("quota admission and settlement", () => {
  beforeAll(async () => { await ensureDbReady(); await truncateAll(); });
  afterAll(async () => { vi.unstubAllEnvs(); await truncateAll(); await closeDb(); });
  itDb("concurrent admission never allocates beyond hard limit plus grace", async () => {
    const id = await tenant({ tts_characters: limit(10, 6, 2) });
    const results = await Promise.allSettled(Array.from({ length: 12 }, (_, i) => reserveUsage(id, `concurrent-${i}`, { tts_characters: 3 })));
    const accepted = results.filter((result) => result.status === "fulfilled"); expect(accepted).toHaveLength(4);
    expect(results.filter(result => result.status === "rejected")).toHaveLength(8);
    const meter = (await getQuotaStatus(id)).meters.find(m => m.meter === "tts_characters")!;
    expect(meter.reserved).toBe("12.0000"); expect(meter.warning).toBe(true);
    const counter = await metrics().quotaRejections.get();
    expect(counter.values.some(value => value.labels.meter === "tts_characters" && value.value >= 8)).toBe(true);
  });
  itDb("multi-meter rejection rolls back every preceding allocation", async () => {
    const id = await tenant({ llm_input_tokens: limit(100), llm_output_tokens: limit(0) });
    await expect(reserveUsage(id, "atomic", { llm_input_tokens: 50, llm_output_tokens: 1 })).rejects.toMatchObject({ code: "QUOTA_EXCEEDED" });
    expect(await db.select().from(quotaBuckets).where(eq(quotaBuckets.businessId, id))).toHaveLength(0);
    expect(await db.select().from(quotaReservations).where(eq(quotaReservations.businessId, id))).toHaveLength(0);
  });
  itDb("retry keys cannot double execute or change amounts; settlement and release are idempotent", async () => {
    const id = await tenant({ tts_characters: limit(100) });
    const first = await reserveUsage(id, "key", { tts_characters: 20 });
    expect((await reserveUsage(id, "key", { tts_characters: 20 })).reused).toBe(true);
    await expect(reserveUsage(id, "key", { tts_characters: 21 })).rejects.toMatchObject({ status: 409 });
    const execute = vi.fn();
    await expect(withUsageReservation(id, { tts_characters: 20 }, execute, () => ({ tts_characters: 0 }), "key")).rejects.toMatchObject({ status: 409 });
    expect(execute).not.toHaveBeenCalled();
    await settleUsage(id, first.id, { tts_characters: 12 }); await settleUsage(id, first.id, { tts_characters: 12 });
    await expect(settleUsage(id, first.id, { tts_characters: 13 })).rejects.toMatchObject({ status: 409 });
    await expect(releaseUsage(id, first.id)).rejects.toMatchObject({ status: 409 });
    const second = await reserveUsage(id, "release", { tts_characters: 30 });
    await releaseUsage(id, second.id); await releaseUsage(id, second.id);
    const meter = (await getQuotaStatus(id)).meters.find(m => m.meter === "tts_characters")!;
    expect(meter.consumed).toBe("12.0000"); expect(meter.reserved).toBe("0.0000");
  });
  itDb("old-window settlement never consumes the new month; tenants cannot finalize foreign reservations", async () => {
    const a = await tenant(), b = await tenant();
    const reservation = await reserveUsage(a, "old", { embedding_tokens: 100 }, new Date("2020-01-31T23:59:59Z"));
    await expect(releaseUsage(b, reservation.id)).rejects.toMatchObject({ status: 404 });
    await expect(settleUsage(a, reservation.id, { tts_characters: 2 })).rejects.toMatchObject({ status: 400 });
    await settleUsage(a, reservation.id, { embedding_tokens: 20 });
    const [bucket] = await db.select().from(quotaBuckets).where(eq(quotaBuckets.businessId, a));
    expect(bucket.windowStart.toISOString()).toBe("2020-01-01T00:00:00.000Z"); expect(bucket.consumed).toBe("20.0000");
    expect((await getQuotaStatus(a)).meters.find(m => m.meter === "embedding_tokens")!.consumed).toBe("0.0000");
  });
  itDb("failed execution releases allowance; uncertain timeout stays held; overruns remain accounted", async () => {
    const id = await tenant({ tts_characters: limit(10) });
    await expect(withUsageReservation(id, { tts_characters: 5 }, async () => { throw new Error("definitive failure"); }, () => ({ tts_characters: 0 }))).rejects.toThrow("definitive failure");
    expect((await getQuotaStatus(id)).meters.find(m => m.meter === "tts_characters")!.reserved).toBe("0.0000");
    await expect(withUsageReservation(id, { tts_characters: 5 }, async () => { throw new AppError(504, "PROVIDER_TIMEOUT", "unknown outcome"); }, () => ({ tts_characters: 0 }))).rejects.toMatchObject({ status: 504 });
    expect((await getQuotaStatus(id)).meters.find(m => m.meter === "tts_characters")!.reserved).toBe("5.0000");
    await expect(withUsageReservation(id, { tts_characters: 5 }, async () => 12, value => ({ tts_characters: value }))).rejects.toMatchObject({ status: 502 });
    expect((await getQuotaStatus(id)).meters.find(m => m.meter === "tts_characters")!.consumed).toBe("12.0000");
    const events = await db.select().from(auditLogs).where(eq(auditLogs.businessId, id)); expect(events[0].action).toBe("quota.provider_overrun");
  });
  itDb("inventory creation is atomic and deactivation restores capacity without resetting usage", async () => {
    const id = await tenant({ active_agents: limit(2) });
    const results = await Promise.allSettled(Array.from({ length: 8 }, () => db.transaction(async tx => {
      await inventoryQuota(tx, id, "active_agents", 1); return tx.insert(agents).values({ businessId: id, name: "Quota test", systemPrompt: "test" }).returning();
    })));
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(2);
    const [agent] = await db.select().from(agents).where(eq(agents.businessId, id));
    await db.update(agents).set({ isActive: false }).where(eq(agents.id, agent.id));
    await db.transaction(async tx => { await inventoryQuota(tx, id, "active_agents", 1); await tx.insert(agents).values({ businessId: id, name: "replacement", systemPrompt: "test" }); });
    const { user } = await createUser(id); const token = (await issueAuthTokens({ userId: user.id, businessId: id, role: "ADMIN" })).accessToken;
    expect((await activate(req(token), { params: Promise.resolve({ id: agent.id }) })).status).toBe(402);
  });
  itDb("only MFA-enabled platform administrators can override caps; writes are audited and merged", async () => {
    const id = await tenant({ tts_characters: limit(2) }), operatorTenant = await tenant();
    const { user } = await createUser(operatorTenant);
    const token = (await issueAuthTokens({ userId: user.id, businessId: operatorTenant, role: "ADMIN" })).accessToken;
    const body = { businessId: id, policy: { embedding_tokens: limit(20) }, reason: "Approved tenant allowance" };
    expect((await override(req(token, body))).status).toBe(403);
    await db.update(users).set({ role: "SUPER_ADMIN" }).where(eq(users.id, user.id));
    expect((await override(req(token, body))).status).toBe(403);
    await db.update(users).set({ mfaEnabled: true }).where(eq(users.id, user.id));
    expect((await override(req(token, body))).status).toBe(200);
    const [saved] = await db.select().from(quotaOverrides).where(eq(quotaOverrides.businessId, id));
    expect(saved.policy.tts_characters.hard).toBe(2); expect(saved.policy.embedding_tokens.hard).toBe(20);
    expect((await status(req(token))).status).toBe(200);
    expect((await db.select().from(auditLogs).where(eq(auditLogs.businessId, id)))[0].action).toBe("quota.override_changed");
  });
  itDb("provider wrappers settle actual usage and refuse calls before provider execution", async () => {
    const id = await tenant({ llm_output_tokens: limit(10), tts_characters: limit(3) });
    const complete = vi.fn(async () => ({ content: "ok", toolCalls: [], finishReason: "stop", usage: { inputTokens: 2, outputTokens: 3 }, model: "test", latencyMs: 1 }));
    await meteredCompletion(id, { name: "test", complete }, [{ role: "user", content: "hello" }], { maxTokens: 10 });
    await expect(meteredCompletion(id, { name: "test", complete }, [], { maxTokens: 10 })).rejects.toMatchObject({ status: 402 });
    expect(complete).toHaveBeenCalledTimes(1); expect(complete.mock.calls[0]).toBeDefined();
    const synthesize = vi.fn(); await expect(meteredSpeech(id, { name: "test", synthesize }, "long text")).rejects.toMatchObject({ status: 402 }); expect(synthesize).not.toHaveBeenCalled();
    const embedMany = vi.fn(async () => [{ embedding: [1], usage: { embeddingTokens: 2 }, model: "test", dimensions: 1 }]);
    await meteredEmbeddings(id, { name: "test", embed: vi.fn(), embedMany }, ["hello"]);
    expect((await getQuotaStatus(id)).meters.find(m => m.meter === "embedding_tokens")!.consumed).toBe("2.0000");
  });
  itDb("plan changes and expiry keep consumed allowance instead of resetting the month", async () => {
    vi.stubEnv("QUOTA_PLANS_JSON", JSON.stringify({ FREE: { tts_characters: limit(1) }, STARTER: { tts_characters: limit(10) } }));
    try {
      const id = await tenant();
      await expect(reserveUsage(id, "free-denied", { tts_characters: 3 })).rejects.toMatchObject({ status: 402 });
      await db.insert(subscriptions).values({ businessId: id, plan: "STARTER", periodStart: new Date(), periodEnd: new Date(Date.now() + 86400_000) });
      const reservation = await reserveUsage(id, "paid", { tts_characters: 3 });
      await settleUsage(id, reservation.id, { tts_characters: 2 });
      expect((await getQuotaStatus(id)).plan).toBe("STARTER");
      await db.update(subscriptions).set({ periodStart: new Date("2020-01-01Z"), periodEnd: new Date("2020-02-01Z") }).where(eq(subscriptions.businessId, id));
      expect((await getQuotaStatus(id)).plan).toBe("FREE");
      await expect(reserveUsage(id, "expired", { tts_characters: 1 })).rejects.toMatchObject({ status: 402 });
      expect((await getQuotaStatus(id)).meters.find(m => m.meter === "tts_characters")!.consumed).toBe("2.0000");
    } finally { vi.unstubAllEnvs(); }
  });
  itDb("inactive tenants cannot reserve; settled in-flight usage can still finalize", async () => {
    const id = await tenant(); const reservation = await reserveUsage(id, "in-flight", { tts_characters: 2 });
    await db.update(businesses).set({ isActive: false }).where(eq(businesses.id, id));
    await expect(reserveUsage(id, "after-suspension", { tts_characters: 1 })).rejects.toMatchObject({ status: 403 });
    expect(await settleUsage(id, reservation.id, { tts_characters: 1 })).toEqual({ overrun: false });
  });
});
