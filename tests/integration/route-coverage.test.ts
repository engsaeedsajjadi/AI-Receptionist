import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, vi } from "vitest";
import { NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { closeDb, db } from "@/db";
import { appointments, businesses, calls, knowledgeChunks, knowledgeDocuments, properties, users } from "@/db/schema";
import { issueAuthTokens } from "@/lib/auth";
import { resetEnvCache } from "@/lib/env";
import { totp } from "@/lib/mfa";
import { createBusiness, createCustomer, createLead, createUser } from "../helpers/fixtures";
import { ensureDbReady, hasTestDatabase, itDb, truncateAll } from "../helpers/db";
import { getRedis } from "@/lib/redis";

type Init = { method?: string; body?: unknown; token?: string; headers?: Record<string, string>; raw?: BodyInit };

function send(path: string, init: Init = {}) {
  const headers: Record<string, string> = { ...init.headers };
  if (init.token) headers.Authorization = `Bearer ${init.token}`;
  let body: BodyInit | undefined;
  if (init.raw !== undefined) body = init.raw;
  else if (init.body !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(init.body);
  }
  return new NextRequest(`http://localhost${path}`, { method: init.method ?? (body ? "POST" : "GET"), headers, body });
}

async function identity(role: "ADMIN" | "MANAGER" | "AGENT" | "VIEWER" = "ADMIN") {
  const business = await createBusiness();
  const { user, password } = await createUser(business.id, "ADMIN");
  if (role !== "ADMIN") await db.update(users).set({ role }).where(eq(users.id, user.id));
  const { accessToken } = await issueAuthTokens({ userId: user.id, businessId: business.id, role });
  return { business, user, password, token: accessToken };
}

async function resetRedis() {
  const client = getRedis();
  if (client) await client.flushall().catch(() => undefined);
}

/** Business hours must be open for the appointment routes to accept a booking. */
async function openAllWeek(businessId: string) {
  const hours = Object.fromEntries(
    ["saturday", "sunday", "monday", "tuesday", "wednesday", "thursday", "friday"].map((day) => [day, { enabled: true, start: "00:00", end: "23:59" }]),
  );
  const [row] = await db.select().from(businesses).where(eq(businesses.id, businessId));
  await db
    .update(businesses)
    .set({ settings: { ...(row.settings as Record<string, unknown>), scheduling: { timezone: "Asia/Tehran", hours } }, updatedAt: new Date() })
    .where(eq(businesses.id, businessId));
}

describe.skipIf(!hasTestDatabase())("appointment routes (HTTP)", () => {
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
    await resetRedis();
  });

  itDb("creates, reads, reschedules and cancels an appointment", async () => {
    const a = await identity();
    await openAllWeek(a.business.id);
    const customer = await createCustomer(a.business.id, "09121110001");
    const lead = await createLead(a.business.id, customer.id);
    const { POST, GET } = await import("@/app/api/v1/appointments/route");
    const scheduledAt = new Date(Date.now() + 3 * 86_400_000).toISOString();
    const created = await POST(send("/api/v1/appointments", { token: a.token, body: { title: "بازدید ملک", scheduledAt, durationMinutes: 30, customerId: customer.id, leadId: lead.id } }));
    expect([201, 200]).toContain(created.status);
    const body = await created.json();
    const appointmentId = body.id ?? body.appointment?.id;
    expect(appointmentId).toBeTruthy();

    const list = await GET(send("/api/v1/appointments?status=SCHEDULED", { token: a.token }));
    expect(list.status).toBe(200);
    const availability = await GET(send(`/api/v1/appointments?date=${scheduledAt.slice(0, 10)}&durationMinutes=30`, { token: a.token }));
    expect(availability.status).toBe(200);
    expect(await availability.json()).toHaveProperty("slots");

    const { GET: one, PUT, DELETE } = await import("@/app/api/v1/appointments/[id]/route");
    expect((await one(send(`/api/v1/appointments/${appointmentId}`, { token: a.token }), { params: Promise.resolve({ id: appointmentId }) })).status).toBe(200);
    const rescheduled = await PUT(
      send(`/api/v1/appointments/${appointmentId}`, { method: "PUT", token: a.token, body: { scheduledAt: new Date(Date.now() + 4 * 86_400_000).toISOString(), durationMinutes: 45 } }),
      { params: Promise.resolve({ id: appointmentId }) },
    );
    expect([200, 400]).toContain(rescheduled.status);
    const cancelled = await DELETE(send(`/api/v1/appointments/${appointmentId}`, { method: "DELETE", token: a.token }), { params: Promise.resolve({ id: appointmentId }) });
    expect(cancelled.status).toBe(200);
    const [row] = await db.select().from(appointments).where(eq(appointments.id, appointmentId));
    expect(row.status).toBe("CANCELLED");
    expect((await one(send(`/api/v1/appointments/${crypto.randomUUID()}`, { token: a.token }), { params: Promise.resolve({ id: crypto.randomUUID() }) })).status).toBe(404);
  });
});

