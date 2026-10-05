import { afterAll, afterEach, beforeAll, describe, expect, vi } from "vitest";
import { NextRequest } from "next/server";
import { createHmac } from "node:crypto";
import { eq } from "drizzle-orm";
import { closeDb, db } from "@/db";
import { businesses, calls, usageRecords } from "@/db/schema";
import { resetEnvCache } from "@/lib/env";
import { POST as inbound } from "@/app/api/v1/webhooks/voice/inbound/route";
import { createBusiness } from "../helpers/fixtures";
import { ensureDbReady, hasTestDatabase, itDb, truncateAll } from "../helpers/db";

/**
 * Inbound telephony webhook — the front door of the product.
 *
 * A 200 here means "the call was admitted and will be answered": it is only
 * correct when quota was reserved and the TwiML actually attaches the media
 * stream. Every other outcome must be an explicit rejection the caller can hear,
 * never a silent drop, and a tenant that is off must never be answered.
 */

const AUTH_TOKEN = "twilio-auth-token";
const PUBLIC_URL = "http://localhost:3000/api/v1/webhooks/voice/inbound";
const DIALED = "+982188776655";

let ipSeq = 0;
function request(body: Record<string, string>, signed: boolean, headers: Record<string, string> = {}) {
  const raw = new URLSearchParams(body).toString();
  const signature = createHmac("sha1", AUTH_TOKEN)
    .update(`${PUBLIC_URL}${Object.keys(body).sort().map((k) => k + body[k]).join("")}`)
    .digest("base64");
  return new NextRequest(PUBLIC_URL, {
    method: "POST",
    body: raw,
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "x-real-ip": `10.11.${(ipSeq >> 8) % 250}.${(ipSeq++ % 250) + 1}`,
      ...(signed ? { "x-twilio-signature": signature } : {}),
      ...headers,
    },
  });
}

const callBody = (overrides: Record<string, string> = {}) => ({
  From: "+989120000000",
  To: DIALED,
  CallSid: `CA${crypto.randomUUID().slice(0, 12)}`,
  CallStatus: "ringing",
  ...overrides,
});

type TenantPatch = {
  isActive?: boolean;
  status?: "ACTIVE" | "SUSPENDED" | "PENDING_DELETION" | "DELETED";
  settings?: Record<string, unknown>;
};

async function tenantFor(number = DIALED, extra: TenantPatch = {}) {
  const business = await createBusiness(`Voice ${crypto.randomUUID().slice(0, 8)}`);
  await db.update(businesses).set({ phone: number, isActive: true, status: "ACTIVE", ...extra }).where(eq(businesses.id, business.id));
  return business;
}

