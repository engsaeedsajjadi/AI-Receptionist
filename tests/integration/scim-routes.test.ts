import { afterAll, afterEach, beforeAll, describe, expect, vi } from "vitest";
import { NextRequest } from "next/server";
import { and, eq } from "drizzle-orm";
import { closeDb, db } from "@/db";
import { auditLogs, users } from "@/db/schema";
import { createApiKey } from "@/lib/services/access";
import { SCIM_SCOPE } from "@/lib/services/identity-provisioning";
import { resetEnvCache } from "@/lib/env";
import { createBusiness, createUser } from "../helpers/fixtures";
import { ensureDbReady, hasTestDatabase, itDb, truncateAll } from "../helpers/db";

/**
 * SCIM 2.0 HTTP surface (`/api/v1/scim/v2/Users`, `/Users/{id}`).
 *
 * The routes are the provisioning boundary an IdP talks to, so the tests focus
 * on the guarantees that matter at that boundary: a missing/invalid bearer never
 * authenticates, a key without the provisioning scope is refused, and every read
 * or write stays inside the key's own tenant.
 */

type Init = { method?: string; body?: unknown; token?: string; headers?: Record<string, string> };

function send(path: string, init: Init = {}) {
  const headers: Record<string, string> = { "Content-Type": "application/json", ...init.headers };
  if (init.token) headers.Authorization = `Bearer ${init.token}`;
  return new NextRequest(`http://localhost${path}`, {
    method: init.method ?? (init.body !== undefined ? "POST" : "GET"),
    headers,
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
}

const params = (id: string) => ({ params: Promise.resolve({ id }) });

async function tenant(scope: string[] = [SCIM_SCOPE]) {
  const business = await createBusiness(`SCIM ${crypto.randomUUID().slice(0, 8)}`);
  const { user } = await createUser(business.id, "ADMIN");
  const key = await createApiKey(
    { userId: user.id, businessId: business.id, platform: false },
    { name: `scim-route-${crypto.randomUUID().slice(0, 8)}`, scopes: scope },
  );
  return { business, user, token: key.key };
}

describe.skipIf(!hasTestDatabase())("SCIM 2.0 routes (HTTP)", () => {
  beforeAll(async () => {
    await ensureDbReady();
    await truncateAll();
    vi.stubEnv("IDENTITY_ENCRYPTION_KEY", "ee".repeat(32));
    resetEnvCache();
  });
  afterAll(async () => {
    vi.unstubAllEnvs();
    resetEnvCache();
    await truncateAll();
    await closeDb();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  itDb("rejects every request without a valid provisioning credential", async () => {
    const usersRoute = await import("@/app/api/v1/scim/v2/Users/route");
    const userRoute = await import("@/app/api/v1/scim/v2/Users/[id]/route");

    for (const token of [undefined, "", "not-a-real-key", "ar_live_deadbeef_nope"]) {
      const list = await usersRoute.GET(send("/api/v1/scim/v2/Users", { token }));
      expect(list.status).toBe(401);
      const body = (await list.json()) as { success: boolean; error: { code: string } };
      expect(body).toMatchObject({ success: false, error: { code: "UNAUTHORIZED" } });

      const missing = await userRoute.GET(send("/api/v1/scim/v2/Users/00000000-0000-4000-8000-000000000000", { token }), params("00000000-0000-4000-8000-000000000000"));
      expect(missing.status).toBe(401);
    }

    // A non-Bearer authorization header is never treated as a credential.
    const basic = await usersRoute.GET(send("/api/v1/scim/v2/Users", { headers: { Authorization: "Basic Zm9vOmJhcg==" } }));
    expect(basic.status).toBe(401);
  });

  itDb("refuses a key that lacks the scim:provision scope", async () => {
    const { business, user } = await createBusinessWithUser();
    const weakKey = await createApiKey(
      { userId: user.id, businessId: business.id, platform: false },
      { name: `weak-${crypto.randomUUID().slice(0, 8)}`, scopes: ["calls:read"] },
    );
    const usersRoute = await import("@/app/api/v1/scim/v2/Users/route");
    const res = await usersRoute.GET(send("/api/v1/scim/v2/Users", { token: weakKey.key }));
    expect(res.status).toBe(403);
    expect((await res.json()) as { error: { code: string } }).toMatchObject({ error: { code: "FORBIDDEN" } });
  });

  itDb("creates a user, returns 201 with the SCIM resource, and is idempotent on retry", async () => {
    const { token } = await tenant();
    const route = await import("@/app/api/v1/scim/v2/Users/route");

    const created = await route.POST(
      send("/api/v1/scim/v2/Users", {
        method: "POST",
        token,
        body: { userName: "route.hire@example.com", displayName: "کارمند جدید", roles: [{ value: "AGENT" }] },
      }),
    );
    expect(created.status).toBe(201);
    const resource = (await created.json()) as {
      id: string;
      userName: string;
      active: boolean;
      displayName: string;
      "urn:receptionist:created": boolean;
      meta: { location: string };
    };
    expect(resource).toMatchObject({ userName: "route.hire@example.com", active: true, "urn:receptionist:created": true });
    expect(resource.displayName).toBe("کارمند جدید");
    expect(resource.meta.location).toContain(`/api/v1/scim/v2/Users/${resource.id}`);

    // Idempotent provisioning: the same userName again returns the existing row (200).
    const again = await route.POST(
      send("/api/v1/scim/v2/Users", { method: "POST", token, body: { userName: "ROUTE.HIRE@example.com" } }),
    );
    expect(again.status).toBe(200);
    const repeat = (await again.json()) as { id: string; "urn:receptionist:created": boolean };
    expect(repeat.id).toBe(resource.id);
    expect(repeat["urn:receptionist:created"]).toBe(false);

    // Invalid payloads are rejected at the boundary, not stored.
    const invalid = await route.POST(send("/api/v1/scim/v2/Users", { method: "POST", token, body: { userName: "" } }));
    expect(invalid.status).toBe(400);
    expect((await invalid.json()) as { error: { code: string } }).toMatchObject({ error: { code: "VALIDATION_ERROR" } });

    // Privilege escalation through SCIM is refused.
    const escalate = await route.POST(
      send("/api/v1/scim/v2/Users", { method: "POST", token, body: { userName: "root@example.com", roles: [{ value: "SUPER_ADMIN" }] } }),
    );
    expect(escalate.status).toBe(400);
  });

  itDb("lists users with SCIM paging/filter parameters and never leaks other tenants", async () => {
    const a = await tenant();
    const b = await tenant();
    const route = await import("@/app/api/v1/scim/v2/Users/route");

    await route.POST(send("/api/v1/scim/v2/Users", { method: "POST", token: a.token, body: { userName: "list.one@example.com" } }));
    await route.POST(send("/api/v1/scim/v2/Users", { method: "POST", token: b.token, body: { userName: "list.other@example.com" } }));

    const list = await route.GET(send("/api/v1/scim/v2/Users?startIndex=1&count=10", { token: a.token }));
    expect(list.status).toBe(200);
    const body = (await list.json()) as {
      totalResults: number;
      startIndex: number;
      itemsPerPage: number;
      Resources: { userName: string }[];
    };
    expect(body.startIndex).toBe(1);
    expect(body.itemsPerPage).toBeGreaterThan(0);
    const names = body.Resources.map((r) => r.userName);
    expect(names).toContain("list.one@example.com");
    expect(names).not.toContain("list.other@example.com");
    expect(body.totalResults).toBeGreaterThanOrEqual(1);

    // A filter that matches nothing returns an empty page, not another tenant's data.
    const filtered = await route.GET(send('/api/v1/scim/v2/Users?filter=userName eq "nobody@example.com"', { token: a.token }));
    expect(filtered.status).toBe(200);
    expect((await filtered.json()) as { Resources: unknown[] }).toMatchObject({ Resources: [] });

    // Broken paging input is a client error, never a 500.
    const bad = await route.GET(send("/api/v1/scim/v2/Users?startIndex=abc", { token: a.token }));
    expect([200, 400]).toContain(bad.status);
  });

  itDb("reads a single user inside the tenant and hides foreign ids behind 404", async () => {
    const a = await tenant();
    const b = await tenant();
    const listRoute = await import("@/app/api/v1/scim/v2/Users/route");
    const userRoute = await import("@/app/api/v1/scim/v2/Users/[id]/route");

    const created = (await (
      await listRoute.POST(send("/api/v1/scim/v2/Users", { method: "POST", token: a.token, body: { userName: "single@example.com" } }))
    ).json()) as { id: string };

    const own = await userRoute.GET(send(`/api/v1/scim/v2/Users/${created.id}`, { token: a.token }), params(created.id));
    expect(own.status).toBe(200);
    expect((await own.json()) as { userName: string; id: string }).toMatchObject({ id: created.id, userName: "single@example.com" });

    const foreign = await userRoute.GET(send(`/api/v1/scim/v2/Users/${created.id}`, { token: b.token }), params(created.id));
    expect(foreign.status).toBe(404);

    const missing = await userRoute.GET(
      send("/api/v1/scim/v2/Users/00000000-0000-4000-8000-000000000001", { token: a.token }),
      params("00000000-0000-4000-8000-000000000001"),
    );
    expect(missing.status).toBe(404);
  });

  itDb("patches the supported attributes and refuses anything else", async () => {
    const a = await tenant();
    const b = await tenant();
    const listRoute = await import("@/app/api/v1/scim/v2/Users/route");
    const userRoute = await import("@/app/api/v1/scim/v2/Users/[id]/route");

    const created = (await (
      await listRoute.POST(send("/api/v1/scim/v2/Users", { method: "POST", token: a.token, body: { userName: "patch.target@example.com", displayName: "قبل" } }))
    ).json()) as { id: string };

    const renamed = await userRoute.PATCH(
      send(`/api/v1/scim/v2/Users/${created.id}`, {
        method: "PATCH",
        token: a.token,
        body: { Operations: [{ op: "replace", path: "displayName", value: "بعد" }] },
      }),
      params(created.id),
    );
    expect(renamed.status).toBe(200);
    expect((await renamed.json()) as { displayName: string }).toMatchObject({ displayName: "بعد" });

    const promoted = await userRoute.PATCH(
      send(`/api/v1/scim/v2/Users/${created.id}`, {
        method: "PATCH",
        token: a.token,
        body: { Operations: [{ op: "replace", path: "roles", value: [{ value: "MANAGER" }] }] },
      }),
      params(created.id),
    );
    expect(promoted.status).toBe(200);

    const deactivated = await userRoute.PATCH(
      send(`/api/v1/scim/v2/Users/${created.id}`, { method: "PATCH", token: a.token, body: { Operations: [{ op: "remove", path: "active" }] } }),
      params(created.id),
    );
    expect(deactivated.status).toBe(200);
    expect((await deactivated.json()) as { active: boolean }).toMatchObject({ active: false });

    // Cross-tenant PATCH is refused as not-found (never applied).
    const foreign = await userRoute.PATCH(
      send(`/api/v1/scim/v2/Users/${created.id}`, {
        method: "PATCH",
        token: b.token,
        body: { Operations: [{ op: "replace", path: "displayName", value: "hacked" }] },
      }),
      params(created.id),
    );
    expect(foreign.status).toBe(404);
    const [row] = await db.select({ name: users.name, isActive: users.isActive }).from(users).where(eq(users.id, created.id));
    expect(row.name).toBe("بعد");
    expect(row.isActive).toBe(false);

    // Unsupported operations/paths are rejected.
    const unsupported = await userRoute.PATCH(
      send(`/api/v1/scim/v2/Users/${created.id}`, {
        method: "PATCH",
        token: a.token,
        body: { Operations: [{ op: "replace", path: "passwords", value: "x" }] },
      }),
      params(created.id),
    );
    expect(unsupported.status).toBeGreaterThanOrEqual(400);
    const badBody = await userRoute.PATCH(
      send(`/api/v1/scim/v2/Users/${created.id}`, { method: "PATCH", token: a.token, body: { Operations: [] } }),
      params(created.id),
    );
    expect(badBody.status).toBe(400);
  });

  itDb("DELETE deprovisions (deactivates) without destroying the record and is tenant-scoped", async () => {
    const a = await tenant();
    const b = await tenant();
    const listRoute = await import("@/app/api/v1/scim/v2/Users/route");
    const userRoute = await import("@/app/api/v1/scim/v2/Users/[id]/route");

    const created = (await (
      await listRoute.POST(send("/api/v1/scim/v2/Users", { method: "POST", token: a.token, body: { userName: "delete.me@example.com" } }))
    ).json()) as { id: string };

    const foreign = await userRoute.DELETE(send(`/api/v1/scim/v2/Users/${created.id}`, { method: "DELETE", token: b.token }), params(created.id));
    expect(foreign.status).toBe(404);

    const removed = await userRoute.DELETE(send(`/api/v1/scim/v2/Users/${created.id}`, { method: "DELETE", token: a.token }), params(created.id));
    expect(removed.status).toBe(200);
    expect((await removed.json()) as { id: string; active: boolean }).toMatchObject({ id: created.id, active: false });

    // The row still exists (audit + foreign keys intact) but is inert.
    const [row] = await db.select({ isActive: users.isActive }).from(users).where(eq(users.id, created.id));
    expect(row.isActive).toBe(false);

    // Deprovisioning is idempotent.
    const again = await userRoute.DELETE(send(`/api/v1/scim/v2/Users/${created.id}`, { method: "DELETE", token: a.token }), params(created.id));
    expect(again.status).toBe(200);

    // And it is audited.
    const logs = await db
      .select({ action: auditLogs.action })
      .from(auditLogs)
      .where(and(eq(auditLogs.businessId, a.business.id), eq(auditLogs.action, "scim.user_deactivated")));
    expect(logs.length).toBeGreaterThanOrEqual(1);

    // Two deprovisions by two different tenants cannot touch each other: B's own
    // attempt above never modified A's row.
    const [stillThere] = await db.select({ id: users.id }).from(users).where(and(eq(users.id, created.id), eq(users.businessId, a.business.id)));
    expect(stillThere.id).toBe(created.id);
  });
});

async function createBusinessWithUser() {
  const business = await createBusiness(`SCIM weak ${crypto.randomUUID().slice(0, 8)}`);
  const { user } = await createUser(business.id, "ADMIN");
  return { business, user };
}
