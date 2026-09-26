import { desc, eq, sql } from "drizzle-orm";
import { NextRequest } from "next/server";
import { db } from "@/db";
import { usageRecords } from "@/db/schema";
import { ok } from "@/lib/api";
import { getAuthContext } from "@/lib/auth";
import { checkGlobalPublicRateLimit, withApiHandling } from "@/lib/server-core";

export async function GET(req: NextRequest) {
  return withApiHandling(async () => {
    checkGlobalPublicRateLimit(req);
    const auth = await getAuthContext(req);

    const records = await db
      .select()
      .from(usageRecords)
      .where(eq(usageRecords.businessId, auth.businessId))
      .orderBy(desc(usageRecords.createdAt));

    const totals = await db
      .select({ type: usageRecords.type, total: sql<string>`sum(${usageRecords.quantity})` })
      .from(usageRecords)
      .where(eq(usageRecords.businessId, auth.businessId))
      .groupBy(usageRecords.type);

    return ok({ records, totals });
  });
}
