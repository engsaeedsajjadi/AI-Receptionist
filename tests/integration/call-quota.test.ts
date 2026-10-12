import { beforeAll, afterAll, describe, expect } from "vitest";
import { NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { db, closeDb } from "@/db";
import { agents, calls, quotaOverrides, webhookEvents } from "@/db/schema";
import { registerInboundCall } from "@/lib/services/call-admission";
import { getQuotaStatus } from "@/lib/services/quotas";
import { runAgentTurn } from "@/lib/services/agent";
import { computeHmacHex } from "@/lib/security";
import { POST } from "@/app/api/v1/webhooks/voice/call-started/route";
import { createBusiness, createAgent } from "../helpers/fixtures";
import { ensureDbReady, hasTestDatabase, itDb, truncateAll } from "../helpers/db";
function request(body: unknown, key: string) {
  const raw = JSON.stringify(body);
  return new NextRequest("http://localhost/api/v1/webhooks/voice/call-started", { method: "POST", body: raw,
    headers: { "Content-Type": "application/json", "x-idempotency-key": key, "x-webhook-signature": computeHmacHex("dev-webhook-secret", raw), "x-real-ip": crypto.randomUUID() } });
}
describe.skipIf(!hasTestDatabase())("call admission quotas", () => {
  beforeAll(async () => { await ensureDbReady(); await truncateAll(); });
  afterAll(async () => { await truncateAll(); await closeDb(); });
  itDb("rejected admission rolls back the event key and succeeds on same-key retry after override", async () => {
    const business = await createBusiness();
    await db.insert(quotaOverrides).values({ businessId: business.id, policy: { calls: { hard: 0, soft: null, grace: 0 } } });
    const body = { business_id: business.id, external_call_id: "same-call", phone_number: "09123456789" }, key = crypto.randomUUID();
    expect((await POST(request(body, key))).status).toBe(402);
    expect(await db.select().from(calls).where(eq(calls.businessId, business.id))).toHaveLength(0);
    expect(await db.select().from(webhookEvents).where(eq(webhookEvents.businessId, business.id))).toHaveLength(0);
    await db.update(quotaOverrides).set({ policy: { calls: { hard: 1, soft: null, grace: 0 } } }).where(eq(quotaOverrides.businessId, business.id));
    const accepted = await POST(request(body, key)); expect(accepted.status).toBe(200);
    expect((await accepted.json()).duplicate).toBe(false);
    const repeated = await POST(request(body, key)); expect(repeated.status).toBe(200); expect((await repeated.json()).duplicate).toBe(true);
    expect((await POST(request({ ...body, external_call_id: "different-call" }, key))).status).toBe(409);
    expect((await getQuotaStatus(business.id)).meters.find(m => m.meter === "calls")!.consumed).toBe("1.0000");
  });
  itDb("concurrent distinct calls share one cap; duplicate external calls never consume twice", async () => {
    const business = await createBusiness();
    await db.insert(quotaOverrides).values({ businessId: business.id, policy: { calls: { hard: 2, soft: null, grace: 0 } } });
    const input = { businessId: business.id, phoneNumber: "09123456789", direction: "INBOUND" as const, metadata: {} };
    const results = await Promise.allSettled(Array.from({ length: 8 }, (_, i) => registerInboundCall({ ...input, externalCallId: `call-${i}`, idempotencyKey: crypto.randomUUID() })));
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(2);
    const [call] = await db.select().from(calls).where(eq(calls.businessId, business.id));
    expect((await registerInboundCall({ ...input, externalCallId: call.externalCallId!, idempotencyKey: crypto.randomUUID() })).created).toBe(false);
    expect((await getQuotaStatus(business.id)).meters.find(m => m.meter === "calls")!.consumed).toBe("2.0000");
  });
  itDb("rejects foreign and inactive agents, including direct runtime execution", async () => {
    const business = await createBusiness(), other = await createBusiness();
    const agent = await createAgent(other.id);
    const input = { businessId: business.id, phoneNumber: "09123456789", direction: "INBOUND" as const, metadata: {}, externalCallId: "foreign", idempotencyKey: crypto.randomUUID(), agentId: agent.id };
    await expect(registerInboundCall(input)).rejects.toMatchObject({ status: 404 });
    await db.update(agents).set({ isActive: false }).where(eq(agents.id, agent.id));
    await expect(registerInboundCall({ ...input, businessId: other.id })).rejects.toMatchObject({ status: 404 });
    await expect(runAgentTurn({ businessId: other.id, agentId: agent.id, userMessage: "hello", requestId: crypto.randomUUID(), actor: "test" })).rejects.toMatchObject({ status: 404 });
  });
});
