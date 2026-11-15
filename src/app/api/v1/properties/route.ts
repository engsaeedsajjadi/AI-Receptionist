import { and, desc, eq, sql } from "drizzle-orm";
import { NextRequest } from "next/server";
import { db } from "@/db";
import { properties } from "@/db/schema";
import { ApiError, ok, parseJsonWith } from "@/lib/api";
import { getAuthContext } from "@/lib/auth";
import { hasRole } from "@/lib/permissions";
import { checkGlobalPublicRateLimit, withApiHandling } from "@/lib/server-core";
import { PropertyUpsertSchema, createProperty } from "@/lib/services/properties";
import { cursorPage, keysetCondition, keysetOrder, parseListWindow } from "@/lib/pagination";

export async function GET(req: NextRequest) {
  return withApiHandling(async () => {
    await checkGlobalPublicRateLimit(req);
    const auth = await getAuthContext(req);
    const listWindow = parseListWindow(req);

    const conditions = [eq(properties.businessId, auth.businessId)];
    const txn = req.nextUrl.searchParams.get("transaction_type");
    const city = req.nextUrl.searchParams.get("city");
    const available = req.nextUrl.searchParams.get("available");
    if (txn) conditions.push(eq(properties.transactionType, txn));
    if (city) conditions.push(eq(properties.city, city));
    if (available === "true") conditions.push(eq(properties.isAvailable, true));
    if (available === "false") conditions.push(eq(properties.isAvailable, false));

    if (listWindow.cursor) {
      conditions.push(keysetCondition({ createdAt: properties.createdAt, id: properties.id }, listWindow.cursor));
    }

    const [rows, total] = await Promise.all([
      db
        .select()
        .from(properties)
        .where(and(...conditions))
        .orderBy(...keysetOrder({ createdAt: properties.createdAt, id: properties.id }))
        .limit(listWindow.cursor ? listWindow.limit + 1 : listWindow.limit)
        .offset(listWindow.cursor ? 0 : listWindow.offset),
      db
        .select({ count: sql<number>`count(*)::int` })
        .from(properties)
        .where(and(...conditions))
        .then((r) => r[0]?.count ?? 0),
    ]);

    return ok(cursorPage({ rows, limit: listWindow.limit, page: listWindow.page, extra: Boolean(listWindow.cursor), total }));
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