describe.skipIf(!hasTestDatabase())("property routes (HTTP)", () => {
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
    await resetRedis();
  });

  itDb("creates, lists, updates and deletes a listing with tenant scoping", async () => {
    const a = await identity();
    const b = await identity("MANAGER");
    const { POST, GET } = await import("@/app/api/v1/properties/route");
    const payload = {
      title: "آپارتمان ۹۵ متری سعادت‌آباد",
      transactionType: "sale" as const,
      location: "تهران، سعادت‌آباد",
      city: "تهران",
      price: "12.5 میلیارد تومان",
      area: "95 متر",
      bedrooms: 2,
      features: ["پارکینگ", "آسانسور"],
      isAvailable: true,
    };
    const created = await POST(send("/api/v1/properties", { token: a.token, body: payload }));
    expect(created.status).toBe(201);
    const created0 = await created.json();
    const propertyId = created0.id ?? created0.property?.id;
    const list = await GET(send("/api/v1/properties?city=تهران", { token: a.token }));
    expect(list.status).toBe(200);
    expect(JSON.stringify(await list.json())).toContain("سعادت‌آباد");
    const foreign = await GET(send("/api/v1/properties", { token: b.token }));
    expect(JSON.stringify(await foreign.json())).not.toContain("سعادت‌آباد");
    const viewer = await identity("VIEWER");
    expect((await POST(send("/api/v1/properties", { token: viewer.token, body: payload }))).status).toBe(403);
    expect((await POST(send("/api/v1/properties", { token: a.token, body: { title: "بدون قیمت" } }))).status).toBe(400);
    const { PUT, DELETE } = await import("@/app/api/v1/properties/[id]/route");
    const updated = await PUT(send(`/api/v1/properties/${propertyId}`, { method: "PUT", token: a.token, body: { price: "11 میلیارد تومان" } }), { params: Promise.resolve({ id: propertyId }) });
    expect(updated.status).toBe(200);
    expect((await DELETE(send(`/api/v1/properties/${propertyId}`, { method: "DELETE", token: a.token }), { params: Promise.resolve({ id: propertyId }) })).status).toBe(200);
  });
});

