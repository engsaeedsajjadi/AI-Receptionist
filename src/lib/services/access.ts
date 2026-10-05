import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import {
  apiKeys,
  auditLogs,
  businesses,
  invitations,
  rolePermissions,
  roles,
  serviceAccounts,
  supportSessions,
  userRoles,
  users,
} from "@/db/schema";
import { parseWith } from "@/lib/api";
import { AppError } from "@/lib/errors";
import { logInfo, logWarn } from "@/lib/logger";
import { hashPassword } from "@/lib/passwords";
import { isKnownPermission, isKnownScope, permissionsFor, USER_ROLES, type Permission, type UserRole } from "@/lib/permissions";
import { requestContext } from "@/lib/request-context";
import { enqueueOutbox } from "@/lib/services/outbox";

/**
 * Access control surface for tenants and the platform:
 * custom roles, scoped API keys, service accounts, invitations and the
 * read-only support-access workflow.
 *
 * Tenant boundaries:
 *  - every row is keyed by `businessId` and every read/write filters on it,
 *  - a tenant administrator can never create or grant SUPER_ADMIN, and the
 *    platform-only privileges (`platform:*`, `admin:*`) can only be granted by
 *    a platform administrator with MFA,
 *  - support sessions are read-only, time-boxed and always audited.
 */

const PLATFORM_ONLY_PREFIXES = ["platform:", "admin:"];

export function isPlatformOnlyPermission(permission: string): boolean {
  return PLATFORM_ONLY_PREFIXES.some((prefix) => permission.startsWith(prefix));
}

export const RoleCreateSchema = z
  .object({
    name: z.string().trim().min(2).max(60),
    description: z.string().trim().max(255).optional(),
    permissions: z.array(z.string().trim().min(2).max(80)).min(1).max(100),
  })
  .strict();

export const RoleUpdateSchema = RoleCreateSchema.partial().extend({ roleId: z.string().uuid() }).strict();

/** Grant (or revoke) a custom role for a user inside the caller's tenant. */
export const UserRoleAssignSchema = z
  .object({ userId: z.string().uuid(), roleId: z.string().uuid(), revoke: z.boolean().optional() })
  .strict();

async function assertTenantRoleScope(
  businessId: string,
  permissions: string[],
  platform: boolean,
  mode: "role" | "credential" = "role",
) {
  // Platform privileges are checked first so a tenant administrator gets the
  // authorization error (not a generic validation error) when attempting them.
  const platformOnly = permissions.filter(isPlatformOnlyPermission);
  if (platformOnly.length && !platform) {
    throw new AppError(403, "FORBIDDEN", "Tenant administrators cannot grant platform privileges");
  }
  const invalid = permissions.filter((permission) => {
    // Role permissions are strictly read/write/execute; credential scopes may
    // carry an action verb of their own (e.g. scim:provision) but must still be
    // members of the documented catalog.
    const format = mode === "credential" ? /^[a-z_]+:[a-z_]+$/ : /^[a-z_]+:(read|write|execute)$/;
    if (!format.test(permission)) return true;
    if (isPlatformOnlyPermission(permission)) return false;
    return mode === "credential" ? !isKnownScope(permission) : !isKnownPermission(permission);
  });
  if (invalid.length) throw new AppError(400, "INVALID_PAYLOAD", `Invalid permission names: ${invalid.join(", ")}`);
  // A custom role must never be used to smuggle platform-level access into a
  // tenant scope: verify the tenant exists and is active.
  const [business] = await db.select({ id: businesses.id, isActive: businesses.isActive }).from(businesses).where(eq(businesses.id, businessId));
  if (!business || !business.isActive) throw new AppError(404, "BUSINESS_NOT_FOUND", "Business not found");
}

