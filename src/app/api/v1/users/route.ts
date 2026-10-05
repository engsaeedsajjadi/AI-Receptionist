import { inventoryQuota } from "@/lib/services/quotas";
import { and, desc, eq, ne, sql } from "drizzle-orm";
import { NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/db";
import { users } from "@/db/schema";
import { ApiError, mapUniqueViolation, ok, parseJsonWith } from "@/lib/api";
import { getAuthContext, hashPassword, validatePasswordPolicy } from "@/lib/auth";
import { normalizePersianText, normalizePhone } from "@/lib/normalization";
import { hasRole } from "@/lib/permissions";
import { checkGlobalPublicRateLimit, withApiHandling } from "@/lib/server-core";
import { cursorPage, keysetCondition, parseListWindow } from "@/lib/pagination";

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
    const listWindow = parseListWindow(req);
    const conditions = [eq(users.businessId, auth.businessId)];
    if (listWindow.cursor) conditions.push(keysetCondition({ createdAt: users.createdAt, id: users.id }, listWindow.cursor));

    const [rows, total] = await Promise.all([
      db
        .select()
        .from(users)
        .where(and(...conditions))
        .orderBy(desc(users.createdAt), desc(users.id))
        .limit(listWindow.cursor ? listWindow.limit + 1 : listWindow.limit)
        .offset(listWindow.cursor ? 0 : listWindow.offset),
      db
        .select({ count: sql<number>`count(*)::int` })
        .from(users)
        .where(and(...conditions))
        .then((r) => r[0]?.count ?? 0),
    ]);

    return ok(cursorPage({ rows: rows.map(publicUser), limit: listWindow.limit, page: listWindow.page, extra: Boolean(listWindow.cursor), total }));
  });
}

const createSchema = z.object({
  name: z.string().min(2).max(150),
  email: z.string().email().max(255),
  phone: z.string().max(30).optional(),
  password: z.string().min(8).max(128),
  role: z.enum(["ADMIN", "MANAGER", "AGENT", "TENANT_ADMIN", "AGENT_OPERATOR", "CALL_OPERATOR", "VIEWER"]).default("AGENT"),
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

    const passwordHash = await hashPassword(body.password);
    let created: typeof users.$inferSelect;
    try {
      created = await db.transaction(async (tx) => {
        await inventoryQuota(tx, auth.businessId, "tenant_users", 1);
        const [row] = await tx
        .insert(users)
        .values({
          businessId: auth.businessId,
          name: normalizePersianText(body.name),
          email,
          phone: body.phone ? (normalizePhone(body.phone) ?? normalizePersianText(body.phone)) : null,
          passwordHash,
          role: body.role,
        })
        .returning();
        return row;
      });
    } catch (err) {
      mapUniqueViolation(err, {
        users_email_idx: { code: "EMAIL_EXISTS", message: "Email already exists" },
      });
    }
    return ok(publicUser(created!), 201);
  });
}