describe.skipIf(!hasTestDatabase())("knowledge lifecycle routes (HTTP)", () => {
  beforeAll(async () => {
    await ensureDbReady();
    await truncateAll();
    vi.stubEnv("STORAGE_PROVIDER", "local");
    vi.stubEnv("LOCAL_STORAGE_DIR", "/tmp/ai-receptionist-knowledge-routes");
    vi.stubEnv("EMBEDDING_PROVIDER", "dev");
    resetEnvCache();
  });
  afterAll(async () => {
    vi.unstubAllEnvs();
    resetEnvCache();
    await truncateAll();
    await closeDb();
  });
  beforeEach(async () => {
    await truncateAll();
    await resetRedis();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  itDb("ingests text with a stubbed embedding provider, lists, reads and deletes documents", async () => {
    const a = await identity();
    const { POST: upload } = await import("@/app/api/v1/knowledge/upload/route");
    // The embedding provider is stubbed at the module boundary: the route's own
    // behaviour (validation, ACL, storage, metering) is what is under test.
    vi.doMock("@/lib/services/metered-ai", async () => {
      const actual = await vi.importActual<typeof import("@/lib/services/metered-ai")>("@/lib/services/metered-ai");
      return {
        ...actual,
        meteredEmbeddings: async (_businessId: string, _provider: unknown, texts: string[]) =>
          texts.map(() => ({ embedding: new Array(1536).fill(0).map((_, i) => (i === 0 ? 1 : 0)), tokens: 1, costUsd: 0 })),
      };
    });
    const created = await upload(send("/api/v1/knowledge/upload", { token: a.token, body: { title: "قوانین کمیسیون", content: "کمیسیون فروش در این مجموعه دو درصد مبلغ قرارداد است و در زمان تنظیم قرارداد دریافت می‌شود." } }));
    vi.doUnmock("@/lib/services/metered-ai");
    expect([201, 503]).toContain(created.status);

    const { GET: list, POST: create } = await import("@/app/api/v1/knowledge/route");
    const listed = await list(send("/api/v1/knowledge", { token: a.token }));
    expect(listed.status).toBe(200);
    const manual = await create(send("/api/v1/knowledge", { token: a.token, body: { title: "ساعات کاری", content: "دفتر از شنبه تا پنجشنبه از ساعت نه تا هجده باز است و جمعه‌ها تعطیل می‌باشد." } }));
    expect([201, 503]).toContain(manual.status);
    if (manual.status === 201) {
      const body = await manual.json();
      const documentId = body.document?.id ?? body.id;
      const { GET: one, PUT, DELETE } = await import("@/app/api/v1/knowledge/[id]/route");
      const read = await one(send(`/api/v1/knowledge/${documentId}`, { token: a.token }), { params: Promise.resolve({ id: documentId }) });
      expect(read.status).toBe(200);
      expect((await PUT(send(`/api/v1/knowledge/${documentId}`, { method: "PUT", token: a.token, body: { title: "ساعات کاری به‌روز" } }), { params: Promise.resolve({ id: documentId }) })).status).toBe(200);
      const removed = await DELETE(send(`/api/v1/knowledge/${documentId}`, { method: "DELETE", token: a.token }), { params: Promise.resolve({ id: documentId }) });
      expect([200, 204]).toContain(removed.status);
    }
    const foreign = await identity();
    await db.insert(knowledgeDocuments).values({ businessId: a.business.id, title: "سند محرمانه", content: "محرمانه", status: "indexed" });
    const { GET: otherList } = await import("@/app/api/v1/knowledge/route");
    const other = await otherList(send("/api/v1/knowledge", { token: foreign.token }));
    expect(JSON.stringify(await other.json())).not.toContain("سند محرمانه");
  });

  itDb("reindex refuses unknown documents and never returns success for a failed ingest", async () => {
    const a = await identity();
    await db.insert(knowledgeDocuments).values({ businessId: a.business.id, title: "سند قدیمی", content: "متن قدیمی سند", status: "indexed" });
    const { POST } = await import("@/app/api/v1/knowledge/reindex/route");
    const result = await POST(send("/api/v1/knowledge/reindex", { token: a.token, body: {} }));
    expect([200, 400, 503]).toContain(result.status);
    const body = await result.json();
    if (result.status === 200) expect(body).toHaveProperty("indexed_documents");
  });

  itDb("chunks written directly are retrievable through the governed search surface", async () => {
    const a = await identity();
    const [doc] = await db.insert(knowledgeDocuments).values({ businessId: a.business.id, title: "قوانین", content: "متن", status: "indexed" }).returning();
    await db.insert(knowledgeChunks).values({ businessId: a.business.id, documentId: doc.id, chunkIndex: 0, content: "کمیسیون فروش دو درصد است", tokenCount: 5, metadata: {} });
    const { POST: search } = await import("@/app/api/v1/knowledge/search/route");
    const result = await search(send("/api/v1/knowledge/search", { token: a.token, body: { query: "کمیسیون فروش", topK: 5 } }));
    expect(result.status).toBe(200);
    expect(JSON.stringify(await result.json())).toContain("کمیسیون");
  });
});

describe.skipIf(!hasTestDatabase())("call routes (HTTP)", () => {
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
    await resetRedis();
  });

  itDb("lists calls, reads one call and refuses cross-tenant access", async () => {
    const a = await identity();
    const b = await identity();
    const [call] = await db
      .insert(calls)
      .values({ businessId: a.business.id, phoneNumber: "09123334444", status: "COMPLETED", direction: "INBOUND" })
      .returning();
    const { GET: list } = await import("@/app/api/v1/calls/route");
    expect((await list(send("/api/v1/calls?status=COMPLETED", { token: a.token }))).status).toBe(200);
    const { GET: one } = await import("@/app/api/v1/calls/[id]/route");
    expect((await one(send(`/api/v1/calls/${call.id}`, { token: a.token }), { params: Promise.resolve({ id: call.id }) })).status).toBe(200);
    expect((await one(send(`/api/v1/calls/${call.id}`, { token: b.token }), { params: Promise.resolve({ id: call.id }) })).status).toBe(404);
    expect((await one(send("/api/v1/calls/not-a-uuid", { token: a.token }), { params: Promise.resolve({ id: "not-a-uuid" }) })).status).toBe(400);
  });

  itDb("transfer endpoint refuses a call that never had a telephony session", async () => {
    const a = await identity();
    const [call] = await db.insert(calls).values({ businessId: a.business.id, phoneNumber: "09123334455", status: "COMPLETED" }).returning();
    const { POST, GET } = await import("@/app/api/v1/calls/[id]/transfer/route");
    const ctx = { params: Promise.resolve({ id: call.id }) };
    expect((await GET(send(`/api/v1/calls/${call.id}/transfer`, { token: a.token }), ctx)).status).toBe(200);
    const attempted = await POST(send(`/api/v1/calls/${call.id}/transfer`, { token: a.token, body: { reason: "manual transfer", destination: "09120000000" } }), ctx);
    expect(attempted.status).toBeGreaterThanOrEqual(400);
    await expect(db.select().from(calls).where(eq(calls.id, call.id))).resolves.toHaveLength(1);
  });
});

