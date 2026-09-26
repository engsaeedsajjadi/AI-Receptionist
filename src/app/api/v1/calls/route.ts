import { and, desc, eq, gte, ilike, lte } from "drizzle-orm";
import { NextRequest } from "next/server";
import { db } from "@/db";
import { calls } from "@/db/schema";
import { ok } from "@/lib/api";
import { getAuthContext } from "@/lib/auth";
import { normalizePersianText } from "@/lib/normalization";
import { checkGlobalPublicRateLimit, withApiHandling } from "@/lib/server-core";

export async function GET(req: NextRequest) {
  return withApiHandling(async () => {
    checkGlobalPublicRateLimit(req);
    const auth = await getAuthContext(req);

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

    const rows = await db
      .select()
      .from(calls)
      .where(and(...conditions))
      .orderBy(desc(calls.createdAt));

    return ok(rows);
  });
}
