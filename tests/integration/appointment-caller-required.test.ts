import { afterAll, beforeAll, describe, expect } from "vitest";
import { and, eq } from "drizzle-orm";
import { closeDb, db } from "@/db";
import { appointments, calls, customers } from "@/db/schema";
import { checkAvailability } from "@/lib/services/appointments";
import { executeToolCall } from "@/lib/tools/registry";
import { ensureDbReady, hasTestDatabase, itDb, truncateAll } from "../helpers/db";
import { createAgent, createBusiness, createCall, createCustomer, createLead } from "../helpers/fixtures";

/**
 * A voice assistant must not leave an appointment nobody can be contacted
 * about. Found in a live lab call: the assistant booked «فردا ساعت ۱۰» and
 * only afterwards asked for the caller's name and phone number.
 */
describe.skipIf(!hasTestDatabase)("create_appointment requires an identified caller (real database)", () => {
  let businessId: string;
  let otherBusinessId: string;
  let seq = 0;
  const req = (label: string) => `appt-caller-${label}-${++seq}`;

  async function freeSlot(daysAhead: number): Promise<string> {
    const date = new Date(Date.now() + daysAhead * 24 * 3600 * 1000).toISOString().slice(0, 10);
    const slot = (await checkAvailability({ businessId, date })).slots.find((s) => s.available);
    expect(slot).toBeTruthy();
    return slot!.start;
  }

  async function rowsAt(start: string) {
    return db.select().from(appointments)
      .where(and(eq(appointments.businessId, businessId), eq(appointments.scheduledAt, new Date(start))));
  }

  beforeAll(async () => {
    if (!(await ensureDbReady())) return;
    await truncateAll();
    businessId = (await createBusiness("Caller Required Biz")).id;
    otherBusinessId = (await createBusiness("Other Biz")).id;
    await createAgent(businessId);
  });

  afterAll(async () => {
    await closeDb();
  });

  itDb("refuses an anonymous booking, books nothing and tells the model what to do next", async () => {
    const start = await freeSlot(3);
    const result = await executeToolCall({
      businessId, tool: "create_appointment", args: { scheduledAt: start, durationMinutes: 30 },
      requestId: req("anonymous"), actor: "test",
    });
    expect(result.status).toBe("FAILED");
    expect(result.error).toContain("Nothing was booked");
    expect(result.error).toContain("create_lead");
    expect(await rowsAt(start)).toHaveLength(0);
  });

  itDb("books for a lead returned by create_lead and links the appointment to it", async () => {
    const start = await freeSlot(4);
    const lead = await executeToolCall({
      businessId, tool: "create_lead", args: { name: "سارا محمدی", phone: "09121112233", type: "BUY" },
      requestId: req("lead"), actor: "test",
    });
    expect(lead.status).toBe("SUCCESS");
    const { leadId } = lead.data as { leadId: string };

    const booked = await executeToolCall({
      businessId, tool: "create_appointment", args: { scheduledAt: start, durationMinutes: 30, leadId },
      requestId: req("with-lead"), actor: "test",
    });
    expect(booked.status).toBe("SUCCESS");
    const rows = await rowsAt(start);
    expect(rows).toHaveLength(1);
    expect(rows[0].leadId).toBe(leadId);
  });

  itDb("uses the caller already linked to the call when the model passes no ids", async () => {
    const start = await freeSlot(5);
    const customer = await createCustomer(businessId, "09123334455");
    const lead = await createLead(businessId, customer.id);
    const call = await createCall(businessId, "09123334455");
    await db.update(calls).set({ customerId: customer.id, leadId: lead.id }).where(eq(calls.id, call.id));

    const booked = await executeToolCall({
      businessId, callId: call.id, tool: "create_appointment", args: { scheduledAt: start, durationMinutes: 30 },
      requestId: req("from-call"), actor: "test",
    });
    expect(booked.status).toBe("SUCCESS");
    const rows = await rowsAt(start);
    expect(rows).toHaveLength(1);
    expect(rows[0].customerId).toBe(customer.id);
    expect(rows[0].leadId).toBe(lead.id);
  });

  itDb("identifies the caller from the number they are calling from", async () => {
    const start = await freeSlot(6);
    const call = await createCall(businessId, "09125556677");
    const booked = await executeToolCall({
      businessId, callId: call.id, tool: "create_appointment", args: { scheduledAt: start, durationMinutes: 30 },
      requestId: req("caller-id"), actor: "test",
    });
    expect(booked.status).toBe("SUCCESS");
    const rows = await rowsAt(start);
    expect(rows).toHaveLength(1);
    const [customer] = await db.select().from(customers).where(eq(customers.id, rows[0].customerId!));
    expect(customer.phone).toBe("09125556677");
    expect(customer.businessId).toBe(businessId);
  });

  itDb("refuses a withheld caller ID and never borrows a caller from another tenant's call", async () => {
    const start = await freeSlot(7);
    const withheld = await createCall(businessId, "anonymous");
    const first = await executeToolCall({
      businessId, callId: withheld.id, tool: "create_appointment", args: { scheduledAt: start, durationMinutes: 30 },
      requestId: req("withheld"), actor: "test",
    });
    expect(first.status).toBe("FAILED");

    const foreignCustomer = await createCustomer(otherBusinessId, "09127778899");
    const foreignCall = await createCall(otherBusinessId, "09127778899");
    await db.update(calls).set({ customerId: foreignCustomer.id }).where(eq(calls.id, foreignCall.id));
    const second = await executeToolCall({
      businessId, callId: foreignCall.id, tool: "create_appointment", args: { scheduledAt: start, durationMinutes: 30 },
      requestId: req("foreign-call"), actor: "test",
    });
    expect(second.status).toBe("FAILED");
    expect(await rowsAt(start)).toHaveLength(0);
  });
});
