import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, vi } from "vitest";
import { eq } from "drizzle-orm";
import { closeDb, db } from "@/db";
import { apiKeys, auditLogs, businesses, users } from "@/db/schema";
import {
  assertScimScope,
  HeuristicMalwareScanner,
  HttpMalwareScanner,
  malwarePolicy,
  malwareScannerFromEnv,
  samlConfiguration,
  scimCreateUser,
  scimDeactivateUser,
  scimListUsers,
  scimPatchUser,
  SCIM_SCOPE,
  setSamlConfiguration,
  TENANT_PROVISIONABLE_ROLES,
} from "@/lib/services/identity-provisioning";
import { authenticateApiKey, createApiKey } from "@/lib/services/access";
import { createBusiness, createUser } from "../helpers/fixtures";
import { ensureDbReady, hasTestDatabase, itDb, truncateAll } from "../helpers/db";

const EICAR = "X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*";

async function actorFor(businessId: string, scopes: string[] = [SCIM_SCOPE]) {
  const { user } = await createUser(businessId, "ADMIN");
  const key = await createApiKey({ userId: user.id, businessId, platform: false }, { name: `scim-${crypto.randomUUID().slice(0, 8)}`, scopes });
  return { userId: user.id, businessId, scopes, key: key.key };
}

describe.skipIf(!hasTestDatabase())("SCIM 2.0 provisioning", () => {
  beforeAll(async () => {
    await ensureDbReady();
    await truncateAll();
    vi.stubEnv("IDENTITY_ENCRYPTION_KEY", "dd".repeat(32));
  });
  afterAll(async () => {
    vi.unstubAllEnvs();
    await truncateAll();
    await closeDb();
  });
  beforeEach(async () => {
    await truncateAll();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  itDb("creates users idempotently, never leaking a password and never granting platform roles", async () => {
    const business = await createBusiness();
    const actor = await actorFor(business.id);
    const created = await scimCreateUser(actor, { userName: "New.Hire@Example.com", displayName: "New Hire", roles: [{ value: "manager" }] });
    expect(created.created).toBe(true);
    expect(created.user).toMatchObject({ email: "new.hire@example.com", role: "MANAGER", businessId: business.id, isActive: true });

    const again = await scimCreateUser(actor, { userName: "new.hire@example.com" });
    expect(again.created).toBe(false);
    expect(again.user.id).toBe(created.user.id);

    await expect(scimCreateUser(actor, { userName: "root@example.com", roles: [{ value: "SUPER_ADMIN" }] })).rejects.toMatchObject({ status: 400 });
    await expect(scimCreateUser(actor, { userName: "bad-role@example.com", roles: [{ value: "not-a-role" }] })).rejects.toMatchObject({ status: 400 });
    const logs = await db.select().from(auditLogs).where(eq(auditLogs.businessId, business.id));
    expect(logs.some((row) => row.action === "scim.user_created")).toBe(true);
    expect(JSON.stringify(logs)).not.toContain("Root!");
  });

  itDb("never provisions a user into another tenant", async () => {
    const a = await createBusiness();
    const b = await createBusiness();
    const actorA = await actorFor(a.id);
    const actorB = await actorFor(b.id);
    await scimCreateUser(actorA, { userName: "mine@example.com" });
    await expect(scimCreateUser(actorB, { userName: "mine@example.com" })).rejects.toMatchObject({ status: 409 });
    const rows = await db.select().from(users).where(eq(users.businessId, b.id));
    expect(rows.some((row) => row.email === "mine@example.com")).toBe(false);
  });

  itDb("patches active/name/role and refuses unsupported or escalating paths", async () => {
    const business = await createBusiness();
    const actor = await actorFor(business.id);
    const { user } = await scimCreateUser(actor, { userName: "patch@example.com", displayName: "Patch Me" });

    const renamed = await scimPatchUser(actor, user.id, { Operations: [{ op: "replace", path: "displayName", value: "پشتیبانی شبانه" }] });
    expect(renamed.name).toBe("پشتیبانی شبانه");
    const reassigned = await scimPatchUser(actor, user.id, { Operations: [{ op: "replace", path: "roles", value: [{ value: "VIEWER" }] }] });
    expect(reassigned.role).toBe("VIEWER");
    const withBody = await scimPatchUser(actor, user.id, { Operations: [{ op: "replace", value: { active: true, displayName: "Body Name" } }] });
    expect(withBody.name).toBe("Body Name");
    const deactivated = await scimPatchUser(actor, user.id, { Operations: [{ op: "remove", path: "active" }] });
    expect(deactivated.isActive).toBe(false);

    await expect(scimPatchUser(actor, user.id, { Operations: [{ op: "replace", path: "roles", value: [{ value: "SUPER_ADMIN" }] }] })).rejects.toMatchObject({ status: 400 });
    await expect(scimPatchUser(actor, user.id, { Operations: [{ op: "replace", path: "password", value: "x" }] })).rejects.toMatchObject({ status: 400 });
    await expect(scimPatchUser(actor, user.id, { Operations: [] })).rejects.toMatchObject({ status: 400 });
    await expect(scimPatchUser(actor, user.id, { Operations: [{ op: "replace", path: "displayName", value: 42 }] })).rejects.toMatchObject({ status: 400 });
    await expect(scimPatchUser(actor, crypto.randomUUID(), { Operations: [{ op: "replace", path: "displayName", value: "x" }] })).rejects.toMatchObject({ status: 404 });
  });

  itDb("deprovisions by deactivation and lists with filter, paging and tenant scope", async () => {
    const business = await createBusiness();
    const other = await createBusiness();
    const actor = await actorFor(business.id);
    const actorOther = await actorFor(other.id);
    await scimCreateUser(actor, { userName: "list1@example.com" });
    await scimCreateUser(actor, { userName: "list2@example.com" });
    await scimCreateUser(actorOther, { userName: "hidden@example.com" });
    const { user } = await scimCreateUser(actor, { userName: "gone@example.com" });
    const deactivated = await scimDeactivateUser(actor, user.id);
    expect(deactivated.isActive).toBe(false);
    await expect(scimDeactivateUser(actorOther, user.id)).rejects.toMatchObject({ status: 404 });

    const all = await scimListUsers(business.id, {});
    expect(all.totalResults).toBe(4); // 3 provisioned + the admin who owns the key
    expect(JSON.stringify(all)).not.toContain("hidden@example.com");
    const filtered = await scimListUsers(business.id, { filter: 'userName eq "list1@example.com"' });
    expect(filtered.totalResults).toBe(1);
    const paged = await scimListUsers(business.id, { startIndex: 2, count: 1 });
    expect(paged.Resources).toHaveLength(1);
    expect(paged.itemsPerPage).toBe(1);
    await expect(scimListUsers(business.id, { filter: "unsupported filter" })).rejects.toMatchObject({ status: 400 });
    await expect(scimListUsers(business.id, { count: 10_000 })).rejects.toMatchObject({ status: 400 });
  });

  itDb("requires the scim scope on a live service credential", async () => {
    const business = await createBusiness();
    const actor = await actorFor(business.id);
    await expect(assertScimScope(actor)).resolves.toBeUndefined();
    await expect(assertScimScope({ ...actor, scopes: ["calls:read"] })).rejects.toMatchObject({ status: 403 });

    const context = await authenticateApiKey(actor.key);
    expect(context).toMatchObject({ businessId: business.id, scopes: [SCIM_SCOPE] });
    const [row] = await db.select().from(apiKeys).where(eq(apiKeys.businessId, business.id));
    expect(row.scopes).toEqual([SCIM_SCOPE]);
    await expect(assertScimScope({ ...actor, userId: crypto.randomUUID() })).rejects.toMatchObject({ status: 403 });
  });
});

describe.skipIf(!hasTestDatabase())("SSO configuration", () => {
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

  itDb("stores the IdP configuration, summarises the certificate and stays honest about runtime verification", async () => {
    const business = await createBusiness();
    const { user } = await createUser(business.id, "ADMIN");
    expect(await samlConfiguration(business.id)).toEqual({ configured: false, enabled: false });

    const saved = await setSamlConfiguration(
      { userId: user.id, businessId: business.id },
      { entityId: "https://idp.example.com/metadata", ssoUrl: "https://idp.example.com/sso", sloUrl: "https://idp.example.com/slo", x509Certificate: "MIIB".padEnd(120, "A"), enabled: true },
    );
    expect(saved).toMatchObject({ configured: true, enabled: true, runtimeVerified: false });

    const current = await samlConfiguration(business.id);
    expect(current.configured).toBe(true);
    expect(current.certificateFingerprint).toHaveLength(32);
    expect(JSON.stringify(current)).not.toContain("A".repeat(60));
    expect(current.note).toContain("BLOCKED");

    const [row] = await db.select().from(businesses).where(eq(businesses.id, business.id));
    expect((row.settings as { sso?: { entityId?: string } }).sso?.entityId).toBe("https://idp.example.com/metadata");
    const logs = await db.select().from(auditLogs).where(eq(auditLogs.businessId, business.id));
    expect(logs.some((log) => log.action === "sso.saml_configured")).toBe(true);
    await expect(samlConfiguration(crypto.randomUUID())).rejects.toMatchObject({ status: 404 });
  });

  itDb("rejects malformed IdP configurations", async () => {
    const business = await createBusiness();
    const { user } = await createUser(business.id, "ADMIN");
    const actor = { userId: user.id, businessId: business.id };
    await expect(setSamlConfiguration(actor, { entityId: "not-a-url", ssoUrl: "https://idp.example.com/sso", x509Certificate: "A".repeat(120) })).rejects.toMatchObject({ status: 400 });
    await expect(setSamlConfiguration(actor, { entityId: "https://idp.example.com", ssoUrl: "https://idp.example.com/sso", x509Certificate: "short" })).rejects.toMatchObject({ status: 400 });
    await expect(setSamlConfiguration(actor, { entityId: "https://idp.example.com", ssoUrl: "https://idp.example.com/sso", x509Certificate: `${"A".repeat(110)}!invalid` })).rejects.toMatchObject({ status: 400 });
  });
});

describe("malware scanning adapter", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  itDb("detects EICAR, disguised executables and script-in-text without external services", async () => {
    const scanner = new HeuristicMalwareScanner();
    expect(await scanner.scan({ data: Buffer.from(`prefix ${EICAR} suffix`), filename: "sample.txt" })).toMatchObject({ status: "infected", signature: "EICAR-Test-File" });
    expect(await scanner.scan({ data: Buffer.from([0x4d, 0x5a, 0x00, 0x01]), filename: "invoice.pdf" })).toMatchObject({ status: "infected" });
    expect(await scanner.scan({ data: Buffer.from("<script>alert(1)</script>"), filename: "notes.txt" })).toMatchObject({ status: "infected" });
    expect(await scanner.scan({ data: Buffer.from("قرارداد اجاره سال ۱۴۰۴"), filename: "lease.txt" })).toMatchObject({ status: "clean" });
    expect(await scanner.scan({ data: Buffer.from([0x4d, 0x5a]), filename: "app.exe" })).toMatchObject({ status: "clean" });
  });

  itDb("never reports clean when the external engine is unreachable", async () => {
    const scanner = new HttpMalwareScanner({ baseURL: "https://scanner.example.com", apiKey: "k", timeoutMs: 500 });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ status: "infected", signature: "Trojan.Test" }), { status: 200 })));
    expect(await scanner.scan({ data: Buffer.from("x"), filename: "a.bin" })).toMatchObject({ status: "infected", signature: "Trojan.Test" });

    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ status: "clean" }), { status: 200 })));
    expect(await scanner.scan({ data: Buffer.from("x"), filename: "a.bin" })).toMatchObject({ status: "clean" });

    vi.stubGlobal("fetch", vi.fn(async () => new Response("boom", { status: 502 })));
    expect(await scanner.scan({ data: Buffer.from("x"), filename: "a.bin" })).toMatchObject({ status: "unavailable", detail: "http_502" });

    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ status: "maybe" }), { status: 200 })));
    expect(await scanner.scan({ data: Buffer.from("x"), filename: "a.bin" })).toMatchObject({ status: "unavailable", detail: "unexpected_response" });

    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("ECONNREFUSED"); }));
    expect(await scanner.scan({ data: Buffer.from("x"), filename: "a.bin" })).toMatchObject({ status: "unavailable" });
  });

  itDb("selects the engine from the environment and defaults to strict production policy", () => {
    vi.stubEnv("MALWARE_SCAN_URL", "");
    vi.stubEnv("NODE_ENV", "test");
    expect(malwareScannerFromEnv().name).toBe("heuristic");
    expect(malwarePolicy()).toMatchObject({ engine: "heuristic", strict: false, onUnavailable: "accept_with_flag", externalConfigured: false });

    vi.stubEnv("MALWARE_SCAN_URL", "https://scanner.example.com");
    vi.stubEnv("MALWARE_SCAN_STRICT", "true");
    expect(malwareScannerFromEnv().name).toBe("http");
    expect(malwarePolicy()).toMatchObject({ engine: "http", strict: true, onUnavailable: "reject", externalConfigured: true });
  });

  itDb("exposes the provisionable role list the SCIM routes rely on", () => {
    expect(TENANT_PROVISIONABLE_ROLES).not.toContain("SUPER_ADMIN");
    expect(TENANT_PROVISIONABLE_ROLES).toContain("AGENT");
  });
});
