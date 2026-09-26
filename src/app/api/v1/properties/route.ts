import { and, desc, eq } from "drizzle-orm";
import { NextRequest } from "next/server";
import { db } from "@/db";
import { properties } from "@/db/schema";
import { ApiError, ok, paginated, parseJsonWith, parsePagination } from "@/lib/api";
import { getAuthContext } from "@/lib/auth";
import { hasRole } from "@/lib/permissions";
import { checkGlobalPublicRateLimit, withApiHandling } from "@/lib/server-core";
import { PropertyUpsertSchema, createProperty } from "@/lib/services/properties";

export async function GET(req: NextRequest) {
  return withApiHandling(async () => {
    await checkGlobalPublicRateLimit(req);
    const auth = await getAuthContext(req);
    const { page, limit, offset } = parsePagination(req);

    const conditions = [eq(properties.businessId, auth.businessId)];
    const txn = req.nextUrl.searchParams.get("transaction_type");
    const city = req.nextUrl.searchParams.get("city");
    const available = req.nextUrl.searchParams.get("available");
    if (txn) conditions.push(eq(properties.transactionType, txn));
    if (city) conditions.push(eq(properties.city, city));
    if (available === "true") conditions.push(eq(properties.isAvailable, true));
    if (available === "false") conditions.push(eq(properties.isAvailable, false));

    const rows = await db
      .select()
      .from(properties)
      .where(and(...conditions))
      .orderBy(desc(properties.createdAt))
      .limit(limit)
      .offset(offset);

    return ok(paginated(rows, page, limit, offset + rows.length + (rows.length === limit ? 1 : 0)));
  });
}

export async function POST(req: NextRequest) {
  return withApiHandling(async () => {
    await checkGlobalPublicRateLimit(req);
    const auth = await getAuthContext(req);
    if (!hasRole(auth.role, "MANAGER")) throw new ApiError(403, "FORBIDDEN", "Insufficient permissions");
    const body = await parseJsonWith(req, PropertyUpsertSchema);
    const created = await createProperty(auth.businessId, body);
    return ok(created, 201);
  });
}
