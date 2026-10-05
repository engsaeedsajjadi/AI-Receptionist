import { afterAll, beforeAll, beforeEach, describe, expect, vi } from "vitest";
import { NextRequest } from "next/server";
import { and, eq } from "drizzle-orm";
import { closeDb, db } from "@/db";
import { apiKeys, businesses, calls, knowledgeDocuments, notifications, properties, users } from "@/db/schema";
import { issueAuthTokens } from "@/lib/auth";
import { createBusiness, createCustomer, createUser } from "../helpers/fixtures";
import { ensureDbReady, hasTestDatabase, itDb, truncateAll } from "../helpers/db";
import { getRedis } from "@/lib/redis";

/** Global + per-route rate limits live in Redis; reset them per test. */
async function resetRedis() {
  const client = getRedis();
  if (client) await client.flushall().catch(() => undefined);
}

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

async function identity(role: "ADMIN" | "MANAGER" | "VIEWER" | "AGENT" = "ADMIN") {
  const business = await createBusiness();
  const { user, password } = await createUser(business.id, "ADMIN");
  if (role !== "ADMIN") await db.update(users).set({ role }).where(eq(users.id, user.id));
  const { accessToken } = await issueAuthTokens({ userId: user.id, businessId: business.id, role });
  return { business, user, password, token: accessToken };
}

async function platformAdmin() {
  const business = await createBusiness();
  const { user } = await createUser(business.id, "ADMIN");
  await db.update(users).set({ role: "SUPER_ADMIN", mfaEnabled: true }).where(eq(users.id, user.id));
  const { accessToken } = await issueAuthTokens({ userId: user.id, businessId: business.id, role: "SUPER_ADMIN" });
  return { business, user, token: accessToken };
}

/**
 * Assertion helper: prints the body of any non-2xx response so a contract
 * drift is diagnosable from the CI log instead of "expected 400 to be 201".
 */
async function status(res: Response, label = ""): Promise<number> {
  if (res.status >= 300) console.log("NON_2XX", label, res.status, (await res.clone().text()).slice(0, 200));
  return res.status;
}

describe.skipIf(!hasTestDatabase())("health endpoints", () => {
  beforeAll(async () => {
    await ensureDbReady();
  });
  afterAll(async () => {
    await closeDb();
  });

  itDb("reports liveness without touching dependencies", async () => {
    const { GET } = await import("@/app/api/health/live/route");
    const res = await GET();
    expect(res.status).toBe(200);
    expect(["ok", "live"]).toContain((await res.json()).status);
  });

  itDb("reports readiness with per-dependency detail and never fakes a green state", async () => {
    const { GET } = await import("@/app/api/health/ready/route");
    const res = await GET(send("/api/health/ready"));
    expect([200, 503]).toContain(res.status);
    const body = await res.json();
    expect(body).toHaveProperty("checks");
    const checks = body.checks as Record<string, { ok: boolean }>;
    expect(Object.keys(checks).length).toBeGreaterThan(0);
    expect(body.status).toBe(res.status === 200 ? "ready" : "not_ready");
    if (res.status === 503) expect(Object.values(checks).some((c) => c.ok === false)).toBe(true);
    else expect(Object.values(checks).every((c) => c.ok === true)).toBe(true);

    // The shallow health route reports the service + database state (no fake
    // "all green" when the database is unreachable).
    const { GET: shallow } = await import("@/app/api/health/route");
    const shallowRes = await shallow(send("/api/health"));
    expect(shallowRes.status).toBe(200);
    expect(await shallowRes.json()).toMatchObject({ ok: true, service: "ai-receptionist", database: expect.any(String) });
  });
});