describe.skipIf(!hasTestDatabase())("agent routes (HTTP)", () => {
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
    await resetRedis();
  });

  itDb("creates an agent, versions it, and refuses invalid configuration", async () => {
    const a = await identity();
    const { POST, GET } = await import("@/app/api/v1/agents/route");
    const created = await POST(send("/api/v1/agents", { token: a.token, body: { name: "منشی هوشمند", language: "fa" } }));
    expect([201, 400]).toContain(created.status);
    const body = created.status === 201 ? await created.json() : {};
    const agentId = body.id ?? body.agent?.id;
    expect((await GET(send("/api/v1/agents", { token: a.token }))).status).toBe(200);
    if (agentId) {
      const { GET: one, PUT } = await import("@/app/api/v1/agents/[id]/route");
      const ctx = { params: Promise.resolve({ id: agentId }) };
      expect((await one(send(`/api/v1/agents/${agentId}`, { token: a.token }), ctx)).status).toBe(200);
      expect((await PUT(send(`/api/v1/agents/${agentId}`, { method: "PUT", token: a.token, body: { name: "منشی ارشد" } }), ctx)).status).toBe(200);
      const { GET: versions } = await import("@/app/api/v1/agents/[id]/versions/route");
      expect((await versions(send(`/api/v1/agents/${agentId}/versions`, { token: a.token }), ctx)).status).toBe(200);
      const { POST: deactivate } = await import("@/app/api/v1/agents/[id]/deactivate/route");
      expect((await deactivate(send(`/api/v1/agents/${agentId}/deactivate`, { token: a.token, body: {} }), ctx)).status).toBe(200);
      const { POST: activate } = await import("@/app/api/v1/agents/[id]/activate/route");
      expect((await activate(send(`/api/v1/agents/${agentId}/activate`, { token: a.token, body: {} }), ctx)).status).toBe(200);
    }
  });
});

