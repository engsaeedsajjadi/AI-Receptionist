import { afterAll, beforeAll, describe, expect } from "vitest";
import { and, eq } from "drizzle-orm";
import { db, closeDb } from "@/db";
import { apiKeys, auditLogs, businesses, invitations, outboxEvents, rolePermissions, roles, userRoles, users } from "@/db/schema";
import {
  acceptInvitation,
  assignUserRole,
  authenticateApiKey,
  createApiKey,
  createRole,
  createServiceAccount,
  effectivePermissions,
  hasActiveSupportSession,
  inviteUser,
  isPlatformOnlyPermission,
  listApiKeys,
  listInvitations,
  listRoles,
  listServiceAccounts,
  parseApiKey,
  revokeApiKey,
  revokeInvitation,
  revokeSupportSession,
  startSupportSession,
  updateRole,
} from "@/lib/services/access";
import { createBusiness, createUser } from "../helpers/fixtures";
import { ensureDbReady, hasTestDatabase, itDb, truncateAll } from "../helpers/db";

async function tenantAdmin() {
  const business = await createBusiness();
  const { user } = await createUser(business.id);
  await db.update(users).set({ role: "ADMIN", mfaEnabled: true }).where(eq(users.id, user.id));
  return { business, user };
}

async function platformAdmin() {
  const business = await createBusiness();
  const { user } = await createUser(business.id);
  await db.update(users).set({ role: "SUPER_ADMIN", mfaEnabled: true }).where(eq(users.id, user.id));
  return { business, user };
}

describe.skipIf(!hasTestDatabase())("RBAC: custom roles", () => {
  beforeAll(async () => {
    await ensureDbReady();
    await truncateAll();
  });
  afterAll(async () => {
    await truncateAll();
    await closeDb();
  });

  itDb("creates tenant roles, refuses platform privileges and detects duplicate names", async () => {
    const a = await tenantAdmin();
    const actor = { userId: a.user.id, businessId: a.business.id, platform: false };
    const role = await createRole(actor, { name: "Dispatcher", permissions: ["calls:read", "crm:write"], description: "Phone dispatch" });
    expect(role.isSystem).toBe(false);
    const grants = await db.select().from(rolePermissions).where(eq(rolePermissions.roleId, role.id));
    expect(grants.map((row) => row.permission).sort()).toEqual(["calls:read", "crm:write"]);

    await expect(createRole(actor, { name: "Dispatcher", permissions: ["crm:read"] })).rejects.toMatchObject({ status: 409 });
    await expect(createRole(actor, { name: "Escalation", permissions: ["platform:admin"] })).rejects.toMatchObject({ status: 403 });
    await expect(createRole(actor, { name: "Bogus", permissions: ["not-a-permission"] })).rejects.toMatchObject({ status: 400 });
    expect(isPlatformOnlyPermission("admin:write")).toBe(true);
    expect(isPlatformOnlyPermission("calls:read")).toBe(false);
  });

  itDb("updates permissions atomically and protects system roles", async () => {
    const a = await tenantAdmin();
    const actor = { userId: a.user.id, businessId: a.business.id, platform: false };
    const role = await createRole(actor, { name: "Support", permissions: ["calls:read"] });
    await updateRole(actor, { roleId: role.id, permissions: ["calls:read", "knowledge:read"], name: "Support L1" });
    const listed = await listRoles(a.business.id);
    const row = listed.find((item) => item.id === role.id)!;
    expect(row.name).toBe("Support L1");
    expect([...row.permissions].sort()).toEqual(["calls:read", "knowledge:read"]);

    await db.insert(roles).values({ businessId: a.business.id, name: "System", isSystem: true });
    const [systemRole] = await db.select().from(roles).where(and(eq(roles.businessId, a.business.id), eq(roles.name, "System")));
    await expect(updateRole(actor, { roleId: systemRole.id, permissions: ["calls:read"] })).rejects.toMatchObject({ status: 409 });
  });

  itDb("assigns and revokes roles with tenant scoping and platform-guard", async () => {
    const a = await tenantAdmin();
    const b = await tenantAdmin();
    const actor = { userId: a.user.id, businessId: a.business.id, platform: false };
    const role = await createRole(actor, { name: "Analyst", permissions: ["usage:read"] });
    const { user: member } = await createUser(a.business.id, "AGENT");

    const assigned = await assignUserRole(actor, { userId: member.id, roleId: role.id });
    expect(assigned.revoked).toBe(false);
    expect((await db.select().from(userRoles).where(eq(userRoles.userId, member.id))).length).toBe(1);
    const effective = await effectivePermissions(a.business.id, member.id, "AGENT");
    expect(effective.has("usage:read")).toBe(true);
    expect(effective.has("users:write")).toBe(false);

    // Cross-tenant assignment is impossible.
    await expect(assignUserRole(actor, { userId: member.id, roleId: role.id, revoke: true })).resolves.toMatchObject({ revoked: true });
    const otherRole = await createRole({ userId: b.user.id, businessId: b.business.id, platform: false }, { name: "Foreign", permissions: ["calls:read"] });
    await expect(assignUserRole(actor, { userId: member.id, roleId: otherRole.id })).rejects.toMatchObject({ status: 404 });

    // A tenant admin cannot grant a role that carries platform-only privileges.
    await db.insert(rolePermissions).values({ businessId: a.business.id, roleId: role.id, permission: "platform:admin" });
    await expect(assignUserRole(actor, { userId: member.id, roleId: role.id })).rejects.toMatchObject({ status: 403 });
  });

  itDb("records audit entries for every RBAC mutation", async () => {
    const a = await tenantAdmin();
    const actor = { userId: a.user.id, businessId: a.business.id, platform: false };
    const role = await createRole(actor, { name: "Audited", permissions: ["calls:read"] });
    await updateRole(actor, { roleId: role.id, permissions: ["calls:write"] });
    const { user: member } = await createUser(a.business.id, "AGENT");
    await assignUserRole(actor, { userId: member.id, roleId: role.id });
    const logs = await db.select().from(auditLogs).where(eq(auditLogs.businessId, a.business.id));
    expect(logs.map((row) => row.action).sort()).toEqual(["rbac.role_assigned", "rbac.role_created", "rbac.role_updated"]);
    expect(logs.every((row) => row.actorId === a.user.id)).toBe(true);
  });
});