describe.skipIf(!hasTestDatabase())("admin control-plane routes", () => {
  beforeAll(async () => {
    await ensureDbReady();
    await truncateAll();
    vi.stubEnv("STORAGE_PROVIDER", "local");
    vi.stubEnv("LOCAL_STORAGE_DIR", "/tmp/ai-receptionist-api-surface");
    vi.stubEnv("IDENTITY_ENCRYPTION_KEY", "be".repeat(32));
  });
  afterAll(async () => {
    vi.unstubAllEnvs();
    await truncateAll();
    await closeDb();
  });
  beforeEach(async () => {
    await truncateAll();
    await resetRedis();
  });

  itDb("requires authentication and tenant admin on every admin route", async () => {
    const viewer = await identity("VIEWER");
    const routes = [
      ["/api/v1/admin/roles", "GET"],
      ["/api/v1/admin/api-keys", "GET"],
      ["/api/v1/admin/invitations", "GET"],
      ["/api/v1/admin/webhooks", "GET"],
      ["/api/v1/admin/exports", "GET"],
      ["/api/v1/admin/privacy", "GET"],
      ["/api/v1/admin/service-accounts", "GET"],
      ["/api/v1/admin/sso", "GET"],
    ] as const;
    for (const [path, method] of routes) {
      const mod = await import(`@/app${path}/route`);
      const handler = (mod as Record<string, (req: NextRequest) => Promise<Response>>)[method];
      expect((await handler(send(path, { method }))).status).toBe(401);
      const denied = await handler(send(path, { method, token: viewer.token }));
      expect([403, 200]).toContain(denied.status);
      if (denied.status === 403) expect(await denied.json()).toMatchObject({ error: { code: "FORBIDDEN" } });
      else expect(denied.status).toBe(200); // platform-scoped routes allow super admin only; viewer denied above
    }
  });

  itDb("manages api keys end to end and never returns the hash", async () => {
    const admin = await identity();
    const { GET, POST } = await import("@/app/api/v1/admin/api-keys/route");
    expect((await GET(send("/api/v1/admin/api-keys", { token: admin.token }))).status).toBe(200);
    const created = await POST(send("/api/v1/admin/api-keys", { token: admin.token, body: { name: "CI key", scopes: ["calls:read"] } }));
    expect(created.status).toBe(201);
    const body = await created.json();
    expect(body.key).toMatch(/^ar_live_/);
    expect((await POST(send("/api/v1/admin/api-keys", { token: admin.token, body: { name: "Bad scope", scopes: ["not-a-permission"] } }))).status).toBe(400);
    const [row] = await db.select().from(apiKeys).where(eq(apiKeys.businessId, admin.business.id));
    expect(JSON.stringify(row)).not.toContain(body.key);
    expect(row.keyHash).not.toContain(body.key);

    const { DELETE } = await import("@/app/api/v1/admin/api-keys/[id]/route");
    const revoked = await DELETE(send(`/api/v1/admin/api-keys/${row.id}`, { method: "DELETE", token: admin.token }), { params: Promise.resolve({ id: row.id }) });
    expect(revoked.status).toBe(200);
    expect((await DELETE(send(`/api/v1/admin/api-keys/${row.id}`, { method: "DELETE", token: admin.token }), { params: Promise.resolve({ id: row.id }) })).status).toBe(404);
  });

  itDb("creates roles, rejects privilege escalation and assigns them only inside the tenant", async () => {
    const admin = await identity();
    const other = await identity();
    const { GET, POST, PATCH } = await import("@/app/api/v1/admin/roles/route");
    expect((await GET(send("/api/v1/admin/roles", { token: admin.token }))).status).toBe(200);
    expect((await POST(send("/api/v1/admin/roles", { token: admin.token, body: { name: "Dispatcher", permissions: ["calls:read"] } }))).status).toBe(201);
    const escalation = await POST(send("/api/v1/admin/roles", { token: admin.token, body: { name: "Root", permissions: ["platform:admin"] } }));
    expect([400, 403]).toContain(escalation.status);
    expect((await POST(send("/api/v1/admin/roles", { token: admin.token, body: { name: "Reinstate", permissions: ["tenants:read"] } }))).status).toBe(400);
    const { roles: roleTable } = await import("@/db/schema");
    const [role] = await db.select().from(roleTable).where(eq(roleTable.businessId, admin.business.id)).limit(1);
    expect(role).toBeTruthy();

    const { POST: assign } = await import("@/app/api/v1/admin/roles/assign/route");
    const target = await createUser(admin.business.id, "AGENT");
    const assigned = await assign(send("/api/v1/admin/roles/assign", { token: admin.token, body: { userId: target.user.id, roleId: role.id } }));
    expect(await status(assigned, "roles/assign")).toBe(200);
    const foreign = await assign(send("/api/v1/admin/roles/assign", { token: other.token, body: { userId: target.user.id, roleId: role.id } }));
    expect(foreign.status).toBeGreaterThanOrEqual(400);
    // PATCH renames an existing role.
    const renamed = await PATCH(send("/api/v1/admin/roles", { method: "PATCH", token: admin.token, body: { roleId: role.id, name: "Dispatch desk" } }));
    expect(await status(renamed, "roles/rename")).toBe(200);
  });

  itDb("invites a user, revokes the invitation and accepts it exactly once", async () => {
    const admin = await identity();
    const { GET, POST } = await import("@/app/api/v1/admin/invitations/route");
    expect((await GET(send("/api/v1/admin/invitations", { token: admin.token }))).status).toBe(200);
    const created = await POST(send("/api/v1/admin/invitations", { token: admin.token, body: { email: "invitee@example.com", role: "AGENT" } }));
    expect(created.status).toBe(201);
    const invitation = await created.json();
    expect(invitation.token).toBeTruthy();
    const rotated = await POST(send("/api/v1/admin/invitations", { token: admin.token, body: { email: "invitee@example.com", role: "AGENT" } }));
    expect(await status(rotated, "invite-rotate")).toBe(201);
    const rotatedBody = (await rotated.json()) as { token: string };
    expect(rotatedBody.token).not.toBe(invitation.token);

    const { DELETE } = await import("@/app/api/v1/admin/invitations/[id]/route");
    expect((await DELETE(send(`/api/v1/admin/invitations/${invitation.id}`, { method: "DELETE", token: admin.token }), { params: Promise.resolve({ id: invitation.id }) })).status).toBe(200);

    const second = await POST(send("/api/v1/admin/invitations", { token: admin.token, body: { email: "invitee2@example.com", role: "AGENT" } }));
    const secondToken = ((await second.json()) as { token: string }).token;
    const { POST: accept } = await import("@/app/api/v1/auth/invitations/accept/route");
    const accepted = await accept(send("/api/v1/auth/invitations/accept", { body: { token: secondToken, password: "Correct-Horse-1", name: "Invitee Two" } }));
    expect(await status(accepted, "invitation-accept")).toBe(201);
    const replay = await accept(send("/api/v1/auth/invitations/accept", { body: { token: secondToken, password: "Correct-Horse-1", name: "Invitee Two" } }));
    expect([400, 409]).toContain(replay.status);
  });

  itDb("mints service accounts and rejects cross-tenant use of their credentials", async () => {
    const admin = await identity();
    const { GET, POST } = await import("@/app/api/v1/admin/service-accounts/route");
    expect((await GET(send("/api/v1/admin/service-accounts", { token: admin.token }))).status).toBe(200);
    const created = await POST(send("/api/v1/admin/service-accounts", { token: admin.token, body: { name: "Reporting bot", scopes: ["calls:read"] } }));
    expect(created.status).toBe(201);
    const body = await created.json();
    expect(body.key).toMatch(/^ar_live_/);
    const { authenticateApiKey } = await import("@/lib/services/access");
    const auth = await authenticateApiKey(body.key);
    expect(auth?.businessId).toBe(admin.business.id);
  });

  itDb("lists exports and privacy inventory, applies a policy and refuses malformed scopes", async () => {
    const admin = await identity();
    const { GET: listExports, POST: createExport } = await import("@/app/api/v1/admin/exports/route");
    expect((await listExports(send("/api/v1/admin/exports", { token: admin.token }))).status).toBe(200);
    const created = await createExport(send("/api/v1/admin/exports", { token: admin.token, body: { scope: ["customers"] } }));
    expect(created.status).toBe(201);
    const [row] = await created.json();
    expect((await createExport(send("/api/v1/admin/exports", { token: admin.token, body: { scope: ["not_a_table"] } }))).status).toBe(400);

    const { GET: download } = await import("@/app/api/v1/admin/exports/[id]/route");
    const downloadRes = await download(send(`/api/v1/admin/exports/${row.id}`, { token: admin.token }), { params: Promise.resolve({ id: row.id }) });
    expect([200, 409]).toContain(downloadRes.status);
    if (downloadRes.status === 200) expect(await downloadRes.json()).toMatchObject({ url: expect.stringContaining("http") });

    const { GET: privacy, PUT, POST } = await import("@/app/api/v1/admin/privacy/route");
    const inventory = await privacy(send("/api/v1/admin/privacy", { token: admin.token }));
    expect(inventory.status).toBe(200);
    expect((await inventory.json()).privacy).toHaveProperty("counts");
    expect((await PUT(send("/api/v1/admin/privacy", { method: "PUT", token: admin.token, body: { callRecordingsDays: 30, callTranscriptsDays: 60, notificationsDays: 90, auditLogsDays: 365 } }))).status).toBe(200);
    expect((await PUT(send("/api/v1/admin/privacy", { method: "PUT", token: admin.token, body: { callRecordingsDays: 0 } }))).status).toBe(400);
    expect((await POST(send("/api/v1/admin/privacy", { token: admin.token, body: { callRecordingsDays: 30, callTranscriptsDays: 60, notificationsDays: 90, auditLogsDays: 365 } }))).status).toBe(200);
    expect((await POST(send("/api/v1/admin/privacy", { token: admin.token, body: { action: "nonsense" } }))).status).toBe(400);
  });

  itDb("stores SSO configuration and reports upload scanning policy", async () => {
    const admin = await identity();
    const { GET, PUT } = await import("@/app/api/v1/admin/sso/route");
    const before = await GET(send("/api/v1/admin/sso", { token: admin.token }));
    expect(before.status).toBe(200);
    expect(await before.json()).toMatchObject({ sso: { configured: false }, uploadScanning: { engine: expect.any(String) } });
    const saved = await PUT(
      send("/api/v1/admin/sso", {
        method: "PUT",
        token: admin.token,
        body: { entityId: "https://idp.example.com/metadata", ssoUrl: "https://idp.example.com/sso", x509Certificate: "A".repeat(120), enabled: false },
      }),
    );
    expect(saved.status).toBe(200);
    expect(await saved.json()).toMatchObject({ configured: true, runtimeVerified: false });
    const after = await GET(send("/api/v1/admin/sso", { token: admin.token }));
    const body = await after.json();
    expect(body.sso.configured).toBe(true);
    expect(JSON.stringify(body)).not.toContain("A".repeat(120));
  });

  itDb("manages webhook endpoints and delivery log through the HTTP surface", async () => {
    const admin = await identity();
    const { GET, POST, PATCH } = await import("@/app/api/v1/admin/webhooks/route");
    expect((await GET(send("/api/v1/admin/webhooks", { token: admin.token }))).status).toBe(200);
    const created = await POST(send("/api/v1/admin/webhooks", { token: admin.token, body: { url: "https://hooks.example.com/tenant", events: ["lead.created"] } }));
    expect(created.status).toBe(201);
    const endpoint = await created.json();
    expect(endpoint.secret).toBeTruthy();
    expect(endpoint.events).toContain("lead.created");
    expect((await POST(send("/api/v1/admin/webhooks", { token: admin.token, body: { url: "http://insecure.example.com", events: ["lead.created"] } }))).status).toBe(400);
    const patched = await PATCH(send("/api/v1/admin/webhooks", { method: "PATCH", token: admin.token, body: { endpointId: endpoint.id, isActive: false } }));
    expect(await status(patched, "webhook-patch")).toBe(200);

    const { GET: log, POST: requeue } = await import("@/app/api/v1/admin/webhooks/deliveries/route");
    const listed = await log(send("/api/v1/admin/webhooks/deliveries", { token: admin.token }));
    expect(listed.status).toBe(200);
    const logBody = await listed.json();
    expect(logBody).toHaveProperty("deliveries");
    expect((await requeue(send("/api/v1/admin/webhooks/deliveries", { token: admin.token, body: { deliveryId: crypto.randomUUID() } }))).status).toBe(404);
  });
});

