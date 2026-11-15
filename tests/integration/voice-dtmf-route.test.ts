import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, vi } from "vitest";
import { NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { closeDb, db } from "@/db";
import { calls } from "@/db/schema";
import { resetEnvCache } from "@/lib/env";
import { createMediaSessionToken } from "@/lib/voice/media-auth";
import { createBusiness, createCall } from "../helpers/fixtures";
import { ensureDbReady, hasTestDatabase, itDb, truncateAll } from "../helpers/db";

/**
 * In-call key presses (`POST /api/v1/webhooks/voice/voice-dtmf`).
 *
 * Pressing `0` hands the caller to a human: the route must only act for a call
 * identified by a valid signed media token, must dial nothing but the tenant's
 * own stored transfer number, and must keep the call alive (empty TwiML) in
 * every other case.
 */
const SECRET = "dtmf-test-media-secret-0123456789";
const EMPTY = `<?xml version="1.0" encoding="UTF-8"?><Response/>`;

function press(digits: string, token?: string, where: "query" | "body" = "query") {
  const form = new URLSearchParams({ Digits: digits, CallSid: "CA-test" });
  if (token && where === "body") form.set("media_token", token);
  const query = token && where === "query" ? `?media_token=${encodeURIComponent(token)}` : "";
  return new NextRequest(`http://localhost/api/v1/webhooks/voice/voice-dtmf${query}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });
}

async function seedCall(transferTo: string | null) {
  const business = await createBusiness();
  const call = await createCall(business.id);
  await db.update(calls).set({ transferTo, metadata: { source: "test" } }).where(eq(calls.id, call.id));
  const token = createMediaSessionToken(SECRET, {
    businessId: business.id, callId: call.id, externalCallId: call.externalCallId ?? undefined,
  });
  return { business, call, token };
}

async function reload(id: string) {
  const [row] = await db.select().from(calls).where(eq(calls.id, id));
  return row;
}

describe.skipIf(!hasTestDatabase())("voice DTMF route", () => {
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
    vi.stubEnv("VOICE_MEDIA_TOKEN", SECRET);
    resetEnvCache();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    resetEnvCache();
  });

  itDb("pressing 0 records the request and dials the tenant's stored transfer number", async () => {
    const { call, token } = await seedCall("+982112345678");
    const { POST } = await import("@/app/api/v1/webhooks/voice/voice-dtmf/route");

    const res = await POST(press("0", token));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/xml");
    const xml = await res.text();
    expect(xml).toContain("<Dial");
    expect(xml).toContain("+982112345678");

    const row = await reload(call.id);
    expect(row.transferRequestedAt).toBeInstanceOf(Date);
    expect(row.metadata).toMatchObject({ source: "test", last_dtmf: "0" });
    expect(Number.isNaN(Date.parse(String((row.metadata as Record<string, unknown>).dtmf_at)))).toBe(false);
  });

  itDb("accepts the media token from the form body as well as the query string", async () => {
    const { call, token } = await seedCall("+982112345678");
    const { POST } = await import("@/app/api/v1/webhooks/voice/voice-dtmf/route");

    const res = await POST(press("0", token, "body"));
    expect(await res.text()).toContain("<Dial");
    expect((await reload(call.id)).transferRequestedAt).toBeInstanceOf(Date);
  });

  itDb("other digits are recorded but the call simply continues", async () => {
    const { call, token } = await seedCall("+982112345678");
    const { POST } = await import("@/app/api/v1/webhooks/voice/voice-dtmf/route");

    const res = await POST(press("5", token));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(EMPTY);
    const row = await reload(call.id);
    expect(row.transferRequestedAt).toBeNull();
    expect(row.metadata).toMatchObject({ last_dtmf: "5" });
  });

  itDb("pressing 0 without a configured transfer number never dials anything", async () => {
    const { call, token } = await seedCall(null);
    const { POST } = await import("@/app/api/v1/webhooks/voice/voice-dtmf/route");

    const res = await POST(press("0", token));
    expect(await res.text()).toBe(EMPTY);
    const row = await reload(call.id);
    expect(row.transferRequestedAt).toBeNull();
    expect(row.metadata).toMatchObject({ last_dtmf: "0" });
  });

  itDb("ignores missing, forged, expired and wrong-tenant tokens without touching the call", async () => {
    const { business, call } = await seedCall("+982112345678");
    const other = await createBusiness();
    const { POST } = await import("@/app/api/v1/webhooks/voice/voice-dtmf/route");

    const forged = createMediaSessionToken("a-different-secret-entirely-000000", {
      businessId: business.id, callId: call.id, externalCallId: call.externalCallId ?? undefined,
    });
    const expired = createMediaSessionToken(SECRET, {
      businessId: business.id, callId: call.id, externalCallId: call.externalCallId ?? undefined, ttlSeconds: -60,
    });
    // Correctly signed, but scoped to a tenant that does not own this call.
    const wrongTenant = createMediaSessionToken(SECRET, {
      businessId: other.id, callId: call.id, externalCallId: call.externalCallId ?? undefined,
    });

    for (const token of [undefined, "garbage", forged, expired, wrongTenant]) {
      const res = await POST(press("0", token));
      expect(res.status).toBe(200);
      const xml = await res.text();
      expect(xml).toBe(EMPTY);
      expect(xml).not.toContain("+982112345678");
    }

    const row = await reload(call.id);
    expect(row.transferRequestedAt).toBeNull();
    expect(row.metadata).toEqual({ source: "test" });
  });

  itDb("escapes the stored transfer number so it cannot inject TwiML", async () => {
    const { token } = await seedCall(`+98</Dial><Say>x</Say>`);
    const { POST } = await import("@/app/api/v1/webhooks/voice/voice-dtmf/route");

    const xml = await (await POST(press("0", token))).text();
    expect(xml).not.toContain("<Say>");
    expect(xml.match(/<Dial/g)).toHaveLength(1);
  });
});
