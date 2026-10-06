import { eq } from "drizzle-orm";
import { NextRequest } from "next/server";
import { db } from "@/db";
import { businesses } from "@/db/schema";
import { ApiError, mapUniqueViolation, ok, parseJson } from "@/lib/api";
import { getAuthContext } from "@/lib/auth";
import { normalizePersianText, normalizePhone } from "@/lib/normalization";
import { hasRole } from "@/lib/permissions";
import { checkGlobalPublicRateLimit, withApiHandling } from "@/lib/server-core";

export async function GET(req: NextRequest) {
  return withApiHandling(async () => {
    await checkGlobalPublicRateLimit(req);
    const auth = await getAuthContext(req);
    const [business] = await db.select().from(businesses).where(eq(businesses.id, auth.businessId)).limit(1);
    return ok(business);
  });
}

export async function PUT(req: NextRequest) {
  return withApiHandling(async () => {
    await checkGlobalPublicRateLimit(req);
    const auth = await getAuthContext(req);
    if (!hasRole(auth.role, "ADMIN")) throw new ApiError(403, "FORBIDDEN", "Insufficient permissions");

    const body = await parseJson<Partial<{ name: string; phone: string; address: string; timezone: string; language: string }>>(req);

    // The number is how inbound calls find this tenant, so it is stored in the
    // canonical national form (`02188776655`) regardless of the dialect the
    // operator typed. An unparseable number would silently never ring.
    let phone: string | undefined;
    if (body.phone !== undefined) {
      const trimmed = String(body.phone).trim();
      if (trimmed === "") {
        phone = undefined;
      } else {
        const normalized = normalizePhone(trimmed);
        if (!normalized) throw new ApiError(400, "VALIDATION_ERROR", "شماره تلفن معتبر نیست.");
        phone = normalized;
      }
    }

    let updated: typeof businesses.$inferSelect;
    try {
      [updated] = await db
        .update(businesses)
        .set({
          name: body.name ? normalizePersianText(body.name) : undefined,
          phone,
          address: body.address ? normalizePersianText(body.address) : undefined,
          timezone: body.timezone,
          language: body.language,
          updatedAt: new Date(),
        })
        .where(eq(businesses.id, auth.businessId))
        .returning();
    } catch (err) {
      // One number, one tenant: a clash is a 409, never a second tenant silently
      // shadowing the first for inbound calls.
      mapUniqueViolation(err, {
        businesses_phone_idx: { code: "PHONE_TAKEN", message: "این شماره تلفن به کسب‌وکار دیگری متصل است." },
      });
    }

    return ok(updated);
  });
}
