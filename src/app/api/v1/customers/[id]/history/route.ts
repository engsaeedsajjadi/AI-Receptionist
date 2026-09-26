import { NextRequest } from "next/server";
import { z } from "zod";
import { ApiError, ok } from "@/lib/api";
import { getAuthContext } from "@/lib/auth";
import { checkGlobalPublicRateLimit, withApiHandling } from "@/lib/server-core";
import { getCustomerHistory } from "@/lib/services/customers";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: NextRequest, ctx: Ctx) {
  return withApiHandling(async () => {
    await checkGlobalPublicRateLimit(req);
    const auth = await getAuthContext(req);
    const { id } = await ctx.params;
    if (!z.string().uuid().safeParse(id).success) throw new ApiError(400, "BAD_REQUEST", "Invalid customer id");
    const limit = Math.min(Number(req.nextUrl.searchParams.get("limit") ?? "20") || 20, 100);
    return ok(await getCustomerHistory(auth.businessId, id, { limit }));
  });
}
