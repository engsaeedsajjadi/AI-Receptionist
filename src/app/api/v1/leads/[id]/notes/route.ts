import { and, desc, eq } from "drizzle-orm";
import { NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/db";
import { leadNotes, leads } from "@/db/schema";
import { ApiError, ok, parseJsonWith } from "@/lib/api";
import { getAuthContext } from "@/lib/auth";
import { normalizePersianText } from "@/lib/normalization";
import { checkGlobalPublicRateLimit, withApiHandling } from "@/lib/server-core";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: NextRequest, ctx: Ctx) {
  return withApiHandling(async () => {
    await checkGlobalPublicRateLimit(req);
    const auth = await getAuthContext(req);
    const { id } = await ctx.params;

    const [lead] = await db
      .select({ id: leads.id })
      .from(leads)
      .where(and(eq(leads.id, id), eq(leads.businessId, auth.businessId)))
      .limit(1);
    if (!lead) throw new ApiError(404, "LEAD_NOT_FOUND", "Lead not found");

    const notes = await db
      .select()
      .from(leadNotes)
      .where(and(eq(leadNotes.leadId, id), eq(leadNotes.businessId, auth.businessId)))
      .orderBy(desc(leadNotes.createdAt))
      .limit(100);
    return ok(notes);
  });
}

const noteSchema = z.object({ note: z.string().min(1).max(5000) });

export async function POST(req: NextRequest, ctx: Ctx) {
  return withApiHandling(async () => {
    await checkGlobalPublicRateLimit(req);
    const auth = await getAuthContext(req);
    const { id } = await ctx.params;
    const body = await parseJsonWith(req, noteSchema);

    const [lead] = await db
      .select()
      .from(leads)
      .where(and(eq(leads.id, id), eq(leads.businessId, auth.businessId)))
      .limit(1);
    if (!lead) throw new ApiError(404, "LEAD_NOT_FOUND", "Lead not found");

    const [created] = await db
      .insert(leadNotes)
      .values({
        businessId: auth.businessId,
        leadId: id,
        userId: auth.userId,
        note: normalizePersianText(body.note),
      })
      .returning();

    return ok(created, 201);
  });
}
