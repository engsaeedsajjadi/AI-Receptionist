import { afterAll, beforeAll, describe, expect } from "vitest";
import { closeDb } from "@/db";
import { ensureDbReady, hasTestDatabase, itDb, truncateAll } from "../helpers/db";
import {
  createBusiness,
  createCall,
  createCustomer,
  createKnowledgeDoc,
  createLead,
  createProperty,
  createUser,
} from "../helpers/fixtures";

const runIntegration = hasTestDatabase();

describe.skipIf(!runIntegration)("tenant isolation (real database)", () => {
  let businessA: { id: string };
  let businessB: { id: string };

  beforeAll(async () => {
    if (!(await ensureDbReady())) return;
    await truncateAll();
    businessA = await createBusiness("Business A");
    businessB = await createBusiness("Business B");

    // Seed tenant A
    const customerA = await createCustomer(businessA.id, "09111111111");
    await createLead(businessA.id, customerA.id);
    await createProperty(businessA.id, { code: "PROP-A-1" });
    await createKnowledgeDoc(businessA.id);
    await createCall(businessA.id, "09111111111");
    await createUser(businessA.id);

    // Seed tenant B
    const customerB = await createCustomer(businessB.id, "09222222222");
    await createLead(businessB.id, customerB.id);
    await createProperty(businessB.id, { code: "PROP-B-1" });
    await createKnowledgeDoc(businessB.id);
    await createCall(businessB.id, "09222222222");
    await createUser(businessB.id);
  });

  afterAll(async () => {
    if (runIntegration) {
      await truncateAll().catch(() => undefined);
      await closeDb();
    }
  });

  itDb("Business B cannot read Business A leads", async () => {
    const { getLead } = await import("@/lib/services/leads");
    const { db } = await import("@/db");
    const { leads } = await import("@/db/schema");
    const { eq } = await import("drizzle-orm");
    const [leadA] = await db.select().from(leads).where(eq(leads.businessId, businessA.id)).limit(1);
    await expect(getLead(businessB.id, leadA.id)).rejects.toMatchObject({ code: "LEAD_NOT_FOUND" });
  });

  itDb("Business B cannot read Business A customers", async () => {
    const { getCustomer } = await import("@/lib/services/customers");
    const { db } = await import("@/db");
    const { customers } = await import("@/db/schema");
    const { eq } = await import("drizzle-orm");
    const [customerA] = await db.select().from(customers).where(eq(customers.businessId, businessA.id)).limit(1);
    await expect(getCustomer(businessB.id, customerA.id)).rejects.toMatchObject({ code: "CUSTOMER_NOT_FOUND" });
  });

  itDb("property search never crosses tenants", async () => {
    const { searchProperties } = await import("@/lib/services/properties");
    const resultsB = await searchProperties(businessB.id, { limit: 50 });
    expect(resultsB.length).toBeGreaterThan(0);
    expect(resultsB.every((p) => p.code !== "PROP-A-1")).toBe(true);
    const resultsA = await searchProperties(businessA.id, { code: "PROP-B-1" });
    expect(resultsA).toEqual([]);
  });

  itDb("Business B cannot read Business A properties by id", async () => {
    const { getProperty } = await import("@/lib/services/properties");
    const { db } = await import("@/db");
    const { properties } = await import("@/db/schema");
    const { eq } = await import("drizzle-orm");
    const [propA] = await db.select().from(properties).where(eq(properties.businessId, businessA.id)).limit(1);
    await expect(getProperty(businessB.id, propA.id)).rejects.toMatchObject({ code: "PROPERTY_NOT_FOUND" });
  });

  itDb("Business B cannot read Business A calls", async () => {
    const { getCall } = await import("@/lib/services/calls");
    const { db } = await import("@/db");
    const { calls } = await import("@/db/schema");
    const { eq } = await import("drizzle-orm");
    const [callA] = await db.select().from(calls).where(eq(calls.businessId, businessA.id)).limit(1);
    await expect(getCall(businessB.id, callA.id)).rejects.toMatchObject({ code: "CALL_NOT_FOUND" });
  });

  itDb("Business B cannot read Business A knowledge documents", async () => {
    const { getDocument } = await import("@/lib/services/knowledge");
    const { db } = await import("@/db");
    const { knowledgeDocuments } = await import("@/db/schema");
    const { eq } = await import("drizzle-orm");
    const [docA] = await db
      .select()
      .from(knowledgeDocuments)
      .where(eq(knowledgeDocuments.businessId, businessA.id))
      .limit(1);
    await expect(getDocument(businessB.id, docA.id)).rejects.toMatchObject({ code: "KNOWLEDGE_NOT_FOUND" });
  });

  itDb("knowledge retrieval never crosses tenants", async () => {
    const { hybridSearch } = await import("@/lib/services/knowledge");
    // Degraded (keyword) mode still enforces tenant filtering.
    const result = await hybridSearch({ businessId: businessB.id, query: "ساعات کاری", topK: 10 });
    for (const chunk of result.chunks) {
      const { db } = await import("@/db");
      const { knowledgeDocuments } = await import("@/db/schema");
      const { eq } = await import("drizzle-orm");
      const [doc] = await db.select().from(knowledgeDocuments).where(eq(knowledgeDocuments.id, chunk.documentId)).limit(1);
      expect(doc.businessId).toBe(businessB.id);
    }
  });

  itDb("same phone number maps to different customers per tenant", async () => {
    const { findOrCreateCustomer } = await import("@/lib/services/customers");
    const a = await findOrCreateCustomer({ businessId: businessA.id, phone: "09333333333" });
    const b = await findOrCreateCustomer({ businessId: businessB.id, phone: "09333333333" });
    expect(a.id).not.toBe(b.id);
    expect(a.businessId).toBe(businessA.id);
    expect(b.businessId).toBe(businessB.id);
  });

  itDb("agent turn rejects a foreign callId before touching history", async () => {
    const { runAgentTurn } = await import("@/lib/services/agent");
    const { db } = await import("@/db");
    const { calls, callMessages } = await import("@/db/schema");
    const { eq } = await import("drizzle-orm");
    const [callA] = await db.select().from(calls).where(eq(calls.businessId, businessA.id)).limit(1);
    await expect(
      runAgentTurn({
        businessId: businessB.id,
        callId: callA.id,
        userMessage: "سلام",
        requestId: "h1-test",
      }),
    ).rejects.toMatchObject({ code: "CALL_NOT_FOUND" });
    // Nothing was read into a prompt and nothing was written.
    const rows = await db.select().from(callMessages).where(eq(callMessages.callId, callA.id));
    expect(rows).toHaveLength(0);
  });

  itDb("appointments cannot link another tenant's lead/customer/user", async () => {
    const { createAppointment } = await import("@/lib/services/appointments");
    const { db } = await import("@/db");
    const { leads, customers, users } = await import("@/db/schema");
    const { eq } = await import("drizzle-orm");
    const [leadA] = await db.select().from(leads).where(eq(leads.businessId, businessA.id)).limit(1);
    const [customerA] = await db
      .select()
      .from(customers)
      .where(eq(customers.businessId, businessA.id))
      .limit(1);
    const [userA] = await db.select().from(users).where(eq(users.businessId, businessA.id)).limit(1);
    const future = new Date(Date.now() + 7 * 86400_000).toISOString();
    await expect(
      createAppointment(businessB.id, { scheduledAt: future, leadId: leadA.id }),
    ).rejects.toMatchObject({ code: "LEAD_NOT_FOUND" });
    await expect(
      createAppointment(businessB.id, { scheduledAt: future, customerId: customerA.id }),
    ).rejects.toMatchObject({ code: "CUSTOMER_NOT_FOUND" });
    await expect(
      createAppointment(businessB.id, { scheduledAt: future, assignedUserId: userA.id }),
    ).rejects.toMatchObject({ code: "USER_NOT_FOUND" });
  });

  itDb("send_notification tool rejects a foreign userId", async () => {
    const { executeToolCall } = await import("@/lib/tools/registry");
    const { db } = await import("@/db");
    const { users } = await import("@/db/schema");
    const { eq } = await import("drizzle-orm");
    const [userA] = await db.select().from(users).where(eq(users.businessId, businessA.id)).limit(1);
    const result = await executeToolCall({
      businessId: businessB.id,
      tool: "send_notification",
      args: { title: "Follow up", message: "Call the customer back", userId: userA.id },
      requestId: "h10-test",
      actor: "test",
    });
    expect(result.status).toBe("NOT_FOUND");
  });

  itDb("same phone reuses the customer within a tenant (dedup)", async () => {
    const { findOrCreateCustomer } = await import("@/lib/services/customers");
    const first = await findOrCreateCustomer({ businessId: businessA.id, phone: "09111111111" });
    const second = await findOrCreateCustomer({ businessId: businessA.id, phone: "+989111111111" });
    expect(first.id).toBe(second.id);
  });
});
