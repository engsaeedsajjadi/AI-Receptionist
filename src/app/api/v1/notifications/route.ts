import { and, desc, eq } from "drizzle-orm";
import { NextRequest } from "next/server";
import { db } from "@/db";
import { notifications } from "@/db/schema";
import { ok, paginated, parsePagination } from "@/lib/api";
import { getAuthContext } from "@/lib/auth";
import { checkGlobalPublicRateLimit, withApiHandling } from "@/lib/server-core";

export async function GET(req: NextRequest) {
  return withApiHandling(async () => {
    await checkGlobalPublicRateLimit(req);
    const auth = await getAuthContext(req);
    const { page, limit, offset } = parsePagination(req);

    const conditions = [eq(notifications.businessId, auth.businessId)];
    const status = req.nextUrl.searchParams.get("status");
    const type = req.nextUrl.searchParams.get("type");
    if (status) conditions.push(eq(notifications.status, status as "PENDING" | "SENT" | "FAILED"));
    if (type) conditions.push(eq(notifications.type, type));

    const rows = await db
      .select()
      .from(notifications)
      .where(and(...conditions))
      .orderBy(desc(notifications.createdAt))
      .limit(limit)
      .offset(offset);

    return ok(paginated(rows, page, limit, offset + rows.length));
  });
}
