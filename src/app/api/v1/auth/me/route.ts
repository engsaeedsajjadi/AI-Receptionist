import { eq } from "drizzle-orm";
import { NextRequest } from "next/server";
import { db } from "@/db";
import { businesses } from "@/db/schema";
import { ok } from "@/lib/api";
import { getAuthContext } from "@/lib/auth";
import { checkGlobalPublicRateLimit, withApiHandling } from "@/lib/server-core";

export async function GET(req: NextRequest) {
  return withApiHandling(async () => {
    await checkGlobalPublicRateLimit(req);
    const auth = await getAuthContext(req);
    const [business] = await db.select().from(businesses).where(eq(businesses.id, auth.businessId)).limit(1);

    return ok({
      user: {
        id: auth.user.id,
        businessId: auth.user.businessId,
        name: auth.user.name,
        email: auth.user.email,
        role: auth.user.role,
      },
      business,
    });
  });
}
