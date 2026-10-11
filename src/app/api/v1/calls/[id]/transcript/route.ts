import { and, eq } from "drizzle-orm";
import { NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/db";
import { calls } from "@/db/schema";
import { ApiError, ok } from "@/lib/api";
import { getAuthContext } from "@/lib/auth";
import { checkGlobalPublicRateLimit, withApiHandling } from "@/lib/server-core";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: NextRequest, ctx: Ctx) {
  return withApiHandling(async () => {
    await checkGlobalPublicRateLimit(req);
    const auth = await getAuthContext(req);
    const { id } = await ctx.params;
    // Reject non-UUID ids before they reach Postgres (a cast error would be a
    // 500, which is not an acceptable answer for a malformed request).
    if (!z.string().uuid().safeParse(id).success) throw new ApiError(400, "BAD_REQUEST", "Invalid call id");

    const [row] = await db
      .select({ id: calls.id, transcript: calls.transcript })
      .from(calls)
      .where(and(eq(calls.id, id), eq(calls.businessId, auth.businessId)))
      .limit(1);

    if (!row) throw new ApiError(404, "CALL_NOT_FOUND", "Call not found");
    return ok({ callId: row.id, transcript: row.transcript ?? "" });
  });
}