export async function createRole(actor: { userId: string; businessId: string; platform: boolean }, raw: unknown) {
  const input = parseWith(RoleCreateSchema, raw);
  await assertTenantRoleScope(actor.businessId, input.permissions, actor.platform);
  return db.transaction(async (tx) => {
    const [role] = await tx
      .insert(roles)
      .values({ businessId: actor.businessId, name: input.name, description: input.description ?? null, isSystem: false })
      .onConflictDoNothing({ target: [roles.businessId, roles.name] })
      .returning();
    if (!role) throw new AppError(409, "CONFLICT", "A role with this name already exists");
    await tx.insert(rolePermissions).values(input.permissions.map((permission) => ({ businessId: actor.businessId, roleId: role.id, permission })));
    await tx.insert(auditLogs).values({
      businessId: actor.businessId,
      actorType: "user",
      actorId: actor.userId,
      action: "rbac.role_created",
      entityType: "role",
      entityId: role.id,
      requestId: requestContext.getStore()?.requestId,
      metadata: { name: input.name, permissions: input.permissions },
    });
    return role;
  });
}

export async function updateRole(actor: { userId: string; businessId: string; platform: boolean }, raw: unknown) {
  const input = parseWith(RoleUpdateSchema, raw);
  await assertTenantRoleScope(actor.businessId, input.permissions ?? [], actor.platform);
  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(roles)
      .where(and(eq(roles.id, input.roleId), eq(roles.businessId, actor.businessId)))
      .for("update");
    if (!existing) throw new AppError(404, "NOT_FOUND", "Role not found");
    if (existing.isSystem) throw new AppError(409, "CONFLICT", "System roles can only be changed by the platform");
    const [updated] = await tx
      .update(roles)
      .set({ name: input.name ?? existing.name, description: input.description ?? existing.description, updatedAt: new Date() })
      .where(and(eq(roles.id, existing.id), eq(roles.businessId, actor.businessId)))
      .returning();
    if (input.permissions) {
      await tx.delete(rolePermissions).where(and(eq(rolePermissions.roleId, existing.id), eq(rolePermissions.businessId, actor.businessId)));
      await tx.insert(rolePermissions).values(input.permissions.map((permission) => ({ businessId: actor.businessId, roleId: existing.id, permission })));
    }
    await tx.insert(auditLogs).values({
      businessId: actor.businessId,
      actorType: "user",
      actorId: actor.userId,
      action: "rbac.role_updated",
      entityType: "role",
      entityId: existing.id,
      requestId: requestContext.getStore()?.requestId,
      metadata: { permissions: input.permissions ?? null, name: input.name ?? existing.name },
    });
    return updated;
  });
}

export async function listRoles(businessId: string) {
  const rows = await db
    .select({
      id: roles.id,
      name: roles.name,
      description: roles.description,
      isSystem: roles.isSystem,
      createdAt: roles.createdAt,
      permissions: sql<string[]>`COALESCE(array_agg(${rolePermissions.permission}) FILTER (WHERE ${rolePermissions.permission} IS NOT NULL), ARRAY[]::text[])`,
    })
    .from(roles)
    .leftJoin(rolePermissions, and(eq(rolePermissions.roleId, roles.id), eq(rolePermissions.businessId, roles.businessId)))
    .where(eq(roles.businessId, businessId))
    .groupBy(roles.id)
    .orderBy(desc(roles.createdAt))
    .limit(200);
  return rows;
}

