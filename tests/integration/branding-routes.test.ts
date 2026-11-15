import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { and, eq } from "drizzle-orm";
import { closeDb, db } from "@/db";
import { auditLogs, businesses, users } from "@/db/schema";
import { issueAuthTokens } from "@/lib/auth";
import { getEnv } from "@/lib/env";
import { PATCH as brandingPatch, GET as brandingGet } from "@/app/api/v1/business/branding/route";
import { GET as publicBranding } from "@/app/api/v1/public/branding/route";
import { PUT as settingsPut } from "@/app/api/v1/business/settings/route";
import { createBusiness, createUser } from "../helpers/fixtures";
import { ensureDbReady, hasTestDatabase, itDb, truncateAll } from "../helpers/db";

/**
 * White-labeling HTTP surface.
 *
 * The guarantees under test are the ones a commercial add-on must never break:
 * the entitlement is enforced server-side (a tenant without it reads platform
 * branding and cannot write), a custom domain belongs to at most one tenant, and
 * public resolution never reveals whether a host belongs to a customer.
 */

let ipSeq = 0;
type Init = { token?: string; body?: unknown; method?: string };
function send(path: string, init: Init = {}) {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    // Unique client per call: the global limiter must not decide these tests.
    "x-real-ip": `10.0.${(ipSeq >> 8) % 250}.${(ipSeq++ % 250) + 1}`,
  };
  if (init.token) headers.Authorization = `Bearer ${init.token}`;
  return new NextRequest(`http://localhost${path}`, {
    method: init.method ?? (init.body !== undefined ? "PATCH" : "GET"),
    headers,
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
}

async function tenant(role: "ADMIN" | "VIEWER" = "ADMIN", whiteLabel = false) {
  const business = await createBusiness(`Brand ${crypto.randomUUID().slice(0, 8)}`);
  const { user } = await createUser(business.id, "ADMIN");
  if (role !== "ADMIN") await db.update(users).set({ role }).where(eq(users.id, user.id));
  if (whiteLabel) {
    await db
      .update(businesses)
      .set({ settings: { ...business.settings, features: { whiteLabel: true } } })
      .where(eq(businesses.id, business.id));
  }
  const tokens = await issueAuthTokens({ userId: user.id, businessId: business.id, role });
  return { business, user, token: tokens.accessToken };
}

function enableWhiteLabel(token: string, enabled = true) {
  return settingsPut(send("/api/v1/business/settings", { token, method: "PUT", body: { settings: { features: { whiteLabel: enabled } } } }));
}

describe.skipIf(!hasTestDatabase())("branding routes (white-labeling)", () => {
  beforeAll(async () => {
    await ensureDbReady();
    await truncateAll();
  });
  afterAll(async () => {
    await truncateAll();
    await closeDb();
  });

  itDb("unentitled tenants read platform branding and cannot write", async () => {
    const { business, token } = await tenant();
    const read = await brandingGet(send("/api/v1/business/branding", { token }));
    expect(read.status).toBe(200);
    const body = (await read.json()) as { enabled: boolean; branding: { productName: string; accentColor: string } };
    expect(body.enabled).toBe(false);
    expect(body.branding.productName).toBe(getEnv().NEXT_PUBLIC_APP_NAME);
    expect(body.branding.accentColor).toMatch(/^#[0-9a-f]{6}$/i);

    const write = await brandingPatch(send("/api/v1/business/branding", { token, body: { productName: "Branded Co" } }));
    expect(write.status).toBe(403);
    const [row] = await db.select({ settings: businesses.settings }).from(businesses).where(eq(businesses.id, business.id));
    expect(row.settings.branding).toBeUndefined();
  });

  itDb("entitled tenants persist branding, read it back and it is audited", async () => {
    const { business, user, token } = await tenant();
    const features = await enableWhiteLabel(token);
    expect([200, 201]).toContain(features.status);

    const write = await brandingPatch(
      send("/api/v1/business/branding", {
        token,
        body: { productName: "املاک سعید", accentColor: "#1D4ED8", logoUrl: "https://cdn.example.com/logo.png", supportEmail: "help@example.com", customDomain: "Portal.Example.COM", hidePlatformBranding: true },
      }),
    );
    expect(write.status).toBe(200);

    const read = await brandingGet(send("/api/v1/business/branding", { token }));
    const body = (await read.json()) as { enabled: boolean; branding: Record<string, unknown> };
    expect(body.enabled).toBe(true);
    expect(body.branding).toMatchObject({
      productName: "املاک سعید",
      accentColor: "#1d4ed8",
      logoUrl: "https://cdn.example.com/logo.png",
      supportEmail: "help@example.com",
      customDomain: "portal.example.com",
      hidePlatformBranding: true,
    });
    const [stored] = await db.select({ domain: businesses.customDomain }).from(businesses).where(eq(businesses.id, business.id));
    expect(stored.domain).toBe("portal.example.com");
    const [audit] = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.businessId, business.id), eq(auditLogs.action, "branding.updated")));
    expect(audit.actorId).toBe(user.id);
    expect(audit.metadata).toMatchObject({ customDomain: "portal.example.com" });
  });

  itDb("rejects non-https logos, non-hex colours and non-hostname domains without changing state", async () => {
    const { business, token } = await tenant("ADMIN", true);
    const cases: Array<Record<string, unknown>> = [
      { accentColor: "red" },
      { accentColor: "#12345" },
      { logoUrl: "http://cdn.example.com/logo.png" },
      { logoUrl: "javascript:alert(1)" },
      { customDomain: "https://portal.example.com/path" },
      { customDomain: "localhost" },
      { supportEmail: "not-an-email" },
    ];
    for (const body of cases) {
      const res = await brandingPatch(send("/api/v1/business/branding", { token, body }));
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    const [row] = await db.select({ settings: businesses.settings, domain: businesses.customDomain }).from(businesses).where(eq(businesses.id, business.id));
    expect(row.settings.branding).toBeUndefined();
    expect(row.domain).toBeNull();
  });

  itDb("enforces role, cross-tenant domain ownership and tenant-scoped reads", async () => {
    const a = await tenant("ADMIN", true);
    const b = await tenant("ADMIN", true);
    const viewer = await tenant("VIEWER", true);

    // Role gate.
    expect((await brandingPatch(send("/api/v1/business/branding", { token: viewer.token, body: { productName: "Viewer" } }))).status).toBe(403);

    // A claims a domain.
    expect((await brandingPatch(send("/api/v1/business/branding", { token: a.token, body: { customDomain: "shared.example.com", productName: "A" } }))).status).toBe(200);

    // B cannot take it — and B's own settings stay untouched by the attempt.
    expect((await brandingPatch(send("/api/v1/business/branding", { token: b.token, body: { customDomain: "shared.example.com" } }))).status).toBe(409);
    const [bRow] = await db.select({ domain: businesses.customDomain }).from(businesses).where(eq(businesses.id, b.business.id));
    expect(bRow.domain).toBeNull();

    // B's read shows B's branding, never A's.
    const [bRead] = await Promise.all([brandingGet(send("/api/v1/business/branding", { token: b.token }))]);
    const bBody = (await bRead.json()) as { branding: { productName: string; customDomain: string } };
    expect(bBody.branding.productName).toBe(getEnv().NEXT_PUBLIC_APP_NAME);
    expect(bBody.branding.customDomain).toBe("");

    // A can move to a different domain (releasing the old one).
    expect((await brandingPatch(send("/api/v1/business/branding", { token: a.token, body: { customDomain: "moved.example.com" } }))).status).toBe(200);
    expect((await brandingPatch(send("/api/v1/business/branding", { token: b.token, body: { customDomain: "shared.example.com" } }))).status).toBe(200);
  });

  itDb("public resolution serves entitled tenants and never discloses others", async () => {
    const branded = await tenant("ADMIN", true);
    const unentitled = await tenant("ADMIN", false);
    expect((await brandingPatch(send("/api/v1/business/branding", { token: branded.token, body: { productName: "Tenant Brand", customDomain: "tenant.example.com" } }))).status).toBe(200);
    expect((await brandingPatch(send("/api/v1/business/branding", { token: unentitled.token, body: { productName: "Hidden" } }))).status).toBe(403);
    await db.update(businesses).set({ customDomain: "unbranded.example.com" }).where(eq(businesses.id, unentitled.business.id));

    const known = await publicBranding(send("/api/v1/public/branding?domain=TENANT.example.com"));
    const knownBody = (await known.json()) as { branded: boolean; branding: { productName: string } };
    expect(knownBody.branded).toBe(true);
    expect(knownBody.branding.productName).toBe("Tenant Brand");
    expect(known.headers.get("cache-control")).toBe("no-store");

    for (const domain of ["unknown.example.com", "unbranded.example.com", "not a domain", "", "tenant.example.com.evil.test"]) {
      const res = await publicBranding(send(`/api/v1/public/branding?domain=${encodeURIComponent(domain)}`));
      expect(res.status).toBe(200);
      const body = (await res.json()) as { branded: boolean; branding: { productName: string } };
      expect(body.branded, domain).toBe(false);
      expect(body.branding.productName, domain).toBe(getEnv().NEXT_PUBLIC_APP_NAME);
    }

    // Suspension immediately stops branded serving.
    await db.update(businesses).set({ isActive: false }).where(eq(businesses.id, branded.business.id));
    const suspended = await publicBranding(send("/api/v1/public/branding?domain=tenant.example.com"));
    expect(((await suspended.json()) as { branded: boolean }).branded).toBe(false);
    await db.update(businesses).set({ isActive: true }).where(eq(businesses.id, branded.business.id));
  });

  itDb("partial feature updates never reset flags the caller did not touch", async () => {
    const { business, token } = await tenant();
    await enableWhiteLabel(token, true);
    const disableCrm = await settingsPut(send("/api/v1/business/settings", { token, method: "PUT", body: { settings: { features: { crm: false } } } }));
    expect(disableCrm.status).toBe(200);
    const touchAgent = await settingsPut(send("/api/v1/business/settings", { token, method: "PUT", body: { settings: { features: { agent: false } } } }));
    expect(touchAgent.status).toBe(200);
    const [row] = await db.select({ settings: businesses.settings }).from(businesses).where(eq(businesses.id, business.id));
    expect(row.settings.features).toMatchObject({ crm: false, agent: false, whiteLabel: true });
  });

  itDb("branding reads are tenant-scoped and disabled features hide stored branding", async () => {
    const { business, token } = await tenant("ADMIN", true);
    expect((await brandingPatch(send("/api/v1/business/branding", { token, body: { productName: "Secret Brand" } }))).status).toBe(200);
    await enableWhiteLabel(token, false);
    const read = await brandingGet(send("/api/v1/business/branding", { token }));
    const body = (await read.json()) as { enabled: boolean; branding: { productName: string } };
    expect(body.enabled).toBe(false);
    expect(body.branding.productName).toBe(getEnv().NEXT_PUBLIC_APP_NAME);
    // Re-enabling restores the stored (paid-for) configuration.
    await enableWhiteLabel(token, true);
    const restored = (await (await brandingGet(send("/api/v1/business/branding", { token }))).json()) as { branding: { productName: string } };
    expect(restored.branding.productName).toBe("Secret Brand");
    const [row] = await db.select({ settings: businesses.settings }).from(businesses).where(eq(businesses.id, business.id));
    expect(row.settings.branding).toMatchObject({ productName: "Secret Brand" });
  });
});
