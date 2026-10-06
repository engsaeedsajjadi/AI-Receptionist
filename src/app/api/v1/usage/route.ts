import { and, desc, eq, sql } from "drizzle-orm";
import { NextRequest } from "next/server";
import { db } from "@/db";
import { usageRecords } from "@/db/schema";
import { ok } from "@/lib/api";
import { getAuthContext } from "@/lib/auth";
import { checkGlobalPublicRateLimit, withApiHandling } from "@/lib/server-core";
import { cursorPage, keysetCondition, keysetOrder, parseListWindow } from "@/lib/pagination";

export async function GET(req: NextRequest) {
  return withApiHandling(async () => {
    await checkGlobalPublicRateLimit(req);
    const auth = await getAuthContext(req);
    const listWindow = parseListWindow(req);

    const type = req.nextUrl.searchParams.get("type");
    const conditions = [eq(usageRecords.businessId, auth.businessId)];
    if (type) conditions.push(eq(usageRecords.type, type));
    if (listWindow.cursor) conditions.push(keysetCondition({ createdAt: usageRecords.createdAt, id: usageRecords.id }, listWindow.cursor));

    const [records, totals, cost] = await Promise.all([
      db
        .select()
        .from(usageRecords)
        .where(and(...conditions))
        .orderBy(...keysetOrder({ createdAt: usageRecords.createdAt, id: usageRecords.id }))
        .limit(listWindow.cursor ? listWindow.limit + 1 : listWindow.limit)
        .offset(listWindow.cursor ? 0 : listWindow.offset),
      db
        .select({ type: usageRecords.type, total: sql<string>`sum(${usageRecords.quantity})` })
        .from(usageRecords)
        .where(eq(usageRecords.businessId, auth.businessId))
        .groupBy(usageRecords.type),
      db
        .select({ totalCost: sql<string>`coalesce(sum(${usageRecords.estimatedCost}), 0)` })
        .from(usageRecords)
        .where(eq(usageRecords.businessId, auth.businessId))
        .then((r) => r[0]?.totalCost ?? "0"),
    ]);

    const [count] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(usageRecords)
      .where(and(...conditions));
    return ok({
      ...cursorPage({ rows: records, limit: listWindow.limit, page: listWindow.page, extra: Boolean(listWindow.cursor), total: count?.count ?? 0 }),
      totals,
      estimatedCostUsd: cost,
    });
  });
}
