import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { closeDb, db } from "@/db";
import { businesses } from "@/db/schema";
import { createAppointment, localSlotTime } from "@/lib/services/appointments";
import { executeToolCall } from "@/lib/tools/registry";
import { createBusiness, createCustomer, createLead } from "../helpers/fixtures";
import { ensureDbReady, hasTestDatabase, itDb, truncateAll } from "../helpers/db";

/**
 * check_availability speaks local wall-clock time and answers "is HH:MM free?"
 * directly. A live voice model said "11:00 is free" from a list of UTC slots
 * and then failed to book: the model must never convert time zones itself.
 */
const OPEN_DAYS = Object.fromEntries(Array.from({ length: 7 }, (_, d) => [String(d), { enabled: true, start: "09:00", end: "18:00" }]));

function daysAhead(n: number): string {
  const date = new Date();
  date.setUTCHours(12, 0, 0, 0);
  date.setUTCDate(date.getUTCDate() + n);
  return date.toISOString().slice(0, 10);
}

async function setup() {
  const business = await createBusiness();
  await db.update(businesses).set({
    timezone: "Asia/Tehran",
    settings: { scheduling: { slotMinutes: 30, days: OPEN_DAYS, holidays: [] } },
  }).where(eq(businesses.id, business.id));
  return business;
}

async function check(businessId: string, args: Record<string, unknown>) {
  return executeToolCall({ businessId, tool: "check_availability", args, requestId: "avail", actor: "test" });
}

describe("localSlotTime", () => {
  it("renders Tehran wall-clock time with its offset", () => {
    expect(localSlotTime("2026-12-01T07:30:00.000Z", "Asia/Tehran")).toEqual({ time: "11:00", scheduledAt: "2026-12-01T11:00:00+03:30" });
    expect(localSlotTime("2026-12-01T11:00:00.000Z", "UTC")).toEqual({ time: "11:00", scheduledAt: "2026-12-01T11:00:00+00:00" });
    expect(localSlotTime("2026-12-01T15:00:00.000Z", "America/New_York").scheduledAt).toBe("2026-12-01T10:00:00-05:00");
  });
});

describe.skipIf(!hasTestDatabase())("check_availability in local time", () => {
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

  itDb("lists free slots as local HH:MM with a bookable scheduledAt", async () => {
    const business = await setup();
    const date = daysAhead(3);
    const result = await check(business.id, { date });
    expect(result.status).toBe("SUCCESS");
    const slots = (result.data as { slots: Array<{ time: string; scheduledAt: string }> }).slots;
    expect(slots[0]).toEqual({ time: "09:00", scheduledAt: `${date}T09:00:00+03:30` });
  });

  itDb("answers an exact time and books it with the returned scheduledAt", async () => {
    const business = await setup();
    const lead = await createLead(business.id, (await createCustomer(business.id)).id);
    const date = daysAhead(3);
    const free = await check(business.id, { date, time: "11:00" });
    expect(free.data).toMatchObject({ requestedTime: "11:00", requestedTimeAvailable: true, scheduledAt: `${date}T11:00:00+03:30` });
    const booked = await executeToolCall({
      businessId: business.id,
      tool: "create_appointment",
      args: { scheduledAt: (free.data as { scheduledAt: string }).scheduledAt, leadId: lead.id },
      requestId: "book",
      actor: "test",
    });
    expect(booked.status).toBe("SUCCESS");

    const taken = await check(business.id, { date, time: "11:00" });
    expect(taken.status).toBe("SUCCESS");
    expect(taken.data).toMatchObject({ requestedTimeAvailable: false, reason: "already booked" });
    const alternatives = (taken.data as { alternatives: Array<{ time: string }> }).alternatives.map((a) => a.time);
    expect(alternatives).toHaveLength(3);
    expect(alternatives).toContain("10:30");
    expect(alternatives).toContain("11:30");
    expect(alternatives).not.toContain("11:00");
  });

  itDb("says when a time is outside working hours and offers the nearest slots", async () => {
    const business = await setup();
    const date = daysAhead(3);
    const result = await check(business.id, { date, time: "20:00" });
    expect(result.data).toMatchObject({ requestedTimeAvailable: false, reason: "outside working hours" });
    const times = (result.data as { alternatives: Array<{ time: string }> }).alternatives.map((a) => a.time);
    expect(times).toEqual(["16:30", "17:00", "17:30"]);
  });

  itDb("is UNAVAILABLE when the day is fully booked", async () => {
    const business = await setup();
    const lead = await createLead(business.id, (await createCustomer(business.id)).id);
    const date = daysAhead(4);
    await createAppointment(business.id, { scheduledAt: `${date}T09:00:00+03:30`, durationMinutes: 480, leadId: lead.id });
    await createAppointment(business.id, { scheduledAt: `${date}T17:00:00+03:30`, durationMinutes: 60, leadId: lead.id });
    const result = await check(business.id, { date, time: "11:00" });
    expect(result.status).toBe("UNAVAILABLE");
  });

  itDb("rejects a malformed time", async () => {
    const business = await setup();
    expect((await check(business.id, { date: daysAhead(3), time: "25:00" })).status).toBe("FAILED");
    expect((await check(business.id, { date: daysAhead(3), time: "11" })).status).toBe("FAILED");
  });
});