export async function assignUserRole(actor: { userId: string; businessId: string; platform: boolean }, raw: unknown) {
  const input = parseWith(UserRoleAssignSchema, raw);
  return db.transaction(async (tx) => {
    const [role] = await tx.select().from(roles).where(and(eq(roles.id, input.roleId), eq(roles.businessId, actor.businessId)));
    if (!role) throw new AppError(404, "NOT_FOUND", "Role not found");
    const [target] = await tx.select().from(users).where(and(eq(users.id, input.userId), eq(users.businessId, actor.businessId)));
    if (!target) throw new AppError(404, "USER_NOT_FOUND", "User not found in this tenant");
    if (input.revoke) {
      await tx.delete(userRoles).where(and(eq(userRoles.userId, target.id), eq(userRoles.roleId, role.id), eq(userRoles.businessId, actor.businessId)));
    } else {
      const granted = await tx
        .select({ permission: rolePermissions.permission })
        .from(rolePermissions)
        .where(and(eq(rolePermissions.roleId, role.id), eq(rolePermissions.businessId, actor.businessId)));
      const platformOnly = granted.filter((row) => isPlatformOnlyPermission(row.permission));
      if (platformOnly.length && !actor.platform) throw new AppError(403, "FORBIDDEN", "Tenant administrators cannot grant platform privileges");
      await tx
        .insert(userRoles)
        .values({ businessId: actor.businessId, userId: target.id, roleId: role.id })
        .onConflictDoNothing({ target: [userRoles.businessId, userRoles.userId, userRoles.roleId] });
    }
    await tx.insert(auditLogs).values({
      businessId: actor.businessId,
      actorType: "user",
      actorId: actor.userId,
      action: input.revoke ? "rbac.role_revoked" : "rbac.role_assigned",
      entityType: "user_role",
      entityId: target.id,
      requestId: requestContext.getStore()?.requestId,
      metadata: { roleId: role.id, roleName: role.name },
    });
    return { userId: target.id, roleId: role.id, revoked: Boolean(input.revoke) };
  });
}

/** Effective permission set = built-in role grants ∪ custom role grants. */
export async function effectivePermissions(businessId: string, userId: string, role: UserRole): Promise<Set<Permission>> {
  const effective = permissionsFor(role);
  if (role === "SUPER_ADMIN") effective.add("platform:admin" as Permission);
  const custom = await db
    .select({ permission: rolePermissions.permission })
    .from(userRoles)
    .innerJoin(roles, and(eq(roles.id, userRoles.roleId), eq(roles.businessId, userRoles.businessId)))
    .innerJoin(rolePermissions, and(eq(rolePermissions.roleId, roles.id), eq(rolePermissions.businessId, roles.businessId)))
    .where(and(eq(userRoles.businessId, businessId), eq(userRoles.userId, userId)));
  for (const row of custom) effective.add(row.permission as Permission);
  return effective;
}

// ---------------------------------------------------------------------------
// API keys (`ar_live_<prefix>_<secret>`, hash-only storage)
// ---------------------------------------------------------------------------

export const API_KEY_PREFIX = "ar_live";
const API_KEY_SECRET_BYTES = 24;

export const ApiKeyCreateSchema = z
  .object({
    name: z.string().trim().min(2).max(100),
    scopes: z.array(z.string().trim().min(2).max(80)).min(1).max(50),
    expiresInDays: z.number().int().min(1).max(730).optional(),
  })
  .strict();

