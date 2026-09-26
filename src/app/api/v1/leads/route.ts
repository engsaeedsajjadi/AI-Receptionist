import { and, desc, eq, gte, ilike, sql } from "drizzle-orm";
import { NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/db";
import { leads } from "@/db/schema";
import { ApiError, ok, paginated, parseJsonWith, parsePagination } from "@/lib/api";
import { assertUserInBusiness, getAuthContext } from "@/lib/auth";
import { hasRole } from "@/lib/permissions";
import { findOrCreateCustomer } from "@/lib/services/customers";
import { normalizePersianText } from "@/lib/normalization";
import { createOrUpdateLead, normalizeLeadExtraction } from "@/lib/services/leads";
import { notifyNewLead } from "@/lib/services/notifications";
import { emitAutomationEvent } from "@/lib/services/n8n";
import { checkGlobalPublicRateLimit, withApiHandling } from "@/lib/server-core";

export async function GET(req: NextRequest) {
  return withApiHandling(async () => {
    await checkGlobalPublicRateLimit(req);
    const auth = await getAuthContext(req);
    const { page, limit, offset } = parsePagination(req);

    const status = req.nextUrl.searchParams.get("status");
    const source = req.nextUrl.searchParams.get("source");
    const assignedUser = req.nextUrl.searchParams.get("assigned_user");
    const type = req.nextUrl.searchParams.get("type");
    const score = req.nextUrl.searchParams.get("score");
    const location = req.nextUrl.searchParams.get("location");

    const conditions = [eq(leads.businessId, auth.businessId)];
    if (status) conditions.push(eq(leads.status, status as never));
    if (source) conditions.push(eq(leads.source, source));
    if (assignedUser) conditions.push(eq(leads.assignedUserId, assignedUser));
    if (type) conditions.push(eq(leads.type, type as never));
    if (score) conditions.push(gte(leads.score, Number(score)));
    if (location) conditions.push(ilike(leads.location, `%${normalizePersianText(location)}%`));

    const [rows, total] = await Promise.all([
      db.select().from(leads).where(and(...conditions)).orderBy(desc(leads.createdAt)).limit(limit).offset(offset),
      db.select({ count: sql<number>`count(*)::int` }).from(leads).where(and(...conditions)).then((r) => r[0]?.count ?? 0),
    ]);

    return ok(paginated(rows, page, limit, total));
  });
}

const createSchema = z.object({
  customerName: z.string().max(255).optional(),
  phone: z.string().min(5).max(30),
  email: z.string().email().max(255).optional(),
  source: z.string().max(50).optional(),
  type: z.enum(["BUY", "RENT", "SELL", "OTHER"]).optional(),
  status: z
    .enum(["NEW", "CONTACTED", "QUALIFIED", "VISIT_REQUESTED", "VISIT_SCHEDULED", "NEGOTIATION", "WON", "LOST"])
    .optional(),
  score: z.number().int().min(0).max(100).optional(),
  budgetMin: z.union([z.string(), z.number()]).optional(),
  budgetMax: z.union([z.string(), z.number()]).optional(),
  location: z.string().max(500).optional(),
  minArea: z.union([z.string(), z.number()]).optional(),
  maxArea: z.union([z.string(), z.number()]).optional(),
  bedrooms: z.number().int().min(0).max(50).optional(),
  timeframe: z.string().max(50).optional(),
  requestedVisit: z.boolean().optional(),
  summary: z.string().max(2000).optional(),
  notes: z.string().max(5000).optional(),
  assignedUserId: z.string().uuid().optional(),
});

export async function POST(req: NextRequest) {
  return withApiHandling(async (rid) => {
    await checkGlobalPublicRateLimit(req);
    const auth = await getAuthContext(req);
    const body = await parseJsonWith(req, createSchema);
    if (body.assignedUserId) {
      // Assignment is a MANAGER+ decision (same rule as the assign route);
      // AGENTs create unassigned leads instead of bypassing it here.
      if (!hasRole(auth.role, "MANAGER")) {
        throw new ApiError(403, "FORBIDDEN", "Only MANAGER can assign leads");
      }
      await assertUserInBusiness(auth.businessId, body.assignedUserId);
    }

    const extraction = normalizeLeadExtraction({
      name: body.customerName,
      phone: body.phone,
      intent: body.type ?? "OTHER",
      location: body.location,
      budgetMin: body.budgetMin,
      budgetMax: body.budgetMax,
      minArea: body.minArea,
      maxArea: body.maxArea,
      bedrooms: body.bedrooms,
      timeframe: body.timeframe,
      requestedVisit: body.requestedVisit ?? false,
      summary: body.summary,
    });

    const customer = await findOrCreateCustomer({
      businessId: auth.businessId,
      phone: body.phone,
      name: body.customerName,
      email: body.email,
    });

    const { lead, outcome } = await createOrUpdateLead({
      businessId: auth.businessId,
      customerId: customer.id,
      extraction,
      source: body.source ?? "manual",
    });

    // Manual-only fields applied on top of the dedup policy.
    const manualPatch: Record<string, unknown> = { updatedAt: new Date() };
    if (body.status) manualPatch.status = body.status;
    if (body.score != null) manualPatch.score = body.score;
    if (body.notes) manualPatch.notes = normalizePersianText(body.notes);
    if (body.assignedUserId) manualPatch.assignedUserId = body.assignedUserId;
    let finalLead = lead;
    if (Object.keys(manualPatch).length > 1) {
      const [updated] = await db.update(leads).set(manualPatch).where(eq(leads.id, lead.id)).returning();
      if (updated) finalLead = updated;
    }

    if (outcome === "created" || outcome === "existing_customer_new_lead" || outcome === "reopened") {
      await notifyNewLead({
        businessId: auth.businessId,
        leadId: finalLead.id,
        customerPhone: customer.phone,
        assignedUserId: finalLead.assignedUserId,
        requestId: rid,
      });
      await emitAutomationEvent(
        "new-lead",
        {
          id: finalLead.id,
          businessId: auth.businessId,
          leadId: finalLead.id,
          customerId: customer.id,
          phone: customer.phone,
          status: finalLead.status,
          outcome,
        },
        { idempotencyKey: `new-lead:${finalLead.id}:${outcome}` },
      );
    }

    return ok({ ...finalLead, outcome }, 201);
  });
}
