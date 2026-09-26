import { and, desc, eq, ne } from "drizzle-orm";
import { NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/db";
import { users } from "@/db/schema";
import { ApiError, ok, paginated, parseJsonWith, parsePagination } from "@/lib/api";
import { getAuthContext, hashPassword, validatePasswordPolicy } from "@/lib/auth";
import { normalizePersianText, normalizePhone } from "@/lib/normalization";
import { hasRole } from "@/lib/permissions";
import { checkGlobalPublicRateLimit, withApiHandling } from "@/lib/server-core";

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

export async function GET(req: NextRequest) {
  return withApiHandling(async () => {
    await checkGlobalPublicRateLimit(req);
    const auth = await getAuthContext(req);
    if (!hasRole(auth.role, "MANAGER")) throw new ApiError(403, "FORBIDDEN", "Insufficient permissions");
    const { page, limit, offset } = parsePagination(req);

    const rows = await db
      .select()
      .from(users)
      .where(eq(users.businessId, auth.businessId))
      .orderBy(desc(users.createdAt))
      .limit(limit)
      .offset(offset);

    return ok(paginated(rows.map(publicUser), page, limit, offset + rows.length));
  });
}

const createSchema = z.object({
  name: z.string().min(2).max(150),
  email: z.string().email().max(255),
  phone: z.string().max(30).optional(),
  password: z.string().min(8).max(128),
  role: z.enum(["ADMIN", "MANAGER", "AGENT"]).default("AGENT"),
});

export async function POST(req: NextRequest) {
  return withApiHandling(async () => {
    await checkGlobalPublicRateLimit(req);
    const auth = await getAuthContext(req);
    // Only ADMIN can manage users; MANAGER can create AGENTs.
    if (!hasRole(auth.role, "MANAGER")) throw new ApiError(403, "FORBIDDEN", "Insufficient permissions");
    const body = await parseJsonWith(req, createSchema);
    if (body.role !== "AGENT" && !hasRole(auth.role, "ADMIN")) {
      throw new ApiError(403, "FORBIDDEN", "Only ADMIN can create MANAGER/ADMIN users");
    }
    validatePasswordPolicy(body.password);

    const email = body.email.toLowerCase().trim();
    const [existing] = await db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);
    if (existing) throw new ApiError(409, "EMAIL_EXISTS", "Email already exists");

    const [created] = await db
      .insert(users)
      .values({
        businessId: auth.businessId,
        name: normalizePersianText(body.name),
        email,
        phone: body.phone ? (normalizePhone(body.phone) ?? normalizePersianText(body.phone)) : null,
        passwordHash: await hashPassword(body.password),
        role: body.role,
      })
      .returning();
    return ok(publicUser(created), 201);
  });
}

