import { and, desc, eq, ilike, sql } from "drizzle-orm";
import { NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/db";
import { customers } from "@/db/schema";
import { ok, paginated, parseJsonWith, parsePagination } from "@/lib/api";
import { getAuthContext } from "@/lib/auth";
import { normalizePersianText, normalizePhone } from "@/lib/normalization";
import { checkGlobalPublicRateLimit, withApiHandling } from "@/lib/server-core";
import { findOrCreateCustomer } from "@/lib/services/customers";

export async function GET(req: NextRequest) {
  return withApiHandling(async () => {
    await checkGlobalPublicRateLimit(req);
    const auth = await getAuthContext(req);
    const { page, limit, offset } = parsePagination(req);

    const q = req.nextUrl.searchParams.get("q");
    const conditions = [eq(customers.businessId, auth.businessId)];
    if (q) {
      const needle = `%${normalizePersianText(q)}%`;
      conditions.push(sql`(${ilike(customers.name, needle)} OR ${ilike(customers.phone, needle)})`);
    }

    const [rows, total] = await Promise.all([
      db.select().from(customers).where(and(...conditions)).orderBy(desc(customers.createdAt)).limit(limit).offset(offset),
      db.select({ count: sql<number>`count(*)::int` }).from(customers).where(and(...conditions)).then((r) => r[0]?.count ?? 0),
    ]);

    return ok(paginated(rows, page, limit, total));
  });
}

const createSchema = z.object({
  phone: z.string().min(5).max(30),
  name: z.string().max(255).optional(),
  email: z.string().email().max(255).optional(),
});

export async function POST(req: NextRequest) {
  return withApiHandling(async () => {
    await checkGlobalPublicRateLimit(req);
    const auth = await getAuthContext(req);
    const body = await parseJsonWith(req, createSchema);
    const phone = normalizePhone(body.phone) ?? body.phone;
    const customer = await findOrCreateCustomer({
      businessId: auth.businessId,
      phone,
      name: body.name,
      email: body.email,
    });
    return ok(customer, 201);
  });
}
