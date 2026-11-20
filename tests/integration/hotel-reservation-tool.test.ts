import { afterAll, beforeAll, beforeEach, describe, expect } from "vitest";
import { eq } from "drizzle-orm";
import { closeDb, db } from "@/db";
import { customers, leads } from "@/db/schema";
import { executeToolCall } from "@/lib/tools/registry";
import { createBusiness } from "../helpers/fixtures";
import { ensureDbReady, hasTestDatabase, itDb, truncateAll } from "../helpers/db";

/**
 * Hotels: request_reservation records a stay for the front desk to confirm. It
 * never claims a confirmed booking (the app holds no room inventory) and it
 * accepts the foreign phone numbers that Gulf hotel guests have.
 */
function inDays(n: number): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + n);
  return date.toISOString().slice(0, 10);
}

async function request(businessId: string, args: Record<string, unknown>) {
  return executeToolCall({ businessId, tool: "request_reservation", args, requestId: "hotel", actor: "test" });
}

describe.skipIf(!hasTestDatabase())("request_reservation", () => {
  beforeAll(async () => {
    await ensureDbReady();
    await truncateAll();
  });
  afterAll(async () => {
    await truncateAll();
    await closeDb();
  });
  beforeEach(async () => {
    await truncateAll();
  });

  itDb("records an unconfirmed stay as a lead with a foreign guest number", async () => {
    const business = await createBusiness();
    const result = await request(business.id, {
      guestName: "Ahmed Al Mansouri", phone: "+971 50 123 4567",
      checkIn: inDays(10), checkOut: inDays(13), guests: 2, roomType: "Deluxe sea view", notes: "Late arrival",
    });
    expect(result.status).toBe("SUCCESS");
    expect(result.data).toMatchObject({ nights: 3, guests: 2, confirmed: false });
    const [customer] = await db.select().from(customers).where(eq(customers.businessId, business.id));
    expect(customer.phone).toBe("+971501234567");
    const [lead] = await db.select().from(leads).where(eq(leads.businessId, business.id));
    expect(lead.id).toBe((result.data as { requestId: string }).requestId);
    expect(lead.customerId).toBe(customer.id);
    expect(lead.summary ?? "").toContain("Room reservation request");
    expect(lead.summary ?? "").toContain("to be confirmed by the front desk");
  });

  itDb("refuses impossible dates and phone numbers without writing anything", async () => {
    const business = await createBusiness();
    const base = { guestName: "Sara", phone: "+968 9123 4567", guests: 1 };
    expect((await request(business.id, { ...base, checkIn: inDays(5), checkOut: inDays(5) })).status).toBe("FAILED");
    expect((await request(business.id, { ...base, checkIn: inDays(-2), checkOut: inDays(1) })).status).toBe("FAILED");
    expect((await request(business.id, { ...base, phone: "12", checkIn: inDays(3), checkOut: inDays(4) })).status).toBe("FAILED");
    expect((await request(business.id, { ...base, checkIn: "next week", checkOut: inDays(4) })).status).toBe("FAILED");
    expect(await db.select().from(leads).where(eq(leads.businessId, business.id))).toHaveLength(0);
  });
});
