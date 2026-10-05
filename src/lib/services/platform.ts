import { and, asc, eq, gt, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { auditLogs, businesses, refreshTokens, users } from "@/db/schema";
import { AppError } from "@/lib/api";
import { requestContext } from "@/lib/request-context";

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
    if (tenant.isActive === change.isActive) return { id: tenant.id, isActive: tenant.isActive, changed: false };
    const now = new Date();
    await tx.update(businesses).set({ isActive: change.isActive, updatedAt: now }).where(eq(businesses.id, change.id));
    if (!change.isActive) {
      await tx.update(users).set({ credentialVersion: sql`${users.credentialVersion} + 1`, updatedAt: now }).where(eq(users.businessId, change.id));
      await tx.update(refreshTokens).set({ revokedAt: now, revokedReason: "tenant_suspended" })
        .where(and(eq(refreshTokens.businessId, change.id), isNull(refreshTokens.revokedAt)));
    }
    await tx.insert(auditLogs).values({ businessId: change.id, actorType: "platform_admin", actorId,
      action: change.isActive ? "tenant.reactivated" : "tenant.suspended", entityType: "business", entityId: change.id,
      requestId: requestContext.getStore()?.requestId,
      metadata: { reason: change.reason, actorBusinessId: actor.businessId, previousState: tenant.isActive } });
    return { id: change.id, isActive: change.isActive, changed: true };
  });
}