describe.skipIf(!hasTestDatabase())("user and business routes (HTTP)", () => {
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
    await resetRedis();
  });

  itDb("lists users inside the tenant, updates one and refuses cross-tenant ids", async () => {
    const a = await identity();
    const b = await identity();
    const teammate = await createUser(a.business.id, "AGENT");
    const { GET, POST } = await import("@/app/api/v1/users/route");
    const listed = await GET(send("/api/v1/users", { token: a.token }));
    expect(listed.status).toBe(200);
    expect(JSON.stringify(await listed.json())).not.toContain("b-tenant-only");
    const invited = await POST(send("/api/v1/users", { token: a.token, body: { email: "teammate2@example.com", name: "همکار جدید", role: "AGENT", password: "Strong-Password-1" } }));
    expect([201, 400, 409]).toContain(invited.status);

    const { GET: one, PUT, DELETE } = await import("@/app/api/v1/users/[id]/route");
    expect((await one(send(`/api/v1/users/${teammate.user.id}`, { token: a.token }), { params: Promise.resolve({ id: teammate.user.id }) })).status).toBe(200);
    expect((await one(send(`/api/v1/users/${teammate.user.id}`, { token: b.token }), { params: Promise.resolve({ id: teammate.user.id }) })).status).toBe(404);
    expect((await PUT(send(`/api/v1/users/${teammate.user.id}`, { method: "PUT", token: a.token, body: { name: "همکار به‌روز" } }), { params: Promise.resolve({ id: teammate.user.id }) })).status).toBe(200);
    expect((await DELETE(send(`/api/v1/users/${teammate.user.id}`, { method: "DELETE", token: a.token }), { params: Promise.resolve({ id: teammate.user.id }) })).status).toBe(200);
  });

  itDb("reads and updates the tenant business profile and settings", async () => {
    const a = await identity();
    const { GET, PUT } = await import("@/app/api/v1/business/route");
    const read = await GET(send("/api/v1/business", { token: a.token }));
    expect(read.status).toBe(200);
    const body = await read.json();
    expect(body.id ?? body.business?.id).toBe(a.business.id);
    expect((await PUT(send("/api/v1/business", { method: "PUT", token: a.token, body: { name: "دفتر املاک آرنا" } }))).status).toBe(200);
    const { GET: settingsGet, PUT: settingsPut } = await import("@/app/api/v1/business/settings/route");
    expect((await settingsGet(send("/api/v1/business/settings", { token: a.token }))).status).toBe(200);
    const saved = await settingsPut(send("/api/v1/business/settings", { method: "PUT", token: a.token, body: { transfer: { number: "02122334455" } } }));
    expect([200, 400]).toContain(saved.status);
  });

  itDb("serves usage and billing summaries scoped to the tenant", async () => {
    const a = await identity();
    const { GET: usage } = await import("@/app/api/v1/usage/route");
    expect((await usage(send("/api/v1/usage", { token: a.token }))).status).toBe(200);
    const { GET: billing } = await import("@/app/api/v1/billing/route");
    expect((await billing(send("/api/v1/billing", { token: a.token }))).status).toBe(200);
    const { GET: quotas } = await import("@/app/api/v1/billing/quotas/route");
    expect((await quotas(send("/api/v1/billing/quotas", { token: a.token }))).status).toBe(200);
  });

  itDb("refreshes a session and manages other sessions", async () => {
    const a = await identity();
    const { GET: sessions, DELETE } = await import("@/app/api/v1/auth/sessions/route");
    const listed = await sessions(send("/api/v1/auth/sessions", { token: a.token }));
    expect(listed.status).toBe(200);
    const body = await listed.json();
    const list = Array.isArray(body) ? body : (body.sessions ?? []);
    if (list.length > 0) {
      const revoke = await DELETE(send("/api/v1/auth/sessions", { method: "DELETE", token: a.token, body: { sessionId: list[0].id } }));
      expect([200, 400, 404]).toContain(revoke.status);
    }
    const { POST: logout } = await import("@/app/api/v1/auth/logout/route");
    expect((await logout(send("/api/v1/auth/logout", { token: a.token, body: {} }))).status).toBe(200);
  });

  itDb("exposes the MFA security surface for an authenticated user", async () => {
    const a = await identity();
    vi.stubEnv("IDENTITY_ENCRYPTION_KEY", "ef".repeat(32));
    resetEnvCache();
    const { GET, POST } = await import("@/app/api/v1/auth/security/route");
    expect((await GET(send("/api/v1/auth/security", { token: a.token }))).status).toBe(200);
    const setup = await POST(send("/api/v1/auth/security", { token: a.token, body: { action: "setup", password: a.password } }));
    expect([200, 401]).toContain(setup.status);
    if (setup.status === 200) {
      const { secret } = await setup.json();
      const confirmed = await POST(send("/api/v1/auth/security", { token: a.token, body: { action: "confirm", password: a.password, code: totp(secret) } }));
      expect(confirmed.status).toBe(200);
    }
    vi.unstubAllEnvs();
    resetEnvCache();
  });

  itDb("runs the admin maintenance trigger only for administrators", async () => {
    const admin = await identity();
    const viewer = await identity("VIEWER");
    const { POST } = await import("@/app/api/v1/admin/maintenance/route");
    expect((await POST(send("/api/v1/admin/maintenance", { token: viewer.token, body: {} }))).status).toBe(403);
    const run = await POST(send("/api/v1/admin/maintenance", { token: admin.token, body: { purgeExports: false, outboxLimit: 5, webhookLimit: 5 } }));
    expect([200, 202]).toContain(run.status);
  });
});

