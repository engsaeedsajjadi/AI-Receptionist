import { afterAll, beforeAll, describe, expect } from "vitest";
import { NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { closeDb, db } from "@/db";
import { auditLogs, leads } from "@/db/schema";
import { issueAuthTokens } from "@/lib/auth";
import { GET as scoreGet, POST as scorePost } from "@/app/api/v1/leads/[id]/score/route";
import { GET as leadGet } from "@/app/api/v1/leads/[id]/route";
import { normalizeLeadExtraction } from "@/lib/services/leads";
import { createBusiness, createCustomer, createLead, createUser } from "../helpers/fixtures";
import { ensureDbReady, hasTestDatabase, itDb, truncateAll } from "../helpers/db";

/**
 * Explainable scoring over HTTP: the rationale persisted with a lead is the same
 * one the API reports, a rescore is audited with the reason it changed, and a
 * cross-tenant lead id is a 404 rather than a peek at another tenant's score.
 */

let ipSeq = 0;
function req(path: string, token: string, method = "GET") {
  return new NextRequest(`http://localhost${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, "x-real-ip": `10.9.${(ipSeq >> 8) % 250}.${(ipSeq++ % 250) + 1}` },
  });
}

describe.skipIf(!hasTestDatabase())("lead scoring (HTTP)", () => {
  beforeAll(async () => {
    await ensureDbReady();
    await truncateAll();
  });
  afterAll(async () => {
    await truncateAll();
    await closeDb();
  });

  itDb("scores a lead from call extraction and stores the rationale with it", async () => {
    const business = await createBusiness(`Score ${crypto.randomUUID().slice(0, 8)}`);
    const customer = await createCustomer(business.id, `0912${String(Date.now()).slice(-7)}`);
    const { createOrUpdateLead } = await import("@/lib/services/leads");
    const { lead } = await createOrUpdateLead({
      businessId: business.id,
      customerId: customer.id,
      extraction: normalizeLeadExtraction({
        phone: customer.phone,
        intent: "BUY",
        location: "تهران، سعادت‌آباد",
        budgetMin: 8_000_000_000,
        budgetMax: 12_000_000_000,
        bedrooms: 3,
        timeframe: "this_week",
        requestedVisit: true,
        summary: "خریدار جدی آپارتمان در سعادت‌آباد با بودجه مشخص",
      }),
    });

    expect(lead.score).toBeGreaterThan(60);
    const { readScoreRationale } = await import("@/lib/scoring");
    const stored = readScoreRationale(lead.scoreRationale);
    expect(stored).not.toBeNull();
    expect(stored?.score).toBe(lead.score);
    expect(stored?.explanation).toContain("baseline 50");
    expect(stored?.factors.length).toBeGreaterThan(4);

    // The API reports exactly what the row holds — no recomputation drift.
    const { user } = await createUser(business.id, "ADMIN");
    const { accessToken } = await issueAuthTokens({ userId: user.id, businessId: business.id, role: "ADMIN" });
    const res = await scoreGet(req(`/api/v1/leads/${lead.id}/score`, accessToken), { params: Promise.resolve({ id: lead.id }) });
    const body = (await res.json()) as { score: number; rationale: { rubricVersion: string } };
    expect(res.status).toBe(200);
    expect(body.score).toBe(lead.score);
    expect(body.rationale.rubricVersion).toBe(stored?.rubricVersion);
  });

  itDb("rescore is audited, explains the delta, and is tenant bounded", async () => {
    const a = await createBusiness(`Score A ${crypto.randomUUID().slice(0, 8)}`);
    const b = await createBusiness(`Score B ${crypto.randomUUID().slice(0, 8)}`);
    const customerA = await createCustomer(a.id, `0913${String(Date.now()).slice(-7)}`);
    const leadA = await createLead(a.id, customerA.id);
    // Seed a stale score + empty rationale to prove a rescore is a real recompute.
    await db.update(leads).set({ score: 3, scoreRationale: {} }).where(eq(leads.id, leadA.id));
    const { user: userA } = await createUser(a.id, "ADMIN");
    const { user: userB } = await createUser(b.id, "ADMIN");
    const tokenA = (await issueAuthTokens({ userId: userA.id, businessId: a.id, role: "ADMIN" })).accessToken;
    const tokenB = (await issueAuthTokens({ userId: userB.id, businessId: b.id, role: "ADMIN" })).accessToken;

    // Tenant B tries tenant A's lead: 404 on both read and rescore, no data leak.
    for (const call of [
      () => scoreGet(req(`/api/v1/leads/${leadA.id}/score`, tokenB), { params: Promise.resolve({ id: leadA.id }) }),
      () => scorePost(req(`/api/v1/leads/${leadA.id}/score`, tokenB, "POST"), { params: Promise.resolve({ id: leadA.id }) }),
    ]) {
      const res = await call();
      expect(res.status).toBe(404);
      expect(JSON.stringify(await res.json())).not.toContain("تهران");
    }

    const res = await scorePost(req(`/api/v1/leads/${leadA.id}/score`, tokenA, "POST"), { params: Promise.resolve({ id: leadA.id }) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      score: number; rationale: { explanation: string; factors: Array<{ factor: string }> }; change: { from: number | null; to: number; delta: number | null; changes: Array<{ factor: string }> };
    };
    // A legacy row with no usable rationale still rescores; there is simply no "from".
    expect(body.change.from).toBeNull();
    expect(body.change.delta).toBeNull();
    expect(body.change.to).toBe(body.score);
    expect(body.rationale.factors.map((f) => f.factor)).toContain("location");

    // Second pass: a new signal arrives, so the change is explained factor by factor.
    await db.update(leads).set({ requestedVisit: true }).where(eq(leads.id, leadA.id));
    const again = await scorePost(req(`/api/v1/leads/${leadA.id}/score`, tokenA, "POST"), { params: Promise.resolve({ id: leadA.id }) });
    const second = (await again.json()) as { score: number; change: { from: number | null; delta: number | null; changes: Array<{ factor: string; before: number; after: number }> } };
    expect(second.change.from).toBe(body.score);
    expect(second.change.delta).toBe(second.score - body.score);
    expect(second.change.changes.map((c) => c.factor)).toContain("visit_requested");
    expect(second.score).toBeGreaterThan(body.score);

    // Persisted, and each audit row names the actor, the delta and the factors.
    const [row] = await db.select().from(leads).where(eq(leads.id, leadA.id));
    expect(row.score).toBe(second.score);
    expect((row.scoreRationale as { score: number }).score).toBe(second.score);
    const audits = (await db.select().from(auditLogs).where(eq(auditLogs.entityId, leadA.id)))
      .filter((entry) => entry.action === "lead.rescored")
      .sort((x, y) => x.createdAt.getTime() - y.createdAt.getTime());
    expect(audits).toHaveLength(2);
    expect(audits[0].businessId).toBe(a.id);
    expect(audits[0].actorId).toBe(userA.id);
    expect((audits[0].metadata as { from: number | null }).from).toBeNull();
    expect((audits[1].metadata as { from: number }).from).toBe(body.score);
    expect((audits[1].metadata as { to: number }).to).toBe(second.score);
    expect((audits[1].metadata as { changes: Array<{ factor: string }> }).changes.map((c) => c.factor)).toEqual(["visit_requested"]);

    // The legacy lead GET still works and returns the scored row.
    const leadRes = await leadGet(req(`/api/v1/leads/${leadA.id}`, tokenA), { params: Promise.resolve({ id: leadA.id }) });
    expect(leadRes.status).toBe(200);
  });
});
