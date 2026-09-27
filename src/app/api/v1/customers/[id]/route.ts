import { NextRequest } from "next/server";
import { z } from "zod";
import { ApiError, ok, parseJsonWith } from "@/lib/api";
import { getAuthContext } from "@/lib/auth";
import { checkGlobalPublicRateLimit, withApiHandling } from "@/lib/server-core";
import { getCustomer, updateCustomer } from "@/lib/services/customers";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: NextRequest, ctx: Ctx) {
  return withApiHandling(async () => {
    await checkGlobalPublicRateLimit(req);
    const auth = await getAuthContext(req);
    const { id } = await ctx.params;
    if (!z.string().uuid().safeParse(id).success) throw new ApiError(400, "BAD_REQUEST", "Invalid customer id");
    return ok(await getCustomer(auth.businessId, id));
  });
}

const updateSchema = z.object({
  name: z.string().max(255).optional(),
  email: z.string().email().max(255).nullable().optional(),
});

export async function PUT(req: NextRequest, ctx: Ctx) {
  return withApiHandling(async () => {
    await checkGlobalPublicRateLimit(req);
    const auth = await getAuthContext(req);
    const { id } = await ctx.params;
    const body = await parseJsonWith(req, updateSchema);
    return ok(await updateCustomer(auth.businessId, id, body));
  });
}
