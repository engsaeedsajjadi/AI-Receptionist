import { and, eq } from "drizzle-orm";
import { NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/db";
import { users } from "@/db/schema";
import { ApiError, ok, parseJsonWith } from "@/lib/api";
import { getAuthContext, hashPassword, revokeAllSessions, validatePasswordPolicy } from "@/lib/auth";
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
  role: z.enum(["ADMIN", "MANAGER", "AGENT"]).optional(),
  isActive: z.boolean().optional(),
  password: z.string().min(8).max(128).optional(),
});

/**
 * Removing the last active ADMIN (demote, deactivate, delete) would lock the
 * tenant out of user/business management. Refuse with 400 instead.
 */
async function assertNotLastAdmin(businessId: string, targetUserId: string): Promise<void> {
  const [target] = await db
    .select({ role: users.role, isActive: users.isActive })
    .from(users)
    .where(and(eq(users.id, targetUserId), eq(users.businessId, businessId)))
    .limit(1);
  if (!target || target.role !== "ADMIN" || !target.isActive) return;
  const admins = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.businessId, businessId), eq(users.role, "ADMIN"), eq(users.isActive, true)));
  if (admins.length <= 1) {
    throw new ApiError(400, "BAD_REQUEST", "Cannot remove the last active ADMIN");
  }
}

export async function PUT(req: NextRequest, ctx: Ctx) {
  return withApiHandling(async () => {
    await checkGlobalPublicRateLimit(req);
    const auth = await getAuthContext(req);
    if (!hasRole(auth.role, "ADMIN")) throw new ApiError(403, "FORBIDDEN", "Insufficient permissions");
    const { id } = await ctx.params;
    const body = await parseJsonWith(req, updateSchema);

    if (id === auth.userId && body.isActive === false) {
      throw new ApiError(400, "BAD_REQUEST", "You cannot deactivate your own account");
    }
    if ((body.role && body.role !== "ADMIN") || body.isActive === false) {
      await assertNotLastAdmin(auth.businessId, id);
    }
    if (body.password) validatePasswordPolicy(body.password);

    const [updated] = await db
      .update(users)
      .set({
        name: body.name ? normalizePersianText(body.name) : undefined,
        role: body.role,
        isActive: body.isActive,
        passwordHash: body.password ? await hashPassword(body.password) : undefined,
        failedLoginCount: 0,
        lockedUntil: null,
        updatedAt: new Date(),
      })
      .where(and(eq(users.id, id), eq(users.businessId, auth.businessId)))
      .returning();
    if (!updated) throw new ApiError(404, "USER_NOT_FOUND", "User not found");

    // Password change / deactivation revokes all sessions.
    if (body.password || body.isActive === false) {
      await revokeAllSessions(updated.id);
    }
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
    await assertNotLastAdmin(auth.businessId, id);
    // Soft-delete: deactivate + revoke sessions (preserves FK history).
    const [updated] = await db
      .update(users)
      .set({ isActive: false, updatedAt: new Date() })
      .where(and(eq(users.id, id), eq(users.businessId, auth.businessId)))
      .returning();
    if (!updated) throw new ApiError(404, "USER_NOT_FOUND", "User not found");
    await revokeAllSessions(updated.id);
    return ok({ ok: true });
  });
}
