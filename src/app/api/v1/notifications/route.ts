import { and, desc, eq, sql } from "drizzle-orm";
import { NextRequest } from "next/server";
import { db } from "@/db";
import { notifications } from "@/db/schema";
import { ok } from "@/lib/api";
import { getAuthContext } from "@/lib/auth";
import { checkGlobalPublicRateLimit, withApiHandling } from "@/lib/server-core";
import { cursorPage, keysetCondition, parseListWindow } from "@/lib/pagination";

export async function GET(req: NextRequest) {
  return withApiHandling(async () => {
    await checkGlobalPublicRateLimit(req);
    const auth = await getAuthContext(req);
    const listWindow = parseListWindow(req);

    const conditions = [eq(notifications.businessId, auth.businessId)];
    const status = req.nextUrl.searchParams.get("status");
    const type = req.nextUrl.searchParams.get("type");
    if (status) conditions.push(eq(notifications.status, status as "PENDING" | "SENT" | "FAILED"));
    if (type) conditions.push(eq(notifications.type, type));

    if (listWindow.cursor) {
      conditions.push(keysetCondition({ createdAt: notifications.createdAt, id: notifications.id }, listWindow.cursor));
    }

    const [rows, total] = await Promise.all([
      db
        .select()
        .from(notifications)
        .where(and(...conditions))
        .orderBy(desc(notifications.createdAt), desc(notifications.id))
        .limit(listWindow.cursor ? listWindow.limit + 1 : listWindow.limit)
        .offset(listWindow.cursor ? 0 : listWindow.offset),
      db
        .select({ count: sql<number>`count(*)::int` })
        .from(notifications)
        .where(and(...conditions))
        .then((r) => r[0]?.count ?? 0),
    ]);

    return ok(cursorPage({ rows, limit: listWindow.limit, page: listWindow.page, extra: Boolean(listWindow.cursor), total }));
  });
}
