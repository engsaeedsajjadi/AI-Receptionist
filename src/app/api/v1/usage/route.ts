import { and, desc, eq, sql } from "drizzle-orm";
import { NextRequest } from "next/server";
import { db } from "@/db";
import { usageRecords } from "@/db/schema";
import { ok, paginated, parsePagination } from "@/lib/api";
import { getAuthContext } from "@/lib/auth";
import { checkGlobalPublicRateLimit, withApiHandling } from "@/lib/server-core";

export async function GET(req: NextRequest) {
  return withApiHandling(async () => {
    await checkGlobalPublicRateLimit(req);
    const auth = await getAuthContext(req);
    const { page, limit, offset } = parsePagination(req);

    const type = req.nextUrl.searchParams.get("type");
    const conditions = [eq(usageRecords.businessId, auth.businessId)];
    if (type) conditions.push(eq(usageRecords.type, type));

    const [records, totals, cost] = await Promise.all([
      db
        .select()
        .from(usageRecords)
        .where(and(...conditions))
        .orderBy(desc(usageRecords.createdAt))
        .limit(limit)
        .offset(offset),
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

    return ok({ ...paginated(records, page, limit, offset + records.length), totals, estimatedCostUsd: cost });
  });
}
