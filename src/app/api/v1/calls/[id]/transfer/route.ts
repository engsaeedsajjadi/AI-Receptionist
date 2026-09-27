import { NextRequest } from "next/server";
import { z } from "zod";
import { ApiError, ok, parseJsonWith } from "@/lib/api";
import { getAuthContext } from "@/lib/auth";
import { checkGlobalPublicRateLimit, withApiHandling } from "@/lib/server-core";
import { getTransferConfig, requestTransfer } from "@/lib/services/calls";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: NextRequest, ctx: Ctx) {
  return withApiHandling(async () => {
    await checkGlobalPublicRateLimit(req);
    const auth = await getAuthContext(req);
    const { id } = await ctx.params;
    if (!z.string().uuid().safeParse(id).success) throw new ApiError(400, "BAD_REQUEST", "Invalid call id");
    // Expose transfer readiness (destination masked by normalization rules downstream).
    const config = await getTransferConfig(auth.businessId);
    return ok({ configured: Boolean(config.transferNumber), timeoutSeconds: config.timeoutSeconds });
  });
}

const transferSchema = z.object({
  destination: z.string().max(30).optional(),
  reason: z.string().max(500).optional(),
});

/** Manual human-handoff trigger from the dashboard (same audited flow as the AI tool). */
export async function POST(req: NextRequest, ctx: Ctx) {
  return withApiHandling(async (rid) => {
    await checkGlobalPublicRateLimit(req);
    const auth = await getAuthContext(req);
    const { id } = await ctx.params;
    const body = await parseJsonWith(req, transferSchema);
    const result = await requestTransfer(auth.businessId, id, {
      destination: body.destination,
      reason: body.reason ?? `manual transfer by ${auth.userId}`,
      requestId: rid,
    });
    return ok(result, result.status === "TRANSFERRED" ? 200 : 502);
  });
}
