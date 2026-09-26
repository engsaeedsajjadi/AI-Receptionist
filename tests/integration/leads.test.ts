import { afterAll, beforeAll, describe, expect } from "vitest";
import { closeDb } from "@/db";
import { ensureDbReady, hasTestDatabase, itDb, truncateAll } from "../helpers/db";
import { createBusiness, createCustomer } from "../helpers/fixtures";

const runIntegration = hasTestDatabase();

describe.skipIf(!runIntegration)("lead lifecycle (real database)", () => {
  let businessId: string;

  beforeAll(async () => {
    if (!(await ensureDbReady())) return;
    await truncateAll();
    businessId = (await createBusiness("Lead Biz")).id;
  });

  afterAll(async () => {
    if (runIntegration) {
      await truncateAll().catch(() => undefined);
      await closeDb();
    }
  });

  itDb("creates a lead for a new customer", async () => {
    const { intakeLeadFromCall } = await import("@/lib/services/leads");
    const { normalizeLeadExtraction } = await import("@/lib/services/leads");
    const extraction = normalizeLeadExtraction({
      name: "مشتری تست",
      phone: "09120000001",
      intent: "BUY",
      location: "تهران",
      budgetMax: "پنج میلیارد تومان",
    });
    const { customer, lead, outcome } = await intakeLeadFromCall({
      businessId,
      callerPhone: "09120000001",
      extraction,
    });
    expect(outcome).toBe("created");
    expect(lead.status).toBe("NEW");
    expect(customer.phone).toBe("09120000001");
  });

  itDb("merges repeat calls into the open lead (no duplicates)", async () => {
    const { intakeLeadFromCall, normalizeLeadExtraction } = await import("@/lib/services/leads");
    const extraction = normalizeLeadExtraction({
      phone: "09120000001",
      intent: "BUY",
      bedrooms: "دو خوابه",
    });
    const { lead, outcome } = await intakeLeadFromCall({ businessId, callerPhone: "09120000001", extraction });
    expect(outcome).toBe("updated_open");
    expect(lead.bedrooms).toBe(2);
    // Budget from the first call is preserved (not blanked).
    expect(lead.budgetMax).toBe("5000000000");

    const { db } = await import("@/db");
    const { leads } = await import("@/db/schema");
    const { and, eq } = await import("drizzle-orm");
    const rows = await db
      .select()
      .from(leads)
      .where(and(eq(leads.businessId, businessId)));
    expect(rows).toHaveLength(1);
  });

  itDb("re-opens lost leads instead of duplicating", async () => {
    const { db } = await import("@/db");
    const { leads } = await import("@/db/schema");
    const { and, eq } = await import("drizzle-orm");
    const { intakeLeadFromCall, normalizeLeadExtraction } = await import("@/lib/services/leads");

    await db.update(leads).set({ status: "LOST" }).where(eq(leads.businessId, businessId));
    const { lead, outcome } = await intakeLeadFromCall({
      businessId,
      callerPhone: "09120000001",
      extraction: normalizeLeadExtraction({ phone: "09120000001", intent: "RENT" }),
    });
    expect(outcome).toBe("reopened");
    expect(lead.status).toBe("NEW");
    const rows = await db.select().from(leads).where(and(eq(leads.businessId, businessId)));
    expect(rows).toHaveLength(1);
  });

  itDb("creates a fresh lead after a WON lead", async () => {
    const { db } = await import("@/db");
    const { leads } = await import("@/db/schema");
    const { and, eq } = await import("drizzle-orm");
    const { intakeLeadFromCall, normalizeLeadExtraction } = await import("@/lib/services/leads");

    await db.update(leads).set({ status: "WON" }).where(eq(leads.businessId, businessId));
    const { outcome } = await intakeLeadFromCall({
      businessId,
      callerPhone: "09120000001",
      extraction: normalizeLeadExtraction({ phone: "09120000001", intent: "BUY" }),
    });
    expect(outcome).toBe("existing_customer_new_lead");
    const rows = await db.select().from(leads).where(and(eq(leads.businessId, businessId)));
    expect(rows).toHaveLength(2);
  });

  itDb("stores lead notes under the tenant", async () => {
    const customer = await createCustomer(businessId, "09120000002");
    const { createOrUpdateLead, normalizeLeadExtraction } = await import("@/lib/services/leads");
    const { lead } = await createOrUpdateLead({
      businessId,
      customerId: customer.id,
      extraction: normalizeLeadExtraction({ intent: "OTHER" }),
      source: "manual",
    });
    const { db } = await import("@/db");
    const { leadNotes } = await import("@/db/schema");
    const [note] = await db
      .insert(leadNotes)
      .values({ businessId, leadId: lead.id, note: "یادداشت تست" })
      .returning();
    expect(note.leadId).toBe(lead.id);
  });
});
