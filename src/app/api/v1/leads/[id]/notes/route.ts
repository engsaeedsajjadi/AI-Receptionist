import { and, eq } from "drizzle-orm";
import { NextRequest } from "next/server";
import { db } from "@/db";
import { leads } from "@/db/schema";
import { ApiError, ok, parseJson } from "@/lib/api";
import { getAuthContext } from "@/lib/auth";
import { normalizePersianText } from "@/lib/normalization";
import { checkGlobalPublicRateLimit, withApiHandling } from "@/lib/server-core";

type Ctx = { params: Promise<{ id: string }> };

export async function POST(req: NextRequest, ctx: Ctx) {
  return withApiHandling(async () => {
    checkGlobalPublicRateLimit(req);
    const auth = await getAuthContext(req);
    const { id } = await ctx.params;
    const body = await parseJson<{ note: string }>(req);

    const [lead] = await db
      .select()
      .from(leads)
      .where(and(eq(leads.id, id), eq(leads.businessId, auth.businessId)))
      .limit(1);

    if (!lead) throw new ApiError(404, "LEAD_NOT_FOUND", "Lead not found");

    const appended = normalizePersianText(body.note);
    const notes = lead.notes ? `${lead.notes}\n---\n${appended}` : appended;

    const [updated] = await db
      .update(leads)
      .set({ notes, updatedAt: new Date() })
      .where(eq(leads.id, id))
      .returning();

    return ok(updated);
  });
}