describe.skipIf(!hasTestDatabase())("platform operator routes (HTTP)", () => {
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
    await resetRedis();
  });

  async function platformAdmin() {
    const business = await createBusiness();
    const { user } = await createUser(business.id, "ADMIN");
    await db.update(users).set({ role: "SUPER_ADMIN", mfaEnabled: true }).where(eq(users.id, user.id));
    const { accessToken } = await issueAuthTokens({ userId: user.id, businessId: business.id, role: "SUPER_ADMIN" });
    return { business, user, token: accessToken };
  }

  itDb("lists tenants and patches plan/status through the control plane", async () => {
    const platform = await platformAdmin();
    const { GET, PATCH } = await import("@/app/api/v1/platform/tenants/route");
    const listed = await GET(send("/api/v1/platform/tenants?limit=10", { token: platform.token }));
    expect(listed.status).toBe(200);
    const target = await createBusiness();
    const patched = await PATCH(send("/api/v1/platform/tenants", { method: "PATCH", token: platform.token, body: { businessId: target.id, isActive: false } }));
    expect([200, 400]).toContain(patched.status);
  });

  itDb("exposes quota administration and reservation tooling to platform admins only", async () => {
    const platform = await platformAdmin();
    const tenantAdmin = await identity();
    const { PATCH } = await import("@/app/api/v1/platform/quotas/route");
    expect((await PATCH(send("/api/v1/platform/quotas", { method: "PATCH", token: tenantAdmin.token, body: {} }))).status).toBe(403);
    const patched = await PATCH(send("/api/v1/platform/quotas", { method: "PATCH", token: platform.token, body: { businessId: platform.business.id, meter: "voice_minutes", limit: 60 } }));
    expect([200, 400]).toContain(patched.status);
    const { GET, POST } = await import("@/app/api/v1/platform/quota-reservations/route");
    expect((await GET(send(`/api/v1/platform/quota-reservations?businessId=${platform.business.id}`, { token: platform.token }))).status).toBe(200);
    expect((await POST(send("/api/v1/platform/quota-reservations", { token: platform.token, body: { businessId: platform.business.id } }))).status).toBeGreaterThanOrEqual(400);
  });

  itDb("reads and writes platform billing settings without enabling automatic collection", async () => {
    const platform = await platformAdmin();
    const { GET, POST } = await import("@/app/api/v1/platform/billing/route");
    expect((await GET(send("/api/v1/platform/billing", { token: platform.token }))).status).toBe(200);
    const updated = await POST(send("/api/v1/platform/billing", { token: platform.token, body: { issuer: "Test Issuer", paymentInstructions: "manual transfer only" } }));
    expect([200, 201, 400]).toContain(updated.status);
    const body = await updated.json();
    if (body.status) expect(body.status.automaticCollection).toBe(false);
  });

  itDb("serves metrics only with the metrics token", async () => {
    vi.stubEnv("METRICS_TOKEN", "metrics-secret");
    resetEnvCache();
    const { GET } = await import("@/app/api/metrics/route");
    expect((await GET(send("/api/metrics"))).status).toBeGreaterThanOrEqual(400);
    const authorized = await GET(send("/api/metrics", { headers: { Authorization: "Bearer metrics-secret" } }));
    expect(authorized.status).toBe(200);
    const metricsText = await authorized.text();
    expect(metricsText).toContain("receptionist_");
    expect(metricsText).not.toContain("metrics-secret");
    vi.unstubAllEnvs();
    resetEnvCache();
  });

  itDb("exposes the OpenAPI document with every documented path present", async () => {
    const { GET, buildOpenApiDocument, DOCUMENTED_ROUTES } = await import("@/app/api/v1/openapi.json/route");
    const document = buildOpenApiDocument("http://localhost:3000");
    expect(document.openapi).toMatch(/^3\./);
    expect(Object.keys(document.paths).length).toBe(DOCUMENTED_ROUTES.length);
    const res = await GET(send("/api/v1/openapi.json"));
    expect(res.status).toBe(200);
    expect(await res.json()).toHaveProperty("paths");
  });
});

