import { and, desc, eq, notInArray } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { leads } from "@/db/schema";
import { AppError } from "@/lib/errors";
import { findOrCreateCustomer } from "@/lib/services/customers";
import {
  normalizePersianText,
  normalizePhone,
  parseArea,
  parseBedrooms,
  parsePrice,
} from "@/lib/normalization";

// ---------------------------------------------------------------------------
// Structured lead extraction schema (LLM output is NEVER trusted raw)
// ---------------------------------------------------------------------------

export const LeadExtractionSchema = z.object({
  name: z.string().max(255).optional(),
  phone: z.string().max(30).optional(),
  intent: z.enum(["BUY", "RENT", "SELL", "OTHER"]).default("OTHER"),
  location: z.string().max(500).optional(),
  budgetMin: z.union([z.string(), z.number()]).optional(),
  budgetMax: z.union([z.string(), z.number()]).optional(),
  minArea: z.union([z.string(), z.number()]).optional(),
  maxArea: z.union([z.string(), z.number()]).optional(),
  bedrooms: z.union([z.string(), z.number()]).optional(),
  timeframe: z.string().max(50).optional(),
  requestedVisit: z.boolean().default(false),
  summary: z.string().max(2000).optional(),
});

export type LeadExtraction = z.infer<typeof LeadExtractionSchema>;

export type NormalizedLead = {
  name: string | null;
  phone: string | null;
  intent: "BUY" | "RENT" | "SELL" | "OTHER";
  location: string | null;
  budgetMin: string | null;
  budgetMax: string | null;
  minArea: string | null;
  maxArea: string | null;
  bedrooms: number | null;
  timeframe: string | null;
  requestedVisit: boolean;
  summary: string | null;
};

function toNumericString(value: number | null): string | null {
  if (value == null || !Number.isFinite(value) || value < 0) return null;
  return String(Math.round(value * 100) / 100);
}

/** Validate + normalize raw extraction output (e.g. from the LLM). */
export function normalizeLeadExtraction(raw: unknown): NormalizedLead {
  const parsed = LeadExtractionSchema.safeParse(raw);
  if (!parsed.success) {
    throw new AppError(400, "VALIDATION_ERROR", "Lead extraction failed validation", {
      issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    });
  }
  const e = parsed.data;

  const budgetMin = e.budgetMin != null ? parsePrice(e.budgetMin)?.amountToman ?? null : null;
  const budgetMax = e.budgetMax != null ? parsePrice(e.budgetMax)?.amountToman ?? null : null;
  const minArea = e.minArea != null ? parseArea(e.minArea) : null;
  const maxArea = e.maxArea != null ? parseArea(e.maxArea) : null;

  return {
    name: e.name ? normalizePersianText(e.name) : null,
    phone: e.phone ? normalizePhone(e.phone) : null,
    intent: e.intent,
    location: e.location ? normalizePersianText(e.location) : null,
    budgetMin: toNumericString(budgetMin),
    budgetMax: toNumericString(budgetMax),
    minArea: toNumericString(minArea),
    maxArea: toNumericString(maxArea),
    bedrooms: e.bedrooms != null ? parseBedrooms(e.bedrooms) : null,
    timeframe: e.timeframe ? normalizePersianText(e.timeframe) : null,
    requestedVisit: e.requestedVisit,
    summary: e.summary ? normalizePersianText(e.summary) : null,
  };
}

// ---------------------------------------------------------------------------
// Lead lifecycle + dedup policy
// ---------------------------------------------------------------------------

const OPEN_STATUSES = ["NEW", "CONTACTED", "QUALIFIED", "VISIT_REQUESTED", "VISIT_SCHEDULED", "NEGOTIATION"] as const;
const CLOSED_STATUSES = ["WON", "LOST"] as const;

export type LeadOutcome = "created" | "updated_open" | "reopened" | "existing_customer_new_lead";

export async function findOpenLead(businessId: string, customerId: string) {
  const [row] = await db
    .select()
    .from(leads)
    .where(
      and(
        eq(leads.businessId, businessId),
        eq(leads.customerId, customerId),
        notInArray(leads.status, [...CLOSED_STATUSES] as Array<"WON" | "LOST">),
      ),
    )
    .orderBy(desc(leads.updatedAt))
    .limit(1);
  return row ?? null;
}

