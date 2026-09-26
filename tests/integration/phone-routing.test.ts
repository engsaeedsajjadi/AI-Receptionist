import { NextRequest } from "next/server";
import { beforeAll, beforeEach, describe, expect } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { businesses, calls } from "@/db/schema";
import { computeHmacHex } from "@/lib/security";
import { resolveBusinessByCalledNumber } from "@/lib/services/phone-routing";
import { ensureDbReady, hasTestDatabase, itDb, truncateAll } from "../helpers/db";
import { uniqueTestIp } from "../helpers/http";
import { createBusiness } from "../helpers/fixtures";
import { POST as callStarted } from "@/app/api/v1/webhooks/voice/call-started/route";

// In tests VOICE_WEBHOOK_SECRET is unset → env.webhookSecret falls back here.
const SECRET = "dev-webhook-secret";
let keySeq = 0;

function post(body: unknown): NextRequest {
  const raw = JSON.stringify(body);
  return new NextRequest(
    new Request("http://localhost/api/v1/webhooks/voice/call-started", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-webhook-signature": computeHmacHex(SECRET, raw),
        "x-idempotency-key": `pr-${Date.now()}-${keySeq++}`,
        "x-real-ip": uniqueTestIp(),
      },
      body: raw,
    }),
  );
}

async function setNumbers(businessId: string, patch: { voiceNumber?: string | null; phone?: string | null }) {
  await db.update(businesses).set(patch).where(eq(businesses.id, businessId));
}

describe.skipIf(!hasTestDatabase())("called-number -> business routing (real database)", () => {
  beforeAll(async () => {
    if (!(await ensureDbReady())) return;
    await truncateAll();
  });
  beforeEach(async () => {
    if (!(await ensureDbReady())) return;
    await truncateAll();
  });

  itDb("routes by dedicated voice_number across formatting variants", async () => {
    const biz = await createBusiness("Voice Number Biz");
    await setNumbers(biz.id, { voiceNumber: "02122334455" });
    for (const variant of ["02122334455", "+982122334455", "00982122334455", "۰۲۱۲۲۳۳۴۴۵۵"]) {
      const route = await resolveBusinessByCalledNumber(variant);
      expect(route).toMatchObject({ ok: true, businessId: biz.id, via: "voice_number" });
    }
  });

  itDb("falls back to a unique contact phone, rejects ambiguous ones", async () => {
    const solo = await createBusiness("Solo Phone Biz");
    await setNumbers(solo.id, { phone: "02199887766" });
    expect(await resolveBusinessByCalledNumber("02199887766")).toMatchObject({
      ok: true,
      businessId: solo.id,
      via: "phone",
    });

    const a = await createBusiness("Shared A");
    const b = await createBusiness("Shared B");
    await setNumbers(a.id, { phone: "02111111111" });
    await setNumbers(b.id, { phone: "02111111111" });
    expect(await resolveBusinessByCalledNumber("02111111111")).toMatchObject({
      ok: false,
      reason: "AMBIGUOUS_NUMBER",
    });
  });

  itDb("never routes unknown, garbage, or inactive numbers", async () => {
    expect(await resolveBusinessByCalledNumber("02100000000")).toMatchObject({
      ok: false,
      reason: "UNROUTABLE_NUMBER",
    });
    expect(await resolveBusinessByCalledNumber("not-a-number")).toMatchObject({
      ok: false,
      reason: "UNROUTABLE_NUMBER",
    });
    const dead = await createBusiness("Dead Biz");
    await setNumbers(dead.id, { voiceNumber: "02122222222" });
    await db.update(businesses).set({ isActive: false }).where(eq(businesses.id, dead.id));
    expect(await resolveBusinessByCalledNumber("02122222222")).toMatchObject({
      ok: false,
      reason: "UNROUTABLE_NUMBER",
    });
  });

  itDb("call-started: called_number alone creates the call under the routed tenant", async () => {
    const biz = await createBusiness("Routed Call Biz");
    await setNumbers(biz.id, { voiceNumber: "02133445566" });
    const externalCallId = `ext-route-${Date.now()}`;
    const res = await callStarted(
      post({ called_number: "+98-21-3344-5566", external_call_id: externalCallId, phone_number: "09120000000" }),
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean; callId: string; routing: Record<string, unknown> };
    expect(json.ok).toBe(true);
    expect(json.routing).toMatchObject({ method: "called_number", via: "voice_number" });
    const [row] = await db.select().from(calls).where(eq(calls.id, json.callId)).limit(1);
    expect(row.businessId).toBe(biz.id);
    expect(row.metadata as Record<string, unknown>).toMatchObject({
      routing: { method: "called_number", via: "voice_number" },
    });
  });

  itDb("call-started: agreeing business_id + called_number is accepted", async () => {
    const biz = await createBusiness("Agree Biz");
    await setNumbers(biz.id, { voiceNumber: "02144556677" });
    const res = await callStarted(
      post({
        business_id: biz.id,
        called_number: "02144556677",
        external_call_id: `ext-agree-${Date.now()}`,
        phone_number: "09120000001",
      }),
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { ok: boolean }).ok).toBe(true);
  });

  itDb("call-started: business_id disagreeing with the route is rejected (400)", async () => {
    const routed = await createBusiness("Real Tenant");
    const liar = await createBusiness("Liar Tenant");
    await setNumbers(routed.id, { voiceNumber: "02155667788" });
    const res = await callStarted(
      post({
        business_id: liar.id,
        called_number: "02155667788",
        external_call_id: `ext-liar-${Date.now()}`,
        phone_number: "09120000002",
      }),
    );
    expect(res.status).toBe(400);
    const rows = await db
      .select()
      .from(calls)
      .where(and(eq(calls.businessId, liar.id), eq(calls.phoneNumber, "09120000002")));
    expect(rows).toHaveLength(0);
  });

  itDb("call-started: unroutable number is 404, ambiguous is 409", async () => {
    const bad = await callStarted(
      post({ called_number: "02100000001", external_call_id: `ext-404-${Date.now()}`, phone_number: "09120000003" }),
    );
    expect(bad.status).toBe(404);

    const a = await createBusiness("Amb A");
    const b = await createBusiness("Amb B");
    await setNumbers(a.id, { phone: "02166778899" });
    await setNumbers(b.id, { phone: "02166778899" });
    const amb = await callStarted(
      post({ called_number: "02166778899", external_call_id: `ext-409-${Date.now()}`, phone_number: "09120000004" }),
    );
    expect(amb.status).toBe(409);
  });

  itDb("call-started: legacy business_id-only payloads still work", async () => {
    const biz = await createBusiness("Legacy Biz");
    const res = await callStarted(
      post({ business_id: biz.id, external_call_id: `ext-legacy-${Date.now()}`, phone_number: "09120000005" }),
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { routing: Record<string, unknown> };
    expect(json.routing).toMatchObject({ method: "business_id" });
  });
});