describe.skipIf(!hasTestDatabase())("API keys and service accounts", () => {
  beforeAll(async () => {
    await ensureDbReady();
    await truncateAll();
  });
  afterAll(async () => {
    await truncateAll();
    await closeDb();
  });

  itDb("mints ar_live keys, stores only the hash and authenticates exactly once", async () => {
    const a = await tenantAdmin();
    const actor = { userId: a.user.id, businessId: a.business.id, platform: false };
    const created = await createApiKey(actor, { name: "CRM sync", scopes: ["crm:read", "calls:read"] });
    expect(created.key.startsWith("ar_live_")).toBe(true);
    const parsed = parseApiKey(created.key);
    expect(parsed).not.toBeNull();

    // The full key is never persisted.
    const rows = await db.select().from(apiKeys).where(eq(apiKeys.businessId, a.business.id));
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows[0])).not.toContain(parsed!.secret);

    const auth = await authenticateApiKey(created.key);
    expect(auth).toMatchObject({ businessId: a.business.id, scopes: ["crm:read", "calls:read"] });
    expect((await db.select().from(apiKeys).where(eq(apiKeys.id, created.id)))[0].lastUsedAt).not.toBeNull();

    expect(await authenticateApiKey(`${created.key}x`)).toBeNull();
    expect(await authenticateApiKey("not-a-key")).toBeNull();

    await revokeApiKey({ userId: a.user.id, businessId: a.business.id }, created.id);
    expect(await authenticateApiKey(created.key)).toBeNull();
    await expect(revokeApiKey({ userId: a.user.id, businessId: a.business.id }, created.id)).rejects.toMatchObject({ status: 404 });
  });

  itDb("scopes keys to their tenant and refuses expired keys", async () => {
    const a = await tenantAdmin();
    const b = await tenantAdmin();
    const created = await createApiKey({ userId: a.user.id, businessId: a.business.id, platform: false }, { name: "Tenant A key", scopes: ["calls:read"], expiresInDays: 1 });
    expect((await authenticateApiKey(created.key))!.businessId).toBe(a.business.id);
    await db.update(apiKeys).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(apiKeys.id, created.id));
    expect(await authenticateApiKey(created.key)).toBeNull();

    // Listing is tenant-scoped.
    const other = await createApiKey({ userId: b.user.id, businessId: b.business.id, platform: false }, { name: "Tenant B key", scopes: ["calls:read"] });
    const listed = await listApiKeys(a.business.id);
    expect(listed.map((row) => row.name)).toEqual(["Tenant A key"]);
    expect(listed.some((row) => row.id === other.id)).toBe(false);

    // Inactive tenants cannot authenticate.
    await db.update(businesses).set({ isActive: false }).where(eq(businesses.id, a.business.id));
    expect(await authenticateApiKey(created.key)).toBeNull();
    await db.update(businesses).set({ isActive: true }).where(eq(businesses.id, a.business.id));
  });

  itDb("creates service accounts that cannot be duplicated and mint their own credential", async () => {
    const a = await tenantAdmin();
    const actor = { userId: a.user.id, businessId: a.business.id, platform: false };
    const account = await createServiceAccount(actor, { name: "Billing bot", scopes: ["usage:read"], description: "Reads usage" });
    expect(account.key.startsWith("ar_live_")).toBe(true);
    await expect(createServiceAccount(actor, { name: "Billing bot", scopes: ["usage:read"] })).rejects.toMatchObject({ status: 409 });
    expect((await listServiceAccounts(a.business.id)).length).toBe(1);
    const [key] = await db.select().from(apiKeys).where(eq(apiKeys.id, account.apiKeyId));
    expect(key.serviceAccountId).toBe(account.id);
    expect((await authenticateApiKey(account.key))!.scopes).toEqual(["usage:read"]);
  });
});

