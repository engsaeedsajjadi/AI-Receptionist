import { afterAll, beforeAll, beforeEach, describe, expect } from "vitest";
import { NextRequest } from "next/server";
import { closeDb, db } from "@/db";
import { callMessages, retrievalEvents, usageRecords } from "@/db/schema";
import { issueAuthTokens } from "@/lib/auth";
import { createBusiness, createCall, createUser } from "../helpers/fixtures";
import { ensureDbReady, hasTestDatabase, itDb, truncateAll } from "../helpers/db";

/**
 * Live call console (`GET /api/v1/calls/:id/live`): the operator view of a call
 * in progress. It exposes transcript, metered usage and retrieval evidence, so
 * the tenant boundary and ordering are the contract under test.
 */
function get(id: string, token?: string) {
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  return new NextRequest(`http://localhost/api/v1/calls/${id}/live`, { headers });
}

async function identity() {
  const business = await createBusiness();
  const { user } = await createUser(business.id, "ADMIN");
  const { accessToken } = await issueAuthTokens({ userId: user.id, businessId: business.id, role: "ADMIN" });
  return { business, user, token: accessToken };
}

describe.skipIf(!hasTestDatabase())("live call console route", () => {
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

  itDb("rejects unauthenticated requests and malformed call ids", async () => {
    const a = await identity();
    const call = await createCall(a.business.id);
    const { GET } = await import("@/app/api/v1/calls/[id]/live/route");

    const anonymous = await GET(get(call.id), { params: Promise.resolve({ id: call.id }) });
    expect(anonymous.status).toBe(401);

    const malformed = await GET(get("not-a-uuid", a.token), { params: Promise.resolve({ id: "not-a-uuid" }) });
    expect(malformed.status).toBe(400);
    expect((await malformed.json()).error.code).toBe("BAD_REQUEST");
  });

  itDb("returns transcript oldest-first with this call's usage and retrieval evidence", async () => {
    const a = await identity();
    const call = await createCall(a.business.id, "09121112233");
    const other = await createCall(a.business.id, "09120000000");
    const base = Date.now() - 60_000;

    await db.insert(callMessages).values([
      { businessId: a.business.id, callId: call.id, role: "CUSTOMER", content: "سلام، آپارتمان دو خوابه دارید؟", timestamp: new Date(base), seq: 1 },
      { businessId: a.business.id, callId: call.id, role: "AGENT", content: "بله، بودجه شما چقدر است؟", timestamp: new Date(base + 2_000), seq: 2 },
      { businessId: a.business.id, callId: other.id, role: "CUSTOMER", content: "تماس دیگر", timestamp: new Date(base + 1_000), seq: 1 },
    ]);
    await db.insert(usageRecords).values([
      { businessId: a.business.id, type: "stt_minutes", quantity: "0.5", unit: "minute", provider: "fake", idempotencyKey: `live-${call.id}`, metadata: { callId: call.id } },
      { businessId: a.business.id, type: "stt_minutes", quantity: "9", unit: "minute", provider: "fake", idempotencyKey: `live-${other.id}`, metadata: { callId: other.id } },
    ]);
    await db.insert(retrievalEvents).values({
      businessId: a.business.id, query: "آپارتمان دو خوابه", queryHash: "a".repeat(64),
      candidateCount: 4, resultCount: 2, callId: call.id, outcome: "ok",
    });

    const { GET } = await import("@/app/api/v1/calls/[id]/live/route");
    const res = await GET(get(call.id, a.token), { params: Promise.resolve({ id: call.id }) });
    expect(res.status).toBe(200);
    const body = (await res.json());

    expect(body.call.id).toBe(call.id);
    expect(body.messages.map((m: { content: string }) => m.content)).toEqual([
      "سلام، آپارتمان دو خوابه دارید؟",
      "بله، بودجه شما چقدر است؟",
    ]);
    expect(body.usage).toHaveLength(1);
    expect(Number(body.usage[0].quantity)).toBe(0.5);
    expect(body.retrieval).toHaveLength(1);
    expect(body.retrieval[0]).toMatchObject({ outcome: "ok", candidateCount: 4, resultCount: 2 });
    expect(Number.isNaN(Date.parse(body.serverTime))).toBe(false);
  });

  itDb("never exposes another tenant's call", async () => {
    const owner = await identity();
    const intruder = await identity();
    const call = await createCall(owner.business.id);
    await db.insert(callMessages).values({
      businessId: owner.business.id, callId: call.id, role: "CUSTOMER", content: "محرمانه", seq: 1,
    });

    const { GET } = await import("@/app/api/v1/calls/[id]/live/route");
    const res = await GET(get(call.id, intruder.token), { params: Promise.resolve({ id: call.id }) });
    expect(res.status).toBe(404);
    const text = JSON.stringify(await res.json());
    expect(text).toContain("CALL_NOT_FOUND");
    expect(text).not.toContain("محرمانه");
  });
});