/**
 * Lead policy (all inside one transaction):
 * - existing open lead → merge new info into it (updated_open)
 * - last lead LOST and new intent differs/old → re-open as NEW (reopened)
 * - existing customer, no open lead, last lead WON → fresh lead (existing_customer_new_lead)
 * - otherwise → create (created)
 */
export async function createOrUpdateLead(input: {
  businessId: string;
  customerId: string;
  extraction: NormalizedLead;
  source?: string;
  callId?: string;
}): Promise<{ lead: typeof leads.$inferSelect; outcome: LeadOutcome }> {
  return db.transaction(async (tx) => {
    const [latest] = await tx
      .select()
      .from(leads)
      .where(and(eq(leads.businessId, input.businessId), eq(leads.customerId, input.customerId)))
      .orderBy(desc(leads.updatedAt))
      .limit(1);

    const e = input.extraction;
    const patch = {
      type: e.intent,
      budgetMin: e.budgetMin ?? undefined,
      budgetMax: e.budgetMax ?? undefined,
      location: e.location ?? undefined,
      minArea: e.minArea ?? undefined,
      maxArea: e.maxArea ?? undefined,
      bedrooms: e.bedrooms ?? undefined,
      timeframe: e.timeframe ?? undefined,
      requestedVisit: e.requestedVisit || undefined,
      summary: e.summary ?? undefined,
      updatedAt: new Date(),
    } as const;

    if (latest && (OPEN_STATUSES as readonly string[]).includes(latest.status)) {
      const [updated] = await tx
        .update(leads)
        .set({ ...patch, updatedAt: new Date() })
        .where(eq(leads.id, latest.id))
        .returning();
      return { lead: updated, outcome: "updated_open" };
    }

    if (latest && latest.status === "LOST") {
      const [reopened] = await tx
        .update(leads)
        .set({ ...patch, status: "NEW", source: input.source ?? latest.source, updatedAt: new Date() })
        .where(eq(leads.id, latest.id))
        .returning();
      return { lead: reopened, outcome: "reopened" };
    }

    const [created] = await tx
      .insert(leads)
      .values({
        businessId: input.businessId,
        customerId: input.customerId,
        source: input.source ?? "call",
        type: e.intent,
        status: "NEW",
        budgetMin: e.budgetMin,
        budgetMax: e.budgetMax,
        location: e.location,
        minArea: e.minArea,
        maxArea: e.maxArea,
        bedrooms: e.bedrooms,
        timeframe: e.timeframe,
        requestedVisit: e.requestedVisit,
        summary: e.summary,
      })
      .returning();
    return { lead: created, outcome: latest ? "existing_customer_new_lead" : "created" };
  });
}

/**
 * Full call-intake flow: deduplicate customer → apply lead policy.
 * Used by the voice tool-call path and the AI runtime.
 */
export async function intakeLeadFromCall(input: {
  businessId: string;
  callerPhone: string;
  extraction: NormalizedLead;
  callId?: string;
  source?: string;
}) {
  const phone = input.extraction.phone ?? normalizePhone(input.callerPhone);
  if (!phone) throw new AppError(400, "VALIDATION_ERROR", "A valid caller phone number is required");

  const customer = await findOrCreateCustomer({
    businessId: input.businessId,
    phone,
    name: input.extraction.name ?? undefined,
  });
  const { lead, outcome } = await createOrUpdateLead({
    businessId: input.businessId,
    customerId: customer.id,
    extraction: input.extraction,
    source: input.source ?? "call",
    callId: input.callId,
  });
  return { customer, lead, outcome };
}

export async function getLead(businessId: string, leadId: string) {
  const [row] = await db
    .select()
    .from(leads)
    .where(and(eq(leads.id, leadId), eq(leads.businessId, businessId)))
    .limit(1);
  if (!row) throw new AppError(404, "LEAD_NOT_FOUND", "Lead not found");
  return row;
}