export function hashApiKey(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

/** Parse a presented key into its prefix/secret halves (null when malformed). */
export function parseApiKey(raw: string): { prefix: string; secret: string } | null {
  const match = /^ar_(live|test)_([A-Za-z0-9]{8,24})_([A-Za-z0-9_-]{16,128})$/.exec(raw);
  if (!match) return null;
  return { prefix: `${API_KEY_PREFIX.replace("ar_live", `ar_${match[1]}`)}_${match[2]}`, secret: match[3] };
}

export async function createApiKey(actor: { userId: string; businessId: string; platform: boolean }, raw: unknown) {
  const input = parseWith(ApiKeyCreateSchema, raw);
  await assertTenantRoleScope(actor.businessId, input.scopes, actor.platform, "credential");
  const prefix = randomBytes(6).toString("hex").slice(0, 12);
  const secret = randomBytes(API_KEY_SECRET_BYTES).toString("base64url");
  const fullKey = `ar_live_${prefix}_${secret}`;
  const [row] = await db
    .insert(apiKeys)
    .values({
      businessId: actor.businessId,
      name: input.name,
      prefix: `ar_live_${prefix}`,
      keyHash: hashApiKey(secret),
      scopes: input.scopes,
      createdBy: actor.userId,
      expiresAt: input.expiresInDays ? new Date(Date.now() + input.expiresInDays * 86_400_000) : null,
      // The full key is shown once; only the hash is persisted.
    })
    .returning({ id: apiKeys.id, prefix: apiKeys.prefix, scopes: apiKeys.scopes, expiresAt: apiKeys.expiresAt, createdAt: apiKeys.createdAt, name: apiKeys.name });
  await db.insert(auditLogs).values({
    businessId: actor.businessId,
    actorType: "user",
    actorId: actor.userId,
    action: "api_key.created",
    entityType: "api_key",
    entityId: row.id,
    requestId: requestContext.getStore()?.requestId,
    metadata: { name: input.name, scopes: input.scopes, prefix: row.prefix },
  });
  return { ...row, key: fullKey };
}

export async function listApiKeys(businessId: string) {
  return db
    .select({
      id: apiKeys.id,
      name: apiKeys.name,
      prefix: apiKeys.prefix,
      scopes: apiKeys.scopes,
      lastUsedAt: apiKeys.lastUsedAt,
      expiresAt: apiKeys.expiresAt,
      revokedAt: apiKeys.revokedAt,
      createdAt: apiKeys.createdAt,
    })
    .from(apiKeys)
    .where(eq(apiKeys.businessId, businessId))
    .orderBy(desc(apiKeys.createdAt))
    .limit(200);
}

export async function revokeApiKey(actor: { userId: string; businessId: string }, keyId: string) {
  const [row] = await db
    .update(apiKeys)
    .set({ revokedAt: new Date() })
    .where(and(eq(apiKeys.id, keyId), eq(apiKeys.businessId, actor.businessId), isNull(apiKeys.revokedAt)))
    .returning({ id: apiKeys.id, prefix: apiKeys.prefix });
  if (!row) throw new AppError(404, "NOT_FOUND", "Active API key not found");
  await db.insert(auditLogs).values({
    businessId: actor.businessId,
    actorType: "user",
    actorId: actor.userId,
    action: "api_key.revoked",
    entityType: "api_key",
    entityId: row.id,
    requestId: requestContext.getStore()?.requestId,
    metadata: { prefix: row.prefix },
  });
  return row;
}

/**
 * Authenticate a presented API key. Returns the tenant + granted scopes, or
 * null. Uses a constant-time comparison against the stored hash and records the
 * last-use timestamp without touching anything else.
 */
export async function authenticateApiKey(presented: string): Promise<{ businessId: string; keyId: string; scopes: string[] } | null> {
  const parsed = parseApiKey(presented);
  if (!parsed) return null;
  const [row] = await db
    .select()
    .from(apiKeys)
    .where(and(eq(apiKeys.prefix, parsed.prefix), isNull(apiKeys.revokedAt)))
    .limit(1);
  if (!row) return null;
  if (row.expiresAt && row.expiresAt <= new Date()) return null;
  const provided = Buffer.from(hashApiKey(parsed.secret), "utf8");
  const stored = Buffer.from(row.keyHash, "utf8");
  if (provided.length !== stored.length || !timingSafeEqual(provided, stored)) {
    logWarn("API key authentication failed", { businessId: row.businessId, operation: "api_key.auth", status: "invalid" });
    return null;
  }
  const [business] = await db.select({ isActive: businesses.isActive }).from(businesses).where(eq(businesses.id, row.businessId));
  if (!business?.isActive) return null;
  await db.update(apiKeys).set({ lastUsedAt: new Date() }).where(eq(apiKeys.id, row.id));
  return { businessId: row.businessId, keyId: row.id, scopes: row.scopes ?? [] };
}

// ---------------------------------------------------------------------------
// Service accounts
// ---------------------------------------------------------------------------

export const ServiceAccountCreateSchema = z
  .object({
    name: z.string().trim().min(2).max(100),
    description: z.string().trim().max(255).optional(),
    scopes: z.array(z.string().trim().min(2).max(80)).min(1).max(50),
  })
  .strict();

export async function createServiceAccount(actor: { userId: string; businessId: string; platform: boolean }, raw: unknown) {
  const input = parseWith(ServiceAccountCreateSchema, raw);
  await assertTenantRoleScope(actor.businessId, input.scopes, actor.platform, "credential");
  return db.transaction(async (tx) => {
    const [account] = await tx
      .insert(serviceAccounts)
      .values({
        businessId: actor.businessId,
        name: input.name,
        description: input.description ?? null,
        scopes: input.scopes,
        createdBy: actor.userId,
      })
      .onConflictDoNothing({ target: [serviceAccounts.businessId, serviceAccounts.name] })
      .returning({ id: serviceAccounts.id, name: serviceAccounts.name, scopes: serviceAccounts.scopes, createdAt: serviceAccounts.createdAt });
    if (!account) throw new AppError(409, "CONFLICT", "A service account with this name already exists");
    // The credential is an API key bound to the service account.
    const prefix = randomBytes(6).toString("hex").slice(0, 12);
    const secret = randomBytes(API_KEY_SECRET_BYTES).toString("base64url");
    const [key] = await tx
      .insert(apiKeys)
      .values({
        businessId: actor.businessId,
        name: `${input.name} (service account)`,
        prefix: `ar_live_${prefix}`,
        keyHash: hashApiKey(secret),
        scopes: input.scopes,
        createdBy: actor.userId,
        serviceAccountId: account.id,
      })
      .returning({ id: apiKeys.id });
    await tx.insert(auditLogs).values({
      businessId: actor.businessId,
      actorType: "user",
      actorId: actor.userId,
      action: "service_account.created",
      entityType: "service_account",
      entityId: account.id,
      requestId: requestContext.getStore()?.requestId,
      metadata: { name: input.name, scopes: input.scopes, apiKeyId: key.id },
    });
    return { ...account, apiKeyId: key.id, key: `ar_live_${prefix}_${secret}` };
  });
}

export async function listServiceAccounts(businessId: string) {
  return db
    .select({
      id: serviceAccounts.id,
      name: serviceAccounts.name,
      description: serviceAccounts.description,
      scopes: serviceAccounts.scopes,
      isActive: serviceAccounts.isActive,
      createdAt: serviceAccounts.createdAt,
    })
    .from(serviceAccounts)
    .where(eq(serviceAccounts.businessId, businessId))
    .orderBy(desc(serviceAccounts.createdAt))
    .limit(200);
}

// ---------------------------------------------------------------------------
// Invitations
// ---------------------------------------------------------------------------

export const InvitationCreateSchema = z
  .object({
    email: z.string().trim().toLowerCase().email().max(255),
    role: z.enum(USER_ROLES).default("AGENT"),
  })
  .strict();

const ASSIGNABLE_TENANT_ROLES: UserRole[] = ["VIEWER", "CALL_OPERATOR", "AGENT_OPERATOR", "AGENT", "MANAGER", "TENANT_ADMIN"];

/**
 * Invite a teammate. The invitation is a single-use, hashed token; the token
 * itself is only ever returned once and never stored in plaintext.
 */
export async function inviteUser(actor: { userId: string; businessId: string }, raw: unknown) {
  const input = parseWith(InvitationCreateSchema, raw);
  if (!ASSIGNABLE_TENANT_ROLES.includes(input.role)) {
    throw new AppError(403, "FORBIDDEN", "Only tenant-level roles can be invited; platform roles are platform-managed");
  }
  const [existingUser] = await db.select({ id: users.id }).from(users).where(eq(users.email, input.email));
  if (existingUser) throw new AppError(409, "EMAIL_EXISTS", "A user with this email already exists");
  const token = randomBytes(32).toString("base64url");
  return db.transaction(async (tx) => {
    // Re-inviting a previously revoked address rotates the token instead of
    // creating a second row (unique on tenant+email).
    const [invitation] = await tx
      .insert(invitations)
      .values({
        businessId: actor.businessId,
        email: input.email,
        role: input.role,
        tokenHash: createHash("sha256").update(token).digest("hex"),
        invitedBy: actor.userId,
        expiresAt: new Date(Date.now() + 7 * 86_400_000),
      })
      .onConflictDoUpdate({
        target: [invitations.businessId, invitations.email],
        set: {
          role: input.role,
          tokenHash: createHash("sha256").update(token).digest("hex"),
          invitedBy: actor.userId,
          expiresAt: new Date(Date.now() + 7 * 86_400_000),
          revokedAt: null,
          acceptedAt: null,
          acceptedByUserId: null,
          resendCount: sql`${invitations.resendCount} + 1`,
        },
      })
      .returning({ id: invitations.id, email: invitations.email, role: invitations.role, expiresAt: invitations.expiresAt });
    await enqueueOutbox(tx, {
      businessId: actor.businessId,
      topic: "user.invited",
      idempotencyKey: `user.invited:${invitation.id}`,
      payload: { businessId: actor.businessId, id: invitation.id, invitationId: invitation.id, email: invitation.email, role: invitation.role },
    });
    await tx.insert(auditLogs).values({
      businessId: actor.businessId,
      actorType: "user",
      actorId: actor.userId,
      action: "user.invited",
      entityType: "invitation",
      entityId: invitation.id,
      requestId: requestContext.getStore()?.requestId,
      metadata: { email: invitation.email, role: invitation.role },
    });
    return { ...invitation, token };
  });
}

export async function listInvitations(businessId: string) {
  return db
    .select({
      id: invitations.id,
      email: invitations.email,
      role: invitations.role,
      acceptedAt: invitations.acceptedAt,
      revokedAt: invitations.revokedAt,
      expiresAt: invitations.expiresAt,
      createdAt: invitations.createdAt,
    })
    .from(invitations)
    .where(eq(invitations.businessId, businessId))
    .orderBy(desc(invitations.createdAt))
    .limit(200);
}

export async function revokeInvitation(actor: { userId: string; businessId: string }, invitationId: string) {
  const [row] = await db
    .update(invitations)
    .set({ revokedAt: new Date() })
    .where(and(eq(invitations.id, invitationId), eq(invitations.businessId, actor.businessId), isNull(invitations.acceptedAt), isNull(invitations.revokedAt)))
    .returning({ id: invitations.id, email: invitations.email });
  if (!row) throw new AppError(404, "NOT_FOUND", "Open invitation not found");
  await db.insert(auditLogs).values({
    businessId: actor.businessId,
    actorType: "user",
    actorId: actor.userId,
    action: "invitation.revoked",
    entityType: "invitation",
    entityId: row.id,
    requestId: requestContext.getStore()?.requestId,
    metadata: { email: row.email },
  });
  return row;
}

export const AcceptInvitationSchema = z
  .object({ token: z.string().min(20).max(200), name: z.string().trim().min(2).max(150), password: z.string().min(12).max(200) })
  .strict();

/** Accept an invitation exactly once; the email must match the invited address. */
export async function acceptInvitation(raw: unknown) {
  const input = parseWith(AcceptInvitationSchema, raw);
  const tokenHash = createHash("sha256").update(input.token).digest("hex");
  const passwordHash = await hashPassword(input.password);
  return db.transaction(async (tx) => {
    const [invitation] = await tx.select().from(invitations).where(eq(invitations.tokenHash, tokenHash)).for("update");
    if (!invitation) throw new AppError(404, "NOT_FOUND", "Invitation not found");
    if (invitation.acceptedAt) throw new AppError(409, "CONFLICT", "Invitation already accepted");
    if (invitation.revokedAt) throw new AppError(409, "CONFLICT", "Invitation was revoked");
    if (invitation.expiresAt <= new Date()) throw new AppError(410, "CONFLICT", "Invitation has expired");
    const [business] = await tx.select({ isActive: businesses.isActive }).from(businesses).where(eq(businesses.id, invitation.businessId));
    if (!business?.isActive) throw new AppError(403, "FORBIDDEN", "Business is inactive");
    const [created] = await tx
      .insert(users)
      .values({
        businessId: invitation.businessId,
        name: input.name,
        email: invitation.email,
        passwordHash,
        role: invitation.role,
        invitedById: invitation.invitedBy,
      })
      .onConflictDoNothing({ target: users.email })
      .returning({ id: users.id, email: users.email, role: users.role, businessId: users.businessId });
    if (!created) throw new AppError(409, "EMAIL_EXISTS", "A user with this email already exists");
    await tx.update(invitations).set({ acceptedAt: new Date() }).where(eq(invitations.id, invitation.id));
    await tx.insert(auditLogs).values({
      businessId: invitation.businessId,
      actorType: "user",
      actorId: created.id,
      action: "invitation.accepted",
      entityType: "invitation",
      entityId: invitation.id,
      requestId: requestContext.getStore()?.requestId,
      metadata: { email: created.email, role: created.role },
    });
    return { userId: created.id, businessId: created.businessId, email: created.email, role: created.role };
  });
}

// ---------------------------------------------------------------------------
// Support access (read-only, time-boxed, audited)
// ---------------------------------------------------------------------------

export const SupportSessionStartSchema = z
  .object({
    businessId: z.string().uuid(),
    reason: z.string().trim().min(10).max(500),
    ttlMinutes: z.number().int().min(5).max(480).optional(),
  })
  .strict();

/**
 * Start a read-only support session for a tenant. This is NOT impersonation:
 * it grants no token that could act as a tenant user, and it expires on its own.
 */
export async function startSupportSession(actor: { userId: string; mfaEnabled: boolean }, raw: unknown) {
  const input = parseWith(SupportSessionStartSchema, raw);
  if (!actor.mfaEnabled) throw new AppError(403, "FORBIDDEN", "MFA is required for support access");
  return db.transaction(async (tx) => {
    const [session] = await tx
      .insert(supportSessions)
      .values({
        businessId: input.businessId,
        actorId: actor.userId,
        reason: input.reason,
        readOnly: true,
        expiresAt: new Date(Date.now() + (input.ttlMinutes ?? 60) * 60_000),
      })
      .returning({ id: supportSessions.id, businessId: supportSessions.businessId, expiresAt: supportSessions.expiresAt, readOnly: supportSessions.readOnly });
    await tx.insert(auditLogs).values({
      businessId: input.businessId,
      actorType: "platform_admin",
      actorId: actor.userId,
      action: "support.session_started",
      entityType: "support_session",
      entityId: session.id,
      requestId: requestContext.getStore()?.requestId,
      metadata: { expiresAt: session.expiresAt.toISOString(), readOnly: true, ttlMinutes: input.ttlMinutes ?? 60 },
    });
    logInfo("Support session started", { businessId: input.businessId, actorId: actor.userId, operation: "support.start", status: "ok" });
    return session;
  });
}

export async function revokeSupportSession(actor: { userId: string }, sessionId: string) {
  const [row] = await db
    .update(supportSessions)
    .set({ revokedAt: new Date() })
    .where(and(eq(supportSessions.id, sessionId), isNull(supportSessions.revokedAt)))
    .returning({ id: supportSessions.id, businessId: supportSessions.businessId });
  if (!row) throw new AppError(404, "NOT_FOUND", "Support session not found");
  await db.insert(auditLogs).values({
    businessId: row.businessId,
    actorType: "platform_admin",
    actorId: actor.userId,
    action: "support.session_revoked",
    entityType: "support_session",
    entityId: row.id,
    requestId: requestContext.getStore()?.requestId,
    metadata: {},
  });
  return row;
}

/** True when an active, unexpired support session exists for the tenant. */
export async function hasActiveSupportSession(businessId: string, actorId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: supportSessions.id })
    .from(supportSessions)
    .where(
      and(
        eq(supportSessions.businessId, businessId),
        eq(supportSessions.actorId, actorId),
        isNull(supportSessions.revokedAt),
        sql`${supportSessions.expiresAt} > now()`,
      ),
    )
    .limit(1);
  return Boolean(row);
}

export async function supportSessionReason(sessionId: string): Promise<string | null> {
  const [row] = await db.select({ reason: supportSessions.reason }).from(supportSessions).where(eq(supportSessions.id, sessionId));
  return row?.reason ?? null;
}
