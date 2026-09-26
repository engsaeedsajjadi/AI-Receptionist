import { and, desc, eq, gte, ilike } from "drizzle-orm";
import { NextRequest } from "next/server";
import { db } from "@/db";
import { leads, notifications } from "@/db/schema";
import { ok, parseJson } from "@/lib/api";
import { getAuthContext } from "@/lib/auth";
import { findOrCreateCustomer } from "@/lib/crm";
import { normalizeNumberInput, normalizePersianText } from "@/lib/normalization";
import { checkGlobalPublicRateLimit, withApiHandling } from "@/lib/server-core";

export async function GET(req: NextRequest) {
  return withApiHandling(async () => {
    checkGlobalPublicRateLimit(req);
    const auth = await getAuthContext(req);

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

    const rows = await db
      .select()
      .from(leads)
      .where(and(...conditions))
      .orderBy(desc(leads.createdAt));

    return ok(rows);
  });
}

export async function POST(req: NextRequest) {
  return withApiHandling(async () => {
    checkGlobalPublicRateLimit(req);
    const auth = await getAuthContext(req);

    const body = await parseJson<{
      customerName?: string;
      phone: string;
      email?: string;
      source?: string;
      type?: "BUY" | "RENT" | "SELL" | "OTHER";
      status?:
        | "NEW"
        | "CONTACTED"
        | "QUALIFIED"
        | "VISIT_REQUESTED"
        | "VISIT_SCHEDULED"
        | "NEGOTIATION"
        | "WON"
        | "LOST";
      score?: number;
      budgetMin?: string | number;
      budgetMax?: string | number;
      location?: string;
      minArea?: string | number;
      maxArea?: string | number;
      bedrooms?: number;
      notes?: string;
      assignedUserId?: string;
    }>(req);

    const customer = await findOrCreateCustomer({
      businessId: auth.businessId,
      phone: body.phone,
      name: body.customerName,
      email: body.email,
    });

    const [created] = await db
      .insert(leads)
      .values({
        businessId: auth.businessId,
        customerId: customer.id,
        source: body.source ?? "manual",
        type: body.type ?? "OTHER",
        status: body.status ?? "NEW",
        score: body.score ?? 0,
        budgetMin: normalizeNumberInput(body.budgetMin)?.toString(),
        budgetMax: normalizeNumberInput(body.budgetMax)?.toString(),
        location: body.location ? normalizePersianText(body.location) : null,
        minArea: normalizeNumberInput(body.minArea)?.toString(),
        maxArea: normalizeNumberInput(body.maxArea)?.toString(),
        bedrooms: body.bedrooms ?? null,
        notes: body.notes ? normalizePersianText(body.notes) : null,
        assignedUserId: body.assignedUserId ?? null,
      })
      .returning();

    await db.insert(notifications).values({
      businessId: auth.businessId,
      userId: body.assignedUserId ?? null,
      type: "lead_created",
      title: "سرنخ جدید",
      message: `سرنخ با شماره ${customer.phone} ایجاد شد`,
    });

    return ok(created, 201);
  });
}