describe.skipIf(!hasTestDatabase())("inbound voice webhook", () => {
  beforeAll(async () => {
    await ensureDbReady();
    await truncateAll();
  });
  afterAll(async () => {
    await truncateAll();
    await closeDb();
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    resetEnvCache();
    await truncateAll();
  });

  function stubVoiceEnv(overrides: Record<string, string> = {}) {
    vi.stubEnv("TELEPHONY_PROVIDER", "twilio");
    vi.stubEnv("VOICE_PROVIDER", "twilio");
    vi.stubEnv("TWILIO_ACCOUNT_SID", "AC00000000000000000000000000000000");
    vi.stubEnv("TWILIO_AUTH_TOKEN", AUTH_TOKEN);
    vi.stubEnv("APP_URL", "http://localhost:3000");
    vi.stubEnv("VOICE_MEDIA_PUBLIC_URL", "wss://media.example.test/media");
    vi.stubEnv("VOICE_MEDIA_TOKEN", "media-token");
    for (const [key, value] of Object.entries(overrides)) vi.stubEnv(key, value);
    resetEnvCache();
  }

  itDb("answers a signed call with TwiML that attaches the media stream and reserves quota", async () => {
    stubVoiceEnv();
    const business = await tenantFor();
    const body = callBody();
    const res = await inbound(request(body, true));
    expect(res.status).toBe(200);
    const twiml = await res.text();
    expect(twiml).toContain("<Connect>");
    expect(twiml).toContain("wss://media.example.test/media");
    expect(res.headers.get("content-type")).toContain("text/xml");

    const [call] = await db.select().from(calls).where(eq(calls.businessId, business.id));
    expect(call.externalCallId).toBe(body.CallSid);
    expect(call.status).toBe("RINGING");
    const usage = await db.select().from(usageRecords).where(eq(usageRecords.businessId, business.id));
    expect(usage.filter((row) => row.type === "calls")).toHaveLength(1);
    // The media token is scoped to this call, not to the tenant at large.
    expect(twiml).toMatch(/token/);
    expect(twiml).not.toContain("media-token");
  });

  itDb("rejects unsigned callbacks fail-closed and never creates a call", async () => {
    stubVoiceEnv();
    const business = await tenantFor();
    const res = await inbound(request(callBody(), false));
    expect(res.status).toBeGreaterThanOrEqual(401);
    expect(await db.select().from(calls).where(eq(calls.businessId, business.id))).toHaveLength(0);
  });

  itDb("answers every rejection with TwiML the caller can hear, and never a silent 200", async () => {
    stubVoiceEnv();
    // 1 · disabled provider
    vi.stubEnv("VOICE_PROVIDER", "generic");
    resetEnvCache();
    const disabled = await inbound(request(callBody(), true));
    expect(disabled.status).toBe(503);
    expect(await disabled.text()).toContain("<Hangup");

    stubVoiceEnv();
    // 2 · unknown dialled number
    const unknown = await inbound(request(callBody({ To: "+989990009900" }), true));
    expect(unknown.status).toBe(404);
    expect(await unknown.text()).toContain("ثبت نشده");

    // 3 · known number, voice feature switched off for the tenant
    const business = await tenantFor();
    await db.update(businesses).set({ settings: { features: { voice: false } } }).where(eq(businesses.id, business.id));
    const noVoice = await inbound(request(callBody(), true));
    expect(noVoice.status).toBe(403);
    expect(await noVoice.text()).toContain("فعال نیست");

    // 4 · suspended tenant
    await db.update(businesses).set({ isActive: false, status: "SUSPENDED", settings: {} }).where(eq(businesses.id, business.id));
    const suspended = await inbound(request(callBody(), true));
    expect(suspended.status).toBe(403);
    expect(await suspended.text()).toContain("غیرفعال");

    // 5 · media infrastructure not configured
    stubVoiceEnv({ VOICE_MEDIA_PUBLIC_URL: "", VOICE_MEDIA_TOKEN: "" });
    await db.update(businesses).set({ isActive: true, status: "ACTIVE" }).where(eq(businesses.id, business.id));
    const noMedia = await inbound(request(callBody(), true));
    expect(noMedia.status).toBe(503);
    expect(await noMedia.text()).toContain("رسانه");

    // Nothing above may have been admitted.
    expect(await db.select().from(calls).where(eq(calls.businessId, business.id))).toHaveLength(0);
  });

  itDb("never answers a tenant that is pending deletion or deleted, even with isActive true", async () => {
    stubVoiceEnv();
    for (const status of ["PENDING_DELETION", "DELETED"] as const) {
      const number = `+9821${String(Date.now()).slice(-8)}${status === "DELETED" ? "1" : "2"}`;
      const business = await tenantFor(number);
      // Simulate the out-of-band change this gate exists to survive.
      await db.update(businesses).set({ status, isActive: true }).where(eq(businesses.id, business.id));
      const res = await inbound(request(callBody({ To: number }), true));
      expect(res.status).toBe(403);
      expect(await res.text()).toContain("غیرفعال");
      expect(await db.select().from(calls).where(eq(calls.businessId, business.id))).toHaveLength(0);
    }
  });

  itDb("is idempotent for a redelivered ring event and answers the duplicate without a second reservation", async () => {
    stubVoiceEnv();
    const business = await tenantFor();
    const body = callBody();
    const first = await inbound(request(body, true));
    const second = await inbound(request(body, true));
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(await second.text()).toContain("<Connect>");
    expect(await db.select().from(calls).where(eq(calls.businessId, business.id))).toHaveLength(1);
    const usage = await db.select().from(usageRecords).where(eq(usageRecords.businessId, business.id));
    expect(usage.filter((row) => row.type === "calls")).toHaveLength(1);
  });

  itDb("explains a quota rejection to the caller instead of dropping the call", async () => {
    stubVoiceEnv();
    const business = await tenantFor();
    const { quotaOverrides } = await import("@/db/schema");
    await db.insert(quotaOverrides).values({ businessId: business.id, policy: { calls: { hard: 1, soft: 1, grace: 0 } } });

    // The first call is inside the limit and must be admitted…
    const first = await inbound(request(callBody(), true));
    expect(first.status).toBe(200);
    // …the second is refused with an audible explanation and no phantom rows.
    const res = await inbound(request(callBody(), true));
    expect(res.status).toBe(402);
    const twiml = await res.text();
    expect(twiml).toContain("<Hangup");
    expect(twiml.length).toBeGreaterThan(80);
    expect(await db.select().from(calls).where(eq(calls.businessId, business.id))).toHaveLength(1);
    const usage = await db.select().from(usageRecords).where(eq(usageRecords.businessId, business.id));
    expect(usage.filter((row) => row.type === "calls")).toHaveLength(1);
  });

  itDb("resolves a number stored in either national or E.164 form", async () => {
    stubVoiceEnv();
    // Tenant stored the E.164 form; Twilio always dials E.164.
    const e164 = await tenantFor("+982177665544");
    const res = await inbound(request(callBody({ To: "+982177665544" }), true));
    expect(res.status).toBe(200);
    expect(await db.select().from(calls).where(eq(calls.businessId, e164.id))).toHaveLength(1);

    // Tenant stored the national form; the provider still dials E.164.
    const national = await tenantFor("02177665599");
    const res2 = await inbound(request(callBody({ To: "+982177665599" }), true));
    expect(res2.status).toBe(200);
    expect(await db.select().from(calls).where(eq(calls.businessId, national.id))).toHaveLength(1);
  });

  itDb("refuses to guess when two tenants claim the same number", async () => {
    stubVoiceEnv();
    const a = await tenantFor("+982177660011");
    const b = await tenantFor();
    // The unique index prevents this in production; force the legacy duplication
    // the guard exists for and prove no call is routed to an arbitrary tenant.
    await db.update(businesses).set({ phone: "02177660011" }).where(eq(businesses.id, b.id));
    const res = await inbound(request(callBody({ To: "+982177660011" }), true));
    expect(res.status).toBe(503);
    expect(await res.text()).toContain("مسیردهی");
    const rows = await db.select().from(calls);
    expect(rows.filter((row) => row.businessId === a.id || row.businessId === b.id)).toHaveLength(0);
  });

  itDb("escapes a caller-controlled disclosure message into valid TwiML", async () => {
    stubVoiceEnv();
    const business = await tenantFor();
    await db.update(businesses).set({ settings: { recording_enabled: true, disclosure_message: 'ضبط <Say voice="x"> & تماس' } }).where(eq(businesses.id, business.id));
    const res = await inbound(request(callBody(), true));
    expect(res.status).toBe(200);
    const twiml = await res.text();
    expect(twiml).toContain("&lt;Say");
    expect(twiml).toContain("&amp;");
    expect(twiml).not.toContain('<Say voice="x">');
  });
});