describe.skipIf(!hasTestDatabase())("Invitations", () => {
  beforeAll(async () => {
    await ensureDbReady();
    await truncateAll();
  });
  afterAll(async () => {
    await truncateAll();
    await closeDb();
  });

  itDb("invites a teammate, queues an outbox event and accepts exactly once", async () => {
    const a = await tenantAdmin();
    const invitation = await inviteUser({ userId: a.user.id, businessId: a.business.id }, { email: "New.Teammate@Example.COM", role: "MANAGER" });
    expect(invitation.email).toBe("new.teammate@example.com");
    const outbox = await db.select().from(outboxEvents).where(eq(outboxEvents.businessId, a.business.id));
    expect(outbox.map((row) => row.topic)).toEqual(["user.invited"]);

    const accepted = await acceptInvitation({ token: invitation.token, name: "New Teammate", password: "a-very-strong-password-1" });
    expect(accepted.businessId).toBe(a.business.id);
    expect(accepted.role).toBe("MANAGER");
    await expect(acceptInvitation({ token: invitation.token, name: "Someone Else", password: "another-strong-password-1" })).rejects.toMatchObject({ status: 409 });
    // The plaintext token is never stored.
    const [row] = await db.select().from(invitations).where(eq(invitations.id, invitation.id));
    expect(row.tokenHash).not.toBe(invitation.token);
    expect(row.acceptedAt).not.toBeNull();
  });

  itDb("validates the invited address, role scope and revocation", async () => {
    const a = await tenantAdmin();
    const b = await tenantAdmin();
    const actor = { userId: a.user.id, businessId: a.business.id };
    await expect(inviteUser(actor, { email: "root@example.com", role: "SUPER_ADMIN" })).rejects.toMatchObject({ status: 403 });

    const invitation = await inviteUser(actor, { email: "revoked@example.com", role: "AGENT" });
    await revokeInvitation(actor, invitation.id);
    await expect(acceptInvitation({ token: invitation.token, name: "Revoked User", password: "strong-password-123" })).rejects.toMatchObject({ status: 409 });
    await expect(revokeInvitation(actor, invitation.id)).rejects.toMatchObject({ status: 404 });

    // Re-inviting rotates the token and clears the revocation.
    const again = await inviteUser(actor, { email: "revoked@example.com", role: "AGENT" });
    expect(again.id).toBe(invitation.id);
    expect(again.token).not.toBe(invitation.token);
    await expect(acceptInvitation({ token: invitation.token, name: "Old Token", password: "strong-password-123" })).rejects.toMatchObject({ status: 404 });
    await acceptInvitation({ token: again.token, name: "Fresh Token", password: "strong-password-123" });

    // Cross-tenant invitation listing is empty.
    expect(await listInvitations(b.business.id)).toHaveLength(0);

    // Expired invitations are refused.
    const expiring = await inviteUser(actor, { email: "late@example.com", role: "AGENT" });
    await db.update(invitations).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(invitations.id, expiring.id));
    await expect(acceptInvitation({ token: expiring.token, name: "Late User", password: "strong-password-123" })).rejects.toMatchObject({ status: 410 });
  });

  itDb("refuses a duplicate email and an inactive tenant", async () => {
    const a = await tenantAdmin();
    const actor = { userId: a.user.id, businessId: a.business.id };
    await inviteUser(actor, { email: "taken@example.com", role: "AGENT" });
    const pending = await listInvitations(a.business.id);
    expect(pending).toHaveLength(1);
    await db.update(businesses).set({ isActive: false }).where(eq(businesses.id, a.business.id));
    const invitation = await inviteUser(actor, { email: "blocked@example.com", role: "AGENT" });
    await expect(acceptInvitation({ token: invitation.token, name: "Blocked User", password: "strong-password-123" })).rejects.toMatchObject({ status: 403 });
  });
});

