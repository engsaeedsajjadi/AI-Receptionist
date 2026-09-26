import { NextRequest } from "next/server";
import { beforeAll, beforeEach, describe, expect } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { callMessages, calls, usageRecords } from "@/db/schema";
import { computeHmacHex } from "@/lib/security";
import { ensureDbReady, hasTestDatabase, itDb, truncateAll } from "../helpers/db";
import { createBusiness } from "../helpers/fixtures";
import { POST as callStarted } from "@/app/api/v1/webhooks/voice/call-started/route";
import { POST as transcript } from "@/app/api/v1/webhooks/voice/transcript/route";
import { POST as toolCall } from "@/app/api/v1/webhooks/voice/tool-call/route";

// In tests VOICE_WEBHOOK_SECRET is unset → env.webhookSecret falls back here.
const SECRET = "dev-webhook-secret";
let keySeq = 0;
const nextKey = () => `wr-${Date.now()}-${keySeq++}`;

function post(body: unknown, key: string, path: string): NextRequest {
  const raw = JSON.stringify(body);
  return new NextRequest(
    new Request(`http://localhost${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-webhook-signature": computeHmacHex(SECRET, raw),
        "x-idempotency-key": key,
      },
      body: raw,
    }),
  );
}

async function seedCall(businessId: string, externalCallId: string) {
  const [row] = await db
    .insert(calls)
    .values({ businessId, externalCallId, phoneNumber: "09123456789", status: "IN_PROGRESS" })
    .returning();
  return row;
}

describe.skipIf(!hasTestDatabase())("voice webhook routes: idempotency + concurrency", () => {
  beforeAll(async () => {
    if (!(await ensureDbReady())) return;
    await truncateAll();
  });
  beforeEach(async () => {
    if (!(await ensureDbReady())) return;
    await truncateAll();
  });

  itDb("call-started: concurrent duplicates collapse to one call + one usage row", async () => {
    const business = await createBusiness("Webhook Biz A");
    const payload = {
      business_id: business.id,
      external_call_id: `ext-${Date.now()}`,
      phone_number: "09123456789",
    };
    const [r1, r2] = await Promise.all([
      callStarted(post(payload, nextKey(), "/api/v1/webhooks/voice/call-started")),
      callStarted(post(payload, nextKey(), "/api/v1/webhooks/voice/call-started")),
    ]);
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    const j1 = (await r1.json()) as { duplicate: boolean; callId: string };
    const j2 = (await r2.json()) as { duplicate: boolean; callId: string };
    // Exactly one winner, one deterministic duplicate — same call id.
    expect([j1.duplicate, j2.duplicate].sort()).toEqual([false, true]);
    expect(j1.callId).toBe(j2.callId);
    // Media bootstrap is reported honestly (no provider in tests → skipped).
    const winner = (j1.duplicate ? j2 : j1) as unknown as { media: { attempted: boolean; reason: string } };
    expect(winner.media).toMatchObject({ attempted: false, reason: "provider_not_configured" });

    const rows = await db
      .select()
      .from(calls)
      .where(and(eq(calls.businessId, business.id), eq(calls.externalCallId, payload.external_call_id)));
    expect(rows).toHaveLength(1);
    const usage = await db
      .select()
      .from(usageRecords)
      .where(and(eq(usageRecords.businessId, business.id), eq(usageRecords.type, "calls")));
    expect(usage).toHaveLength(1);
  });

  itDb("call-started: same idempotency key redelivery is a duplicate", async () => {
    const business = await createBusiness("Webhook Biz B");
    const payload = {
      business_id: business.id,
      external_call_id: `ext-${Date.now()}-b`,
      phone_number: "09123456789",
    };
    const key = nextKey();
    const first = await callStarted(post(payload, key, "/api/v1/webhooks/voice/call-started"));
    const second = await callStarted(post(payload, key, "/api/v1/webhooks/voice/call-started"));
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(((await second.json()) as { duplicate: boolean }).duplicate).toBe(true);
  });

  itDb("call-started: invalid payload does not burn the idempotency key", async () => {
    const business = await createBusiness("Webhook Biz C");
    const key = nextKey();
    const bad = await callStarted(
      post({ external_call_id: "x" }, key, "/api/v1/webhooks/voice/call-started"),
    );
    expect(bad.status).toBe(400);
    // Same key with a now-valid payload must still be accepted.
    const good = await callStarted(
      post(
        { business_id: business.id, external_call_id: `ext-${Date.now()}-c`, phone_number: "09123456789" },
        key,
        "/api/v1/webhooks/voice/call-started",
      ),
    );
    expect(good.status).toBe(200);
    expect(((await good.json()) as { ok: boolean }).ok).toBe(true);
  });

  itDb("transcript: same final event twice appends once", async () => {
    const business = await createBusiness("Webhook Biz D");
    const call = await seedCall(business.id, `ext-${Date.now()}-d`);
    const payload = {
      business_id: business.id,
      external_call_id: call.externalCallId,
      transcript: "سلام من دنبال آپارتمان هستم",
      role: "CUSTOMER",
      is_final: true,
      event_id: `seg-${Date.now()}`,
    };
    const r1 = await transcript(post(payload, nextKey(), "/api/v1/webhooks/voice/transcript"));
    const r2 = await transcript(post(payload, nextKey(), "/api/v1/webhooks/voice/transcript"));
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(((await r2.json()) as { duplicate: boolean }).duplicate).toBe(true);

    const messages = await db.select().from(callMessages).where(eq(callMessages.callId, call.id));
    expect(messages).toHaveLength(1);
    const [updated] = await db.select().from(calls).where(eq(calls.id, call.id)).limit(1);
    expect(updated.transcript).toBe("سلام من دنبال آپارتمان هستم");
  });

  itDb("transcript: partial → final progression updates in place, appends once", async () => {
    const business = await createBusiness("Webhook Biz E");
    const call = await seedCall(business.id, `ext-${Date.now()}-e`);
    const eventId = `seg-${Date.now()}-e`;
    const base = {
      business_id: business.id,
      external_call_id: call.externalCallId,
      role: "CUSTOMER",
      event_id: eventId,
    };
    const p1 = await transcript(
      post({ ...base, transcript: "سلام من دنبال", is_final: false }, nextKey(), "/api/v1/webhooks/voice/transcript"),
    );
    const p2 = await transcript(
      post(
        { ...base, transcript: "سلام من دنبال آپارتمان هستم", is_final: true },
        nextKey(),
        "/api/v1/webhooks/voice/transcript",
      ),
    );
    expect(p1.status).toBe(200);
    expect(p2.status).toBe(200);

    const messages = await db.select().from(callMessages).where(eq(callMessages.callId, call.id));
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe("سلام من دنبال آپارتمان هستم");
    expect((messages[0].metadata as Record<string, unknown>).isFinal).toBe(true);
    const [updated] = await db.select().from(calls).where(eq(calls.id, call.id)).limit(1);
    expect(updated.transcript).toBe("سلام من دنبال آپارتمان هستم");
  });

  itDb("tool-call: same event twice executes once, returns stored outcome", async () => {
    const business = await createBusiness("Webhook Biz F");
    const call = await seedCall(business.id, `ext-${Date.now()}-f`);
    const payload = {
      business_id: business.id,
      external_call_id: call.externalCallId,
      tool: "get_business_info",
      arguments: {},
      event_id: `tool-${Date.now()}`,
    };
    const r1 = await toolCall(post(payload, nextKey(), "/api/v1/webhooks/voice/tool-call"));
    const r2 = await toolCall(post(payload, nextKey(), "/api/v1/webhooks/voice/tool-call"));
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    const j1 = (await r1.json()) as { ok: boolean; status: string; duplicate: boolean };
    const j2 = (await r2.json()) as { ok: boolean; status: string; duplicate: boolean };
    expect(j1).toMatchObject({ ok: true, status: "SUCCESS", duplicate: false });
    expect(j2).toMatchObject({ ok: true, status: "SUCCESS", duplicate: true });

    const messages = await db
      .select()
      .from(callMessages)
      .where(and(eq(callMessages.callId, call.id), eq(callMessages.eventId, payload.event_id)));
    expect(messages).toHaveLength(1);
  });
});
