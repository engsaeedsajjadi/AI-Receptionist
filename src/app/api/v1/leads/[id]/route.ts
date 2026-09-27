import { and, eq } from "drizzle-orm";
import { NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/db";
import { leads } from "@/db/schema";
import { ApiError, ok, parseJson } from "@/lib/api";
import { assertUserInBusiness, getAuthContext } from "@/lib/auth";
import { normalizeNumberInput, normalizePersianText } from "@/lib/normalization";
import { hasRole } from "@/lib/permissions";
import { checkGlobalPublicRateLimit, withApiHandling } from "@/lib/server-core";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: NextRequest, ctx: Ctx) {
  return withApiHandling(async () => {
    await checkGlobalPublicRateLimit(req);
    const auth = await getAuthContext(req);
    const { id } = await ctx.params;

    const [row] = await db
      .select()
      .from(leads)
      .where(and(eq(leads.id, id), eq(leads.businessId, auth.businessId)))
      .limit(1);

    if (!row) throw new ApiError(404, "LEAD_NOT_FOUND", "Lead not found");
    return ok(row);
  });
}

export async function PUT(req: NextRequest, ctx: Ctx) {
  return withApiHandling(async () => {
    await checkGlobalPublicRateLimit(req);
    const auth = await getAuthContext(req);
    const { id } = await ctx.params;

    const body = await parseJson<
      Partial<{
        status: "NEW" | "CONTACTED" | "QUALIFIED" | "VISIT_REQUESTED" | "VISIT_SCHEDULED" | "NEGOTIATION" | "WON" | "LOST";
        score: number;
        budgetMin: string | number;
        budgetMax: string | number;
        location: string;
        minArea: string | number;
        maxArea: string | number;
        bedrooms: number;
        notes: string;
        assignedUserId: string;
      }>
    >(req);

    if (body.assignedUserId !== undefined) {
      // Same rule as the assign route: assignment is MANAGER+, and the
      // assignee must exist in this business (garbage UUIDs 400, foreign
      // users 404 — never a 500 from the uuid column).
      if (!hasRole(auth.role, "MANAGER")) {
        throw new ApiError(403, "FORBIDDEN", "Only MANAGER can assign leads");
      }
      const parsed = z.string().uuid().safeParse(body.assignedUserId);
      if (!parsed.success) throw new ApiError(400, "VALIDATION_ERROR", "Invalid assignedUserId");
      await assertUserInBusiness(auth.businessId, parsed.data);
    }

    const [updated] = await db
      .update(leads)
      .set({
        status: body.status,
        score: body.score,
        budgetMin: body.budgetMin != null ? normalizeNumberInput(body.budgetMin)?.toString() : undefined,
        budgetMax: body.budgetMax != null ? normalizeNumberInput(body.budgetMax)?.toString() : undefined,
        location: body.location ? normalizePersianText(body.location) : undefined,
        minArea: body.minArea != null ? normalizeNumberInput(body.minArea)?.toString() : undefined,
        maxArea: body.maxArea != null ? normalizeNumberInput(body.maxArea)?.toString() : undefined,
        bedrooms: body.bedrooms,
        notes: body.notes ? normalizePersianText(body.notes) : undefined,
        assignedUserId: body.assignedUserId,
        updatedAt: new Date(),
      })
      .where(and(eq(leads.id, id), eq(leads.businessId, auth.businessId)))
      .returning();

    if (!updated) throw new ApiError(404, "LEAD_NOT_FOUND", "Lead not found");
    return ok(updated);
  });
}

export async function DELETE(req: NextRequest, ctx: Ctx) {
  return withApiHandling(async () => {
    await checkGlobalPublicRateLimit(req);
    const auth = await getAuthContext(req);
    if (!hasRole(auth.role, "MANAGER")) throw new ApiError(403, "FORBIDDEN", "Insufficient permissions");

    const { id } = await ctx.params;
    const deleted = await db
      .delete(leads)
      .where(and(eq(leads.id, id), eq(leads.businessId, auth.businessId)))
      .returning();

    if (!deleted.length) throw new ApiError(404, "LEAD_NOT_FOUND", "Lead not found");
    return ok({ ok: true });
  });
}
