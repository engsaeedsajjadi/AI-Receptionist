import { and, desc, eq, gte, ilike, lte, sql } from "drizzle-orm";
import { NextRequest } from "next/server";
import { db } from "@/db";
import { calls } from "@/db/schema";
import { ok } from "@/lib/api";
import { getAuthContext } from "@/lib/auth";
import { normalizePersianText } from "@/lib/normalization";
import { checkGlobalPublicRateLimit, withApiHandling } from "@/lib/server-core";
import { cursorPage, keysetCondition, keysetOrder, parseListWindow } from "@/lib/pagination";

export async function GET(req: NextRequest) {
  return withApiHandling(async () => {
    await checkGlobalPublicRateLimit(req);
    const auth = await getAuthContext(req);
    const window = parseListWindow(req);

    const status = req.nextUrl.searchParams.get("status");
    const phone = req.nextUrl.searchParams.get("phone");
    const date = req.nextUrl.searchParams.get("date");
    const dateFrom = req.nextUrl.searchParams.get("date_from");
    const dateTo = req.nextUrl.searchParams.get("date_to");

    const conditions = [eq(calls.businessId, auth.businessId)];
    if (status) conditions.push(eq(calls.status, status as never));
    if (phone) conditions.push(ilike(calls.phoneNumber, `%${normalizePersianText(phone)}%`));
    if (date) {
      const from = new Date(date);
      const to = new Date(date);
      to.setDate(to.getDate() + 1);
      conditions.push(gte(calls.createdAt, from));
      conditions.push(lte(calls.createdAt, to));
    }
    if (dateFrom) conditions.push(gte(calls.createdAt, new Date(dateFrom)));
    if (dateTo) conditions.push(lte(calls.createdAt, new Date(dateTo)));

    if (window.cursor) conditions.push(keysetCondition({ createdAt: calls.createdAt, id: calls.id }, window.cursor));

    const [rows, total] = await Promise.all([
      db.select().from(calls).where(and(...conditions))
        .orderBy(...keysetOrder({ createdAt: calls.createdAt, id: calls.id }))
        .limit(window.cursor ? window.limit + 1 : window.limit)
        .offset(window.cursor ? 0 : window.offset),
      db.select({ count: sql<number>`count(*)::int` }).from(calls).where(and(...conditions)).then((r) => r[0]?.count ?? 0),
    ]);

    return ok(cursorPage({ rows, limit: window.limit, page: window.page, extra: Boolean(window.cursor), total }));
  });
}