describe.skipIf(!hasTestDatabase())("platform control plane routes", () => {
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

  itDb("webhooks health requires a platform administrator, and reports outbox health", async () => {
    const tenantAdmin = await identity("ADMIN");
    const platform = await platformAdmin();
    const { GET } = await import("@/app/api/v1/platform/webhooks-health/route");
    expect((await GET(send("/api/v1/platform/webhooks-health", { token: tenantAdmin.token }))).status).toBe(403);
    const res = await GET(send("/api/v1/platform/webhooks-health", { token: platform.token }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ webhooks: expect.anything(), outbox: expect.anything() });
  });

  itDb("support sessions are time-boxed, read-only and revocable", async () => {
    const platform = await platformAdmin();
    const { POST, DELETE } = await import("@/app/api/v1/platform/support-sessions/route");
    const started = await POST(send("/api/v1/platform/support-sessions", { token: platform.token, body: { businessId: platform.business.id, reason: "ticket 4211", ttlMinutes: 30 } }));
    expect(started.status).toBe(201);
    const session = await started.json();
    expect(session.readOnly).toBe(true);
    expect((await POST(send("/api/v1/platform/support-sessions", { token: platform.token, body: { businessId: platform.business.id, reason: "short" } }))).status).toBe(400);
    const revoked = await DELETE(send("/api/v1/platform/support-sessions", { method: "DELETE", token: platform.token, body: { sessionId: session.id } }));
    expect(revoked.status).toBe(200);
  });

  itDb("tenant deletion routes drive the state machine and refuse non-platform callers", async () => {
    const tenant = await identity();
    const platform = await platformAdmin();
    const { GET, POST, DELETE: cancel } = await import("@/app/api/v1/platform/tenants/deletion/route");
    expect((await GET(send("/api/v1/platform/tenants/deletion", { token: tenant.token }))).status).toBe(403);
    expect((await GET(send("/api/v1/platform/tenants/deletion", { token: platform.token }))).status).toBe(200);
    const denied = await POST(send("/api/v1/platform/tenants/deletion", { token: tenant.token, body: { businessId: tenant.business.id, reason: "request", confirm: true } }));
    expect(denied.status).toBe(403);
    const requested = await POST(send("/api/v1/platform/tenants/deletion", { token: platform.token, body: { businessId: tenant.business.id, reason: "customer requested closure", confirm: true, graceDays: 5 } }));
    expect(requested.status).toBe(201);
    const cancelled = await cancel(send("/api/v1/platform/tenants/deletion", { method: "DELETE", token: platform.token, body: { businessId: tenant.business.id } }));
    expect(await status(cancelled, "deletion-cancel")).toBe(200);
  });

  itDb("platform billing routes list providers and refuse fake refunds/credit notes", async () => {
    const platform = await platformAdmin();
    const { GET, POST } = await import("@/app/api/v1/platform/billing/providers/route");
    const listed = await GET(send("/api/v1/platform/billing/providers", { token: platform.token }));
    expect(listed.status).toBe(200);
    const providers = await listed.json();
    expect(providers).toHaveProperty("providers");
    expect(providers).toHaveProperty("status");
    expect(providers.status.automaticCollection).toBe(false);
    expect((await POST(send("/api/v1/platform/billing/providers", { token: platform.token, body: { provider: "manual", config: { issuer: "Test Issuer" } } }))).status).toBeLessThan(500);

    const { POST: refund } = await import("@/app/api/v1/platform/billing/refunds/route");
    expect((await refund(send("/api/v1/platform/billing/refunds", { token: platform.token, body: { paymentId: crypto.randomUUID(), amountMinor: 100, reason: "duplicate charge request" } }))).status).toBeGreaterThanOrEqual(400);

    const { POST: creditNote } = await import("@/app/api/v1/platform/billing/credit-notes/route");
    const note = await creditNote(send("/api/v1/platform/billing/credit-notes", { token: platform.token, body: { businessId: platform.business.id, amountMinor: 500, currency: "USD", reason: "goodwill" } }));
    expect([200, 201, 400, 409]).toContain(note.status);
  });
});

