import { and, eq, inArray, isNull } from "drizzle-orm";
import { NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/db";
import { businesses, refreshTokens, users } from "@/db/schema";
import { ApiError, ok, parseJsonWith } from "@/lib/api";
import { getAuthContext, hashPassword, validatePasswordPolicy } from "@/lib/auth";
import { normalizePersianText } from "@/lib/normalization";
import { hasRole } from "@/lib/permissions";
import { checkGlobalPublicRateLimit, withApiHandling } from "@/lib/server-core";

type Ctx = { params: Promise<{ id: string }> };

function publicUser(u: typeof users.$inferSelect) {
  return {
    id: u.id,
    businessId: u.businessId,
    name: u.name,
    email: u.email,
    phone: u.phone,
    role: u.role,
    isActive: u.isActive,
    lastLoginAt: u.lastLoginAt,
    createdAt: u.createdAt,
  };
}

export async function GET(req: NextRequest, ctx: Ctx) {
  return withApiHandling(async () => {
    await checkGlobalPublicRateLimit(req);
    const auth = await getAuthContext(req);
    if (!hasRole(auth.role, "MANAGER")) throw new ApiError(403, "FORBIDDEN", "Insufficient permissions");
    const { id } = await ctx.params;
    const [row] = await db
      .select()
      .from(users)
      .where(and(eq(users.id, id), eq(users.businessId, auth.businessId)))
      .limit(1);
    if (!row) throw new ApiError(404, "USER_NOT_FOUND", "User not found");
    return ok(publicUser(row));
  });
}

const updateSchema = z.object({
  name: z.string().min(2).max(150).optional(),
  role: z.enum(["ADMIN", "MANAGER", "AGENT", "TENANT_ADMIN", "AGENT_OPERATOR", "CALL_OPERATOR", "VIEWER"]).optional(),
  isActive: z.boolean().optional(),
  password: z.string().min(8).max(128).optional(),
});

type UserTx = Parameters<Parameters<typeof db.transaction>[0]>[0];
async function protectTarget(tx: UserTx, businessId: string, id: string, actorRole: string, removesAdmin: boolean) {
  await tx.select({ id: businesses.id }).from(businesses).where(eq(businesses.id, businessId)).for("update");
  const [target] = await tx.select().from(users).where(and(eq(users.id, id), eq(users.businessId, businessId))).for("update").limit(1);
  if (!target) throw new ApiError(404, "USER_NOT_FOUND", "User not found");
  if (target.role === "SUPER_ADMIN" && actorRole !== "SUPER_ADMIN") throw new ApiError(403, "FORBIDDEN", "Platform administrator is protected");
  if (removesAdmin && ["ADMIN", "TENANT_ADMIN", "SUPER_ADMIN"].includes(target.role) && target.isActive) {
    const admins = await tx.select({ id: users.id }).from(users).where(and(eq(users.businessId, businessId), inArray(users.role, ["ADMIN", "TENANT_ADMIN", "SUPER_ADMIN"]), eq(users.isActive, true)));
    if (admins.length <= 1) throw new ApiError(400, "BAD_REQUEST", "Cannot remove the last active ADMIN");
  }
  return target;
}
export async function PUT(req: NextRequest, ctx: Ctx) {
  return withApiHandling(async () => {
    await checkGlobalPublicRateLimit(req);
    const auth = await getAuthContext(req);
    if (!hasRole(auth.role, "ADMIN")) throw new ApiError(403, "FORBIDDEN", "Insufficient permissions");
    const { id } = await ctx.params;
    const body = await parseJsonWith(req, updateSchema);
    if (id === auth.userId && body.isActive === false) throw new ApiError(400, "BAD_REQUEST", "You cannot deactivate your own account");
    if (body.password) validatePasswordPolicy(body.password);
    const passwordHash = body.password ? await hashPassword(body.password) : undefined;
    const updated = await db.transaction(async (tx) => {
      const target = await protectTarget(tx, auth.businessId, id, auth.role,
        Boolean((body.role && !["ADMIN", "TENANT_ADMIN"].includes(body.role)) || body.isActive === false));
      const changesIdentity = Boolean(passwordHash || body.role || body.isActive === false);
      const [row] = await tx.update(users).set({ name: body.name ? normalizePersianText(body.name) : undefined,
        role: body.role, isActive: body.isActive, passwordHash,
        credentialVersion: changesIdentity ? target.credentialVersion + 1 : undefined,
        failedLoginCount: 0, lockedUntil: null, updatedAt: new Date(),
      }).where(and(eq(users.id, id), eq(users.businessId, auth.businessId))).returning();
      if (changesIdentity) await tx.update(refreshTokens).set({ revokedAt: new Date(), revokedReason: "identity_changed" }).where(and(eq(refreshTokens.userId, id), isNull(refreshTokens.revokedAt)));
      return row;
    });
    return ok(publicUser(updated));
  });
}
export async function DELETE(req: NextRequest, ctx: Ctx) {
  return withApiHandling(async () => {
    await checkGlobalPublicRateLimit(req);
    const auth = await getAuthContext(req);
    if (!hasRole(auth.role, "ADMIN")) throw new ApiError(403, "FORBIDDEN", "Insufficient permissions");
    const { id } = await ctx.params;
    if (id === auth.userId) throw new ApiError(400, "BAD_REQUEST", "You cannot delete your own account");
    await db.transaction(async (tx) => {
      const target = await protectTarget(tx, auth.businessId, id, auth.role, true);
      await tx.update(users).set({ isActive: false, credentialVersion: target.credentialVersion + 1, updatedAt: new Date() }).where(eq(users.id, id));
      await tx.update(refreshTokens).set({ revokedAt: new Date(), revokedReason: "deactivated" }).where(and(eq(refreshTokens.userId, id), isNull(refreshTokens.revokedAt)));
    });
    return ok({ ok: true });
  });
}