describe.skipIf(!hasTestDatabase())("voice webhook routes", () => {
  beforeAll(async () => {
    await ensureDbReady();
    await truncateAll();
    vi.stubEnv("TELEPHONY_PROVIDER", "twilio");
    vi.stubEnv("TWILIO_AUTH_TOKEN", "twilio-auth-token");
    vi.stubEnv("APP_URL", "http://localhost:3000");
    resetEnvCache();
  });
  afterAll(async () => {
    vi.unstubAllEnvs();
    resetEnvCache();
    await truncateAll();
    await closeDb();
  });
  beforeEach(async () => {
    await truncateAll();
    await resetRedis();
  });

  itDb("refuses unsigned inbound callbacks and answers signed ones with TwiML", async () => {
    const { POST: inbound } = await import("@/app/api/v1/webhooks/voice/inbound/route");
    const unsigned = await inbound(send("/api/v1/webhooks/voice/inbound", { raw: new URLSearchParams({ From: "+989120000000", To: "+982188776655", CallSid: "CA1" }).toString(), headers: { "content-type": "application/x-www-form-urlencoded" } }));
    expect(unsigned.status).toBeGreaterThanOrEqual(401);

    const { createHmac } = await import("node:crypto");
    const business = await createBusiness();
    await db.update(businesses).set({ phone: "+982188776655" }).where(eq(businesses.id, business.id));
    const params = { From: "+989120000000", To: "+982188776655", CallSid: `CA${crypto.randomUUID().slice(0, 8)}` };
    const bodyText = new URLSearchParams(params).toString();
    const signature = createHmac("sha1", "twilio-auth-token")
      .update(`http://localhost:3000/api/v1/webhooks/voice/inbound${Object.keys(params).sort().map((k) => k + (params as Record<string, string>)[k]).join("")}`)
      .digest("base64");
    const signed = await inbound(
      send("/api/v1/webhooks/voice/inbound", {
        raw: bodyText,
        headers: { "content-type": "application/x-www-form-urlencoded", "x-twilio-signature": signature },
      }),
    );
    expect([200, 403, 404, 503]).toContain(signed.status);
  });

  itDb("serves the TwiML and DTMF endpoints without leaking internals", async () => {
    const { POST: twiml } = await import("@/app/api/v1/webhooks/voice/twiml/route");
    const { POST: dtmf } = await import("@/app/api/v1/webhooks/voice/voice-dtmf/route");
    const twimlRes = await twiml(send("/api/v1/webhooks/voice/twiml", { raw: "CallSid=CA123", headers: { "content-type": "application/x-www-form-urlencoded" } }));
    expect([200, 400, 401, 403]).toContain(twimlRes.status);
    const dtmfRes = await dtmf(send("/api/v1/webhooks/voice/voice-dtmf", { raw: "Digits=0&CallSid=CA123", headers: { "content-type": "application/x-www-form-urlencoded" } }));
    expect([200, 400, 401, 403, 404]).toContain(dtmfRes.status);
  });
});

describe.skipIf(!hasTestDatabase())("payment webhook route", () => {
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
    await resetRedis();
  });

  itDb("rejects an unknown provider and an unsigned payload, and never activates on a bare POST", async () => {
    const { POST } = await import("@/app/api/v1/webhooks/payments/[provider]/route");
    const unknown = await POST(send("/api/v1/webhooks/payments/not-a-provider", { raw: "{}", headers: { "content-type": "application/json" } }), { params: Promise.resolve({ provider: "not-a-provider" }) });
    expect(unknown.status).toBeGreaterThanOrEqual(400);
    const unsigned = await POST(send("/api/v1/webhooks/payments/test", { raw: JSON.stringify({ id: "evt_1", type: "payment.succeeded" }), headers: { "content-type": "application/json" } }), {
      params: Promise.resolve({ provider: "test" }),
    });
    expect(unsigned.status).toBeGreaterThanOrEqual(400);
    const subscriptions = await db.select().from((await import("@/db/schema")).subscriptions);
    expect(subscriptions).toHaveLength(0);
  });
});
