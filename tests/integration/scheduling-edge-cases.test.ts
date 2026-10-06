import { afterAll, beforeAll, beforeEach, describe, expect } from "vitest";
import { eq } from "drizzle-orm";
import { closeDb, db } from "@/db";
import { appointments, businesses, outboxEvents } from "@/db/schema";
import {
  cancelAppointment,
  checkAvailability,
  createAppointment,
  getAppointment,
  getSchedulingConfig,
  rescheduleAppointment,
  updateSchedulingConfig,
} from "@/lib/services/appointments";
import { createBusiness, createCustomer, createLead, createUser } from "../helpers/fixtures";
import { ensureDbReady, hasTestDatabase, itDb, truncateAll } from "../helpers/db";

const CLOSED_DAYS = Object.fromEntries(Array.from({ length: 7 }, (_, d) => [String(d), { enabled: false, start: "09:00", end: "18:00" }]));

/** Next occurrence of a given weekday (0=Sunday..6=Saturday) at least `daysAhead` out. */
function nextWeekday(target: number, daysAhead = 2): string {
  const date = new Date();
  date.setUTCHours(12, 0, 0, 0);
  date.setUTCDate(date.getUTCDate() + daysAhead);
  while (date.getUTCDay() !== target) date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

async function configure(businessId: string, settings: unknown) {
  const [row] = await db.select().from(businesses).where(eq(businesses.id, businessId));
  await db
    .update(businesses)
    .set({ settings: { ...((row.settings as Record<string, unknown>) ?? {}), scheduling: settings }, updatedAt: new Date() })
    .where(eq(businesses.id, businessId));
}

describe.skipIf(!hasTestDatabase())("scheduling edge cases", () => {
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

  itDb("falls back to the default schedule for malformed settings instead of crashing", async () => {
    const business = await createBusiness();
    expect(await getSchedulingConfig(business.id)).toMatchObject({ timezone: "Asia/Tehran" });
    await configure(business.id, { slotMinutes: 5, days: "not-a-record" });
    const fallback = await getSchedulingConfig(business.id);
    expect(fallback.config.slotMinutes).toBe(30);
    expect(Object.keys(fallback.config.days)).toHaveLength(7);

    await configure(business.id, { slotMinutes: 15, days: { "0": { enabled: false, start: "08:00", end: "12:00" } }, holidays: [] });
    const partial = await getSchedulingConfig(business.id);
    expect(partial.config.slotMinutes).toBe(15);
    expect(partial.config.days["0"].enabled).toBe(false);
    // Unspecified weekdays inherit the documented default.
    expect(partial.config.days["1"]).toEqual({ enabled: true, start: "09:00", end: "18:00" });
    await expect(getSchedulingConfig("")).rejects.toThrow();
  });

  itDb("accepts a validated schedule update and rejects an inverted window", async () => {
    const business = await createBusiness();
    const saved = await updateSchedulingConfig(business.id, { slotMinutes: 45, days: { "1": { enabled: true, start: "10:00", end: "14:00" } }, holidays: ["2026-12-25"] });
    expect(saved.slotMinutes).toBe(45);
    expect(saved.days["1"]).toMatchObject({ start: "10:00", end: "14:00" });
    expect((await getSchedulingConfig(business.id)).config.holidays).toContain("2026-12-25");
    await expect(updateSchedulingConfig(business.id, { slotMinutes: 5 })).rejects.toThrow(/Validation/);
    await expect(updateSchedulingConfig(business.id, { days: { "1": { enabled: true, start: "18:00", end: "09:00" } } })).rejects.toThrow(/Validation/);
    await expect(updateSchedulingConfig(business.id, { days: { "1": { enabled: true, start: "9:00", end: "18:00" } } })).rejects.toThrow(/Validation/);
    // A disabled day may keep a window that would be invalid when open.
    await expect(updateSchedulingConfig(business.id, { days: { "1": { enabled: false, start: "18:00", end: "09:00" } } })).resolves.toBeTruthy();
    await expect(updateSchedulingConfig("", {})).rejects.toThrow();
  });

  itDb("returns an empty slot list for holidays, closed days and malformed dates", async () => {
    const business = await createBusiness();
    const holiday = nextWeekday(6);
    await configure(business.id, { slotMinutes: 30, days: Object.fromEntries(Array.from({ length: 7 }, (_, d) => [String(d), { enabled: true, start: "09:00", end: "18:00" }])), holidays: [holiday] });
    expect((await checkAvailability({ businessId: business.id, date: holiday })).slots).toEqual([]);
    await expect(checkAvailability({ businessId: business.id, date: "1404/01/01" })).rejects.toThrow(/YYYY-MM-DD/);
    await expect(checkAvailability({ businessId: business.id, date: "2026-13-45" })).rejects.toThrow();
    await expect(checkAvailability({ businessId: business.id, date: "" })).rejects.toThrow();

    await configure(business.id, { slotMinutes: 30, days: CLOSED_DAYS, holidays: [] });
    const closedDay = nextWeekday(1);
    expect((await checkAvailability({ businessId: business.id, date: closedDay })).slots).toEqual([]);
  });

  itDb("never offers a slot that overlaps an existing appointment, and offers it again once freed", async () => {
    const business = await createBusiness();
    const openDay = nextWeekday(2);
    await configure(business.id, {
      slotMinutes: 30,
      days: Object.fromEntries(Array.from({ length: 7 }, (_, d) => [String(d), { enabled: true, start: "09:00", end: "12:00" }])),
      holidays: [],
    });
    const availability = await checkAvailability({ businessId: business.id, date: openDay, durationMinutes: 30 });
    expect(availability.slots.length).toBe(6);
    expect(availability.slots.every((slot) => slot.available)).toBe(true);
    expect(availability.timezone).toBe("Asia/Tehran");
    // Slots are contiguous and ordered.
    for (let i = 1; i < availability.slots.length; i++) {
      expect(Date.parse(availability.slots[i].start)).toBe(Date.parse(availability.slots[i - 1].end));
    }

    const customer = await createCustomer(business.id, "09121110009");
    const lead = await createLead(business.id, customer.id);
    const agent = await createUser(business.id, "AGENT");
    const created = await createAppointment(business.id, {
      scheduledAt: availability.slots[1].start,
      durationMinutes: 30,
      customerId: customer.id,
      leadId: lead.id,
      assignedUserId: agent.user.id,
      title: "بازدید ملک",
    });
    expect(created.id).toBeTruthy();
    const booked = await noiselessCheck(business.id, openDay, 30);
    expect(booked.slots[1].available).toBe(false);
    expect(booked.slots[0].available).toBe(true);

    // Overlapping windows are excluded, and an assignment filter shows another agent as free.
    const overlapping = await noiselessCheck(business.id, openDay, 60);
    expect(overlapping.slots.some((slot) => !slot.available)).toBe(true);
    const otherAgent = await createUser(business.id, "AGENT");
    const filtered = await checkAvailability({ businessId: business.id, date: openDay, durationMinutes: 30, assignedUserId: otherAgent.user.id });
    expect(filtered.slots.every((slot) => slot.available)).toBe(true);

    await expect(rescheduleAppointment(business.id, created.id, { scheduledAt: new Date(Date.now() - 3600_000).toISOString() })).rejects.toThrow(/future/);
    await cancelAppointment(business.id, created.id);
    const freed = await noiselessCheck(business.id, openDay, 30);
    expect(freed.slots[1].available).toBe(true);
  });

  itDb("refuses past, outside-schedule and conflicting bookings, and validates references", async () => {
    const business = await createBusiness();
    const other = await createBusiness();
    const openDay = nextWeekday(3);
    await configure(business.id, {
      slotMinutes: 60,
      days: Object.fromEntries(Array.from({ length: 7 }, (_, d) => [String(d), { enabled: true, start: "09:00", end: "17:00" }])),
      holidays: [],
    });
    const availability = await checkAvailability({ businessId: business.id, date: openDay, durationMinutes: 60 });
    const slot = availability.slots[0].start;

    await expect(createAppointment(business.id, { scheduledAt: new Date(Date.now() - 3600_000).toISOString() })).rejects.toThrow(/future/);
    await expect(createAppointment(business.id, { scheduledAt: "not-a-date" })).rejects.toThrow();
    await expect(createAppointment(business.id, {})).rejects.toThrow();
    // 23:00 is outside the configured 09:00-17:00 window.
    const late = new Date(`${openDay}T23:30:00.000+03:30`).toISOString();
    await expect(createAppointment(business.id, { scheduledAt: late })).rejects.toThrow(/schedule|outside|closed/i);
    // A reference that belongs to another tenant is not usable.
    const foreignCustomer = await createCustomer(other.id, "09121110010");
    await expect(createAppointment(business.id, { scheduledAt: slot, customerId: foreignCustomer.id })).rejects.toThrow();

    const first = await createAppointment(business.id, { scheduledAt: slot, durationMinutes: 60 });
    await expect(createAppointment(business.id, { scheduledAt: slot, durationMinutes: 60 })).rejects.toMatchObject({ status: 409 });
    expect((await db.select().from(appointments)).filter((row) => row.status !== "CANCELLED")).toHaveLength(1);
    expect(first.id).toBeTruthy();
  });

  itDb("reschedules atomically and refuses cancelled or completed appointments", async () => {
    const business = await createBusiness();
    const openDay = nextWeekday(4);
    await configure(business.id, {
      slotMinutes: 60,
      days: Object.fromEntries(Array.from({ length: 7 }, (_, d) => [String(d), { enabled: true, start: "09:00", end: "17:00" }])),
      holidays: [],
    });
    const slots = (await checkAvailability({ businessId: business.id, date: openDay, durationMinutes: 60 })).slots;
    const created = await createAppointment(business.id, { scheduledAt: slots[0].start, durationMinutes: 60 });

    const moved = await rescheduleAppointment(business.id, created.id, { scheduledAt: slots[2].start, durationMinutes: 90 });
    expect(new Date(moved.scheduledAt!).toISOString()).toBe(slots[2].start);
    expect(moved.durationMinutes).toBe(90);
    await expect(rescheduleAppointment(business.id, moved.id, { scheduledAt: "nope" })).rejects.toThrow();
    await expect(rescheduleAppointment(business.id, moved.id, { scheduledAt: new Date(Date.now() - 3600_000).toISOString() })).rejects.toThrow(/future/);

    await expect(rescheduleAppointment(business.id, crypto.randomUUID(), { scheduledAt: slots[1].start })).rejects.toMatchObject({ status: 404 });
    const other = await createBusiness();
    await expect(rescheduleAppointment(other.id, moved.id, { scheduledAt: slots[1].start })).rejects.toMatchObject({ status: 404 });

    // A retired slot is history: the original row is CANCELLED and the move is
    // recorded on the new row.
    const [retired] = await db.select().from(appointments).where(eq(appointments.id, created.id));
    expect(retired.status).toBe("CANCELLED");
    expect(moved.notes ?? "").toContain(`rescheduled from ${created.id}`);
    await cancelAppointment(business.id, moved.id);
    await expect(rescheduleAppointment(business.id, moved.id, { scheduledAt: slots[3].start })).rejects.toMatchObject({ status: 409 });
    await expect(cancelAppointment(business.id, created.id)).resolves.toBeTruthy(); // idempotent cancel of an already retired slot
    await expect(cancelAppointment(business.id, crypto.randomUUID())).rejects.toMatchObject({ status: 404 });
    const events = await db.select().from(outboxEvents).where(eq(outboxEvents.businessId, business.id));
    expect(events.some((event) => event.topic === "appointment.cancelled")).toBe(true);
  });

  itDb("scopes appointment reads to the tenant that owns them", async () => {
    const business = await createBusiness();
    const other = await createBusiness();
    const openDay = nextWeekday(5);
    await configure(business.id, {
      slotMinutes: 60,
      days: Object.fromEntries(Array.from({ length: 7 }, (_, d) => [String(d), { enabled: true, start: "09:00", end: "17:00" }])),
      holidays: [],
    });
    const slots = (await checkAvailability({ businessId: business.id, date: openDay, durationMinutes: 60 })).slots;
    const created = await createAppointment(business.id, { scheduledAt: slots[0].start, durationMinutes: 60 });
    expect((await getAppointment(business.id, created.id)).id).toBe(created.id);
    await expect(getAppointment(other.id, created.id)).rejects.toMatchObject({ status: 404 });
    await expect(getAppointment(business.id, crypto.randomUUID())).rejects.toMatchObject({ status: 404 });
    await expect(cancelAppointment(other.id, created.id)).rejects.toMatchObject({ status: 404 });
  });
});

/** checkAvailability without the noisy per-call logging used in the assertions above. */
async function noiselessCheck(businessId: string, date: string, durationMinutes: number) {
  return checkAvailability({ businessId, date, durationMinutes });
}
