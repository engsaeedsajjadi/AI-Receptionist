import { and, asc, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { auditLogs, businesses, refreshTokens, users } from "@/db/schema";
import { AppError } from "@/lib/api";
import { requestContext } from "@/lib/request-context";
import { enqueueOutbox } from "@/lib/services/outbox";

export const TenantStateSchema = z.object({
  id: z.string().uuid(), isActive: z.boolean(), reason: z.string().trim().min(10).max(1000),
}).strict();
const PageSchema = z.object({ after: z.string().uuid().optional(), limit: z.coerce.number().int().min(1).max(100).default(30) });
type Executor = Pick<typeof db, "select">;
// Deliberate control-plane exception: check live identity before any cross-tenant query.
export async function requirePlatformAdmin(executor: Executor, actorId: string, lock = false) {
  z.string().uuid().parse(actorId);
  const query = executor.select({ id: users.id, businessId: users.businessId })
    .from(users).innerJoin(businesses, eq(users.businessId, businesses.id))
    .where(and(eq(users.id, actorId), eq(users.role, "SUPER_ADMIN"), eq(users.isActive, true),
      eq(users.mfaEnabled, true), eq(businesses.isActive, true))).limit(1);
  const [actor] = await (lock ? query.for("share", { of: users }) : query);
  if (!actor) throw new AppError(403, "FORBIDDEN", "An active platform administrator with MFA is required");
  return actor;
}
export async function listPlatformTenants(actorId: string, input: unknown) {
  await requirePlatformAdmin(db, actorId);
  const page = PageSchema.parse(input);
  const rows = await db.select({ id: businesses.id, name: businesses.name, slug: businesses.slug,
    isActive: businesses.isActive, createdAt: businesses.createdAt }).from(businesses)
    .where(page.after ? gt(businesses.id, page.after) : undefined).orderBy(asc(businesses.id)).limit(page.limit + 1);
  const hasMore = rows.length > page.limit;
  const tenants = rows.slice(0, page.limit);
  return { tenants, nextCursor: hasMore ? tenants[tenants.length - 1].id : null };
}
export async function changePlatformTenantState(actorId: string, input: unknown) {
  const change = TenantStateSchema.parse(input);
  return db.transaction(async (tx) => {
    const actor = await requirePlatformAdmin(tx, actorId, true);
    if (actor.businessId === change.id) throw new AppError(409, "CONFLICT", "Cannot change your own platform tenant state");
    const [tenant] = await tx.select().from(businesses).where(eq(businesses.id, change.id)).for("update");
    if (!tenant) throw new AppError(404, "NOT_FOUND", "Tenant not found");
    // Match identity service lock ordering: users are locked before session revocation.
    await tx.select({ id: users.id }).from(users).where(eq(users.businessId, change.id)).orderBy(asc(users.id)).for("update");
    // Recheck after waiting for target locks, including a concurrent administrator demotion.
    await requirePlatformAdmin(tx, actorId);
    // The suspend switch must not bypass the offboarding state machine: a tenant
    // that is pending deletion (or deleted) can only come back through
    // `cancelTenantDeletion`, otherwise the grace window is meaningless.
    if (tenant.status === "DELETED") throw new AppError(409, "CONFLICT", "Tenant is deleted and cannot be reactivated");
    if (change.isActive && tenant.status === "PENDING_DELETION") {
      throw new AppError(409, "CONFLICT", "Tenant is pending deletion; cancel the deletion instead of reactivating it");
    }
    if (tenant.isActive === change.isActive) return { id: tenant.id, isActive: tenant.isActive, changed: false };
    const now = new Date();
    // Keep `status` in step with the operational flag so no runtime gate sees a
    // suspended tenant that still reports ACTIVE (or vice versa).
    const nextStatus = change.isActive ? "ACTIVE" : "SUSPENDED";
    await tx.update(businesses).set({ isActive: change.isActive, status: nextStatus, updatedAt: now }).where(eq(businesses.id, change.id));
    if (!change.isActive) {
      await tx.update(users).set({ credentialVersion: sql`${users.credentialVersion} + 1`, updatedAt: now }).where(eq(users.businessId, change.id));
      await tx.update(refreshTokens).set({ revokedAt: now, revokedReason: "tenant_suspended" })
        .where(and(eq(refreshTokens.businessId, change.id), isNull(refreshTokens.revokedAt)));
    }
    await tx.insert(auditLogs).values({ businessId: change.id, actorType: "platform_admin", actorId,
      action: change.isActive ? "tenant.reactivated" : "tenant.suspended", entityType: "business", entityId: change.id,
      requestId: requestContext.getStore()?.requestId,
      metadata: { reason: change.reason, actorBusinessId: actor.businessId, previousState: tenant.isActive,
        previousStatus: tenant.status, nextStatus } });
    await enqueueOutbox(tx, {
      businessId: change.id,
      topic: change.isActive ? "tenant.reactivated" : "tenant.suspended",
      idempotencyKey: `tenant.${change.isActive ? "reactivated" : "suspended"}:${change.id}:${now.getTime()}`,
      payload: { businessId: change.id, id: change.id, reason: change.reason, actorId },
    });
    return { id: change.id, isActive: change.isActive, changed: true };
  });
}

/**
 * Tenant-admin authorization (used by tenant-scoped operator tooling such as
 * the outbox viewer and data export). Platform administration is a strictly
 * different privilege and is never granted here.
 */
export async function assertTenantAdmin(actorId: string, businessId: string) {
  z.string().uuid().parse(actorId);
  z.string().uuid().parse(businessId);
  const [actor] = await db
    .select({ id: users.id, businessId: users.businessId, role: users.role })
    .from(users)
    .innerJoin(businesses, eq(users.businessId, businesses.id))
    .where(
      and(
        eq(users.id, actorId),
        eq(users.businessId, businessId),
        eq(users.isActive, true),
        eq(businesses.isActive, true),
        inArray(users.role, ["ADMIN", "TENANT_ADMIN"]),
      ),
    )
    .limit(1);
  if (!actor) throw new AppError(403, "FORBIDDEN", "Tenant administrator access is required");
  return actor;
}