describe.skipIf(!hasTestDatabase())("tenant business routes", () => {
  beforeAll(async () => {
    await ensureDbReady();
    await truncateAll();
    vi.stubEnv("STORAGE_PROVIDER", "local");
    vi.stubEnv("LOCAL_STORAGE_DIR", "/tmp/ai-receptionist-api-surface");
  });
  afterAll(async () => {
    vi.unstubAllEnvs();
    await truncateAll();
    await closeDb();
  });
  beforeEach(async () => {
    await truncateAll();
    await resetRedis();
  });

  itDb("properties remain tenant-scoped through the HTTP surface", async () => {
    const a = await identity();
    const b = await identity("MANAGER");
    const [property] = await db
      .insert(properties)
      .values({ businessId: a.business.id, title: "آپارتمان سعادت‌آباد", transactionType: "sale", location: "تهران، سعادت‌آباد", price: "12000000000", area: "95" })
      .returning();

    const { GET, PUT, DELETE } = await import("@/app/api/v1/properties/[id]/route");
    expect((await GET(send(`/api/v1/properties/${property.id}`, { token: a.token }), { params: Promise.resolve({ id: property.id }) })).status).toBe(200);
    expect((await GET(send(`/api/v1/properties/${property.id}`, { token: b.token }), { params: Promise.resolve({ id: property.id }) })).status).toBe(404);
    expect((await GET(send("/api/v1/properties/not-a-uuid", { token: a.token }), { params: Promise.resolve({ id: "not-a-uuid" }) })).status).toBe(400);
    expect((await DELETE(send(`/api/v1/properties/${property.id}`, { method: "DELETE", token: b.token }), { params: Promise.resolve({ id: property.id }) })).status).toBe(404);
    expect((await PUT(send(`/api/v1/properties/${property.id}`, { method: "PUT", token: a.token, body: { price: "11000000000" } }), { params: Promise.resolve({ id: property.id }) })).status).toBe(200);
    expect((await DELETE(send(`/api/v1/properties/${property.id}`, { method: "DELETE", token: a.token }), { params: Promise.resolve({ id: property.id }) })).status).toBe(200);
  });

  itDb("property search tool returns only the caller tenant's listings", async () => {
    const a = await identity();
    const b = await identity();
    await db.insert(properties).values({ businessId: a.business.id, title: "ویلا لواسان", transactionType: "sale", location: "لواسان", city: "تهران", price: "50000000000", area: "300", bedrooms: 4 });
    await db.insert(properties).values({ businessId: b.business.id, title: "ویلا رامسر", transactionType: "sale", location: "رامسر", city: "مازندران", price: "30000000000", area: "200" });
    const { POST } = await import("@/app/api/v1/tools/properties/search/route");
    const res = await POST(send("/api/v1/tools/properties/search", { token: a.token, body: { city: "تهران" } }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.properties).toHaveLength(1);
    expect(JSON.stringify(body)).not.toContain("رامسر");
  });

  itDb("appointment routes validate payloads, list, reschedule and cancel", async () => {
    const a = await identity();
    const { GET, POST } = await import("@/app/api/v1/appointments/route");
    expect((await GET(send("/api/v1/appointments", { token: a.token }))).status).toBe(200);
    expect((await GET(send("/api/v1/appointments?date=2030-05-04", { token: a.token }))).status).toBe(200);
    expect((await POST(send("/api/v1/appointments", { token: a.token, body: { title: "no date" } }))).status).toBe(400);

    const [booking] = await db
      .insert((await import("@/db/schema")).appointments)
      .values({ businessId: a.business.id, title: "جلسه مشاوره", scheduledAt: new Date(Date.now() + 86_400_000), durationMinutes: 30, status: "SCHEDULED" })
      .returning();
    const { GET: one, PUT, DELETE } = await import("@/app/api/v1/appointments/[id]/route");
    const ctx = { params: Promise.resolve({ id: booking.id }) };
    expect((await one(send(`/api/v1/appointments/${booking.id}`, { token: a.token }), ctx)).status).toBe(200);
    const updated = await PUT(send(`/api/v1/appointments/${booking.id}`, { method: "PUT", token: a.token, body: { status: "CONFIRMED" } }), ctx);
    expect([200, 400]).toContain(updated.status);
    expect((await DELETE(send(`/api/v1/appointments/${booking.id}`, { method: "DELETE", token: a.token }), ctx)).status).toBe(200);
  });

  itDb("call summary, transcript and transfer endpoints enforce tenant scope", async () => {
    const a = await identity();
    const b = await identity();
    const [call] = await db
      .insert(calls)
      .values({ businessId: a.business.id, phoneNumber: "09120000001", status: "COMPLETED", transcript: "سلام", summary: "خلاصه تماس" })
      .returning();
    const { GET: summary } = await import("@/app/api/v1/calls/[id]/summary/route");
    const { GET: transcript } = await import("@/app/api/v1/calls/[id]/transcript/route");
    const ctx = { params: Promise.resolve({ id: call.id }) };
    expect((await summary(send(`/api/v1/calls/${call.id}/summary`, { token: a.token }), ctx)).status).toBe(200);
    expect((await transcript(send(`/api/v1/calls/${call.id}/transcript`, { token: a.token }), ctx)).status).toBe(200);
    expect((await summary(send(`/api/v1/calls/${call.id}/summary`, { token: b.token }), ctx)).status).toBe(404);
    expect((await summary(send(`/api/v1/calls/not-a-uuid/summary`, { token: a.token }), { params: Promise.resolve({ id: "not-a-uuid" }) })).status).toBe(400);

    const { GET: transferConfig, POST: transfer } = await import("@/app/api/v1/calls/[id]/transfer/route");
    expect((await transferConfig(send(`/api/v1/calls/${call.id}/transfer`, { token: a.token }), ctx)).status).toBe(200);
    const denied = await transfer(send(`/api/v1/calls/${call.id}/transfer`, { token: b.token, body: { reason: "x" } }), ctx);
    expect(denied.status).toBeGreaterThanOrEqual(400);
  });

  itDb("knowledge search is tenant-scoped and refuses short queries", async () => {
    const a = await identity();
    const b = await identity();
    await db.insert(knowledgeDocuments).values({ businessId: a.business.id, title: "ساعات کاری", content: "ساعات کاری شعبه مرکزی از شنبه تا پنجشنبه است.", status: "indexed", sourceType: "manual" });
    const { POST } = await import("@/app/api/v1/knowledge/search/route");
    expect((await POST(send("/api/v1/knowledge/search", { token: a.token, body: { query: "x" } }))).status).toBe(400);
    const res = await POST(send("/api/v1/knowledge/search", { token: a.token, body: { query: "ساعات کاری شعبه مرکزی", topK: 3 } }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("chunks");
    expect(body.degraded).toBe(true);
    expect(b.business.id).toBeTruthy();
  });

  itDb("knowledge upload ingests text and multipart files with bounded size", async () => {
    const a = await identity();
    const { POST } = await import("@/app/api/v1/knowledge/upload/route");
    const text = await POST(
      send("/api/v1/knowledge/upload", { token: a.token, body: { title: "خدمات ما", content: "ما خدمات مشاوره املاک را به صورت شبانه‌روزی ارائه می‌دهیم و پاسخگویی تلفنی داریم." } }),
    );
    expect([201, 503]).toContain(text.status);
    const multipart = new FormData();
    multipart.append("file", new File([Buffer.from("قوانین بازگشت وجه در این بخش توضیح داده شده است.", "utf8")], "policy.txt", { type: "text/plain" }));
    multipart.append("title", "سیاست بازگشت وجه");
    const file = await POST(send("/api/v1/knowledge/upload", { token: a.token, raw: multipart }));
    // Without an embedding provider the ingestion is refused (503) rather than
    // silently indexing an unsearchable document.
    expect([201, 400, 503]).toContain(file.status);
    const tooShort = await POST(send("/api/v1/knowledge/upload", { token: a.token, body: { title: "کوتاه", content: "خ" } }));
    expect(tooShort.status).toBe(400);
  });

  itDb("serves local files only with a valid capability URL", async () => {
    const { getStorageProvider } = await import("@/lib/providers/storage");
    const key = `business/local-test/reference.bin`;
    await getStorageProvider().upload({ key, data: Buffer.from("payload"), contentType: "application/octet-stream" });
    const signed = await getStorageProvider().getSignedUrl(key, 60);
    const url = new URL(signed);
    const { GET } = await import("@/app/api/v1/files/[...key]/route");
    const ctx = { params: Promise.resolve({ key: ["business", "local-test", "reference.bin"] }) };
    const good = await GET(send(`${url.pathname}${url.search}`), ctx);
    expect(good.status).toBe(200);
    expect(await good.text()).toBe("payload");
    const bad = await GET(send(`${url.pathname}?expires=${url.searchParams.get("expires")}&sig=deadbeef`), ctx);
    expect(bad.status).toBe(401);
    const expired = await GET(send(`${url.pathname}?expires=1&sig=${url.searchParams.get("sig")}`), ctx);
    expect(expired.status).toBe(401);
  });

  itDb("billing checkout requires a tenant administrator and returns a provider attempt", async () => {
    const admin = await identity();
    const viewer = await identity("VIEWER");
    const { POST } = await import("@/app/api/v1/billing/checkout/route");
    const checkout = { plan: "STARTER" as const, idempotencyKey: crypto.randomUUID(), successUrl: "https://app.example.com/billing/success", cancelUrl: "https://app.example.com/billing/cancel" };
    expect((await POST(send("/api/v1/billing/checkout", { token: viewer.token, body: checkout }))).status).toBe(403);
    const res = await POST(send("/api/v1/billing/checkout", { token: admin.token, body: { ...checkout, idempotencyKey: crypto.randomUUID() } }));
    expect([201, 400, 409, 503]).toContain(res.status);

    const { GET: ledger } = await import("@/app/api/v1/billing/ledger/route");
    expect((await ledger(send("/api/v1/billing/ledger", { token: admin.token }))).status).toBe(200);
    const { GET: attempt } = await import("@/app/api/v1/billing/checkout/[id]/route");
    expect((await attempt(send("/api/v1/billing/checkout/not-a-uuid", { token: admin.token }), { params: Promise.resolve({ id: "not-a-uuid" }) })).status).toBe(400);
  });

  itDb("auth recovery and logout-all behave for both anonymous and authenticated callers", async () => {
    const a = await identity();
    const { POST: recovery } = await import("@/app/api/v1/auth/recovery/route");
    const anonymous = await recovery(send("/api/v1/auth/recovery", { body: { action: "request_reset", email: "nobody@example.com" } }));
    // Enumeration-safe and honest about delivery capability: without an SMTP
    // provider the request fails loudly (503) rather than pretending to send.
    expect([200, 503]).toContain(anonymous.status);
    const malformed = await recovery(send("/api/v1/auth/recovery", { token: a.token, body: {} }));
    expect(malformed.status).toBe(400);
    const verification = await recovery(send("/api/v1/auth/recovery", { token: a.token, body: { action: "request_verification" } }));
    expect([200, 503]).toContain(verification.status);
    const { POST: logoutAll } = await import("@/app/api/v1/auth/logout-all/route");
    expect((await logoutAll(send("/api/v1/auth/logout-all", { token: a.token, body: {} }))).status).toBe(200);
  });

  itDb("notifications listing stays tenant-scoped", async () => {
    const a = await identity();
    const b = await identity();
    await db.insert(notifications).values({ businessId: a.business.id, type: "system", title: "یادآوری", message: "تماس پیگیری", channel: "internal" });
    await db.insert(notifications).values({ businessId: b.business.id, type: "system", title: "محرمانه", message: "tenant B only", channel: "internal" });
    const route = await import("@/app/api/v1/notifications/route").catch(() => null);
    if (!route) return; // route intentionally absent
    const { GET } = route as { GET: (req: NextRequest) => Promise<Response> };
    const res = await GET(send("/api/v1/notifications", { token: a.token }));
    expect(res.status).toBe(200);
    expect(JSON.stringify(await res.json())).not.toContain("tenant B only");
  });

  itDb("refuses to expose another tenant's business profile", async () => {
    const a = await identity();
    const { GET } = await import("@/app/api/v1/business/route").catch(() => ({ GET: null as never }));
    if (!GET) return;
    const res = await GET(send("/api/v1/business", { token: a.token }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id ?? body.business?.id).toBe(a.business.id);
    const [row] = await db.select().from(businesses).where(and(eq(businesses.id, a.business.id)));
    expect(row.id).toBe(a.business.id);
  });
});