describe.skipIf(!hasTestDatabase())("Support access (no impersonation)", () => {
  beforeAll(async () => {
    await ensureDbReady();
    await truncateAll();
  });
  afterAll(async () => {
    await truncateAll();
    await closeDb();
  });

  itDb("creates a read-only time-boxed session, audits it and expires on its own", async () => {
    const admin = await platformAdmin();
    const tenant = await tenantAdmin();
    const session = await startSupportSession({ userId: admin.user.id, mfaEnabled: true }, {
      businessId: tenant.business.id,
      reason: "Investigating a reported transcription issue",
      ttlMinutes: 30,
    });
    expect(session.readOnly).toBe(true);
    expect(await hasActiveSupportSession(tenant.business.id, admin.user.id)).toBe(true);

    const logs = await db.select().from(auditLogs).where(and(eq(auditLogs.businessId, tenant.business.id), eq(auditLogs.action, "support.session_started")));
    expect(logs).toHaveLength(1);
    expect(logs[0].metadata).toMatchObject({ readOnly: true });

    // No token/impersonation credential is ever issued.
    expect(Object.keys(session)).not.toContain("token");

    await revokeSupportSession({ userId: admin.user.id }, session.id);
    expect(await hasActiveSupportSession(tenant.business.id, admin.user.id)).toBe(false);
    await expect(revokeSupportSession({ userId: admin.user.id }, session.id)).rejects.toMatchObject({ status: 404 });
  });

  itDb("requires MFA and a meaningful reason", async () => {
    const admin = await platformAdmin();
    const tenant = await tenantAdmin();
    await expect(startSupportSession({ userId: admin.user.id, mfaEnabled: false }, { businessId: tenant.business.id, reason: "quick look" })).rejects.toMatchObject({ status: 403 });
    await expect(startSupportSession({ userId: admin.user.id, mfaEnabled: true }, { businessId: tenant.business.id, reason: "short" })).rejects.toMatchObject({ status: 400 });
  });

  itDb("expired sessions stop counting as active", async () => {
    const admin = await platformAdmin();
    const tenant = await tenantAdmin();
    const session = await startSupportSession({ userId: admin.user.id, mfaEnabled: true }, { businessId: tenant.business.id, reason: "checking export readiness" });
    const { supportSessions } = await import("@/db/schema");
    await db.update(supportSessions).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(supportSessions.id, session.id));
    expect(await hasActiveSupportSession(tenant.business.id, admin.user.id)).toBe(false);
  });
});
