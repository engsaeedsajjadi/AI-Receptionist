import { and, eq, gte, ilike, lte } from "drizzle-orm";
import { NextRequest } from "next/server";
import { db } from "@/db";
import { properties } from "@/db/schema";
import { ok, parseJson } from "@/lib/api";
import { getAuthContext } from "@/lib/auth";
import { normalizeNumberInput, normalizePersianText } from "@/lib/normalization";
import { checkGlobalPublicRateLimit, withApiHandling } from "@/lib/server-core";

export async function POST(req: NextRequest) {
  return withApiHandling(async () => {
    checkGlobalPublicRateLimit(req);
    const auth = await getAuthContext(req);

    const body = await parseJson<{
      transaction_type?: string;
      location?: string;
      max_price?: number | string;
      min_area?: number | string;
      bedrooms?: number;
    }>(req);

    const maxPrice = normalizeNumberInput(body.max_price);
    const minArea = normalizeNumberInput(body.min_area);

    const conditions = [eq(properties.businessId, auth.businessId), eq(properties.isAvailable, true)];
    if (body.transaction_type) conditions.push(eq(properties.transactionType, body.transaction_type));
    if (body.location) conditions.push(ilike(properties.location, `%${normalizePersianText(body.location)}%`));
    if (maxPrice != null) conditions.push(lte(properties.price, maxPrice.toString()));
    if (minArea != null) conditions.push(gte(properties.area, minArea.toString()));
    if (body.bedrooms != null) conditions.push(gte(properties.bedrooms, body.bedrooms));

    const rows = await db.select().from(properties).where(and(...conditions)).limit(20);

    return ok({
      properties: rows.map((p) => ({
        id: p.id,
        area: p.area,
        price: p.price,
        bedrooms: p.bedrooms,
        location: p.location,
        title: p.title,
      })),
    });
  });
}
