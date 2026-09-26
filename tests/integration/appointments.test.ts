import { afterAll, beforeAll, describe, expect } from "vitest";
import { closeDb } from "@/db";
import { ensureDbReady, hasTestDatabase, itDb, truncateAll } from "../helpers/db";
import { createBusiness } from "../helpers/fixtures";

const runIntegration = hasTestDatabase();

function nextWeekdayDate(daysAhead = 3): string {
  const d = new Date(Date.now() + daysAhead * 24 * 3600 * 1000);
  return d.toISOString().slice(0, 10);
}

describe.skipIf(!runIntegration)("appointments (real database)", () => {
  let businessId: string;

  beforeAll(async () => {
    if (!(await ensureDbReady())) return;
    await truncateAll();
    businessId = (await createBusiness("Appt Biz")).id;
  });

  afterAll(async () => {
    if (runIntegration) {
      await truncateAll().catch(() => undefined);
      await closeDb();
    }
  });

  itDb("lists availability slots for a working day", async () => {
    const { checkAvailability } = await import("@/lib/services/appointments");
    const result = await checkAvailability({ businessId, date: nextWeekdayDate(4) });
    expect(result.slots.length).toBeGreaterThan(0);
    expect(result.slots.every((s) => s.available)).toBe(true);
  });

  itDb("books an appointment and blocks overlaps", async () => {
    const { checkAvailability, createAppointment } = await import("@/lib/services/appointments");
    const date = nextWeekdayDate(5);
    const avail = await checkAvailability({ businessId, date });
    const slot = avail.slots.find((s) => s.available);
    expect(slot).toBeTruthy();

    const created = await createAppointment(businessId, { scheduledAt: slot!.start, durationMinutes: 30 });
    expect(created.status).toBe("SCHEDULED");

    // Exact overlap → conflict.
    await expect(createAppointment(businessId, { scheduledAt: slot!.start, durationMinutes: 30 })).rejects.toMatchObject({
      code: "APPOINTMENT_CONFLICT",
    });

    // Partial overlap → conflict.
    const mid = new Date(new Date(slot!.start).getTime() + 15 * 60_000).toISOString();
    await expect(createAppointment(businessId, { scheduledAt: mid, durationMinutes: 30 })).rejects.toMatchObject({
      code: "APPOINTMENT_CONFLICT",
    });
  });

  itDb("rejects bookings outside working hours", async () => {
    const { createAppointment } = await import("@/lib/services/appointments");
    // 03:00 Tehran ≈ 23:30Z previous day — outside 09:00-18:00.
    const date = nextWeekdayDate(6);
    await expect(
      createAppointment(businessId, { scheduledAt: `${date}T00:30:00Z`, durationMinutes: 30 }),
    ).rejects.toMatchObject({ code: "APPOINTMENT_CONFLICT" });
  });

  itDb("rejects past bookings", async () => {
    const { createAppointment } = await import("@/lib/services/appointments");
    await expect(
      createAppointment(businessId, { scheduledAt: "2020-01-01T10:00:00Z", durationMinutes: 30 }),
    ).rejects.toThrow();
  });

  itDb("reschedules and cancels", async () => {
    const { cancelAppointment, checkAvailability, createAppointment, rescheduleAppointment } =
      await import("@/lib/services/appointments");
    const date = nextWeekdayDate(7);
    const avail = await checkAvailability({ businessId, date });
    const free = avail.slots.filter((s) => s.available);
    expect(free.length).toBeGreaterThanOrEqual(2);

    const created = await createAppointment(businessId, { scheduledAt: free[0].start, durationMinutes: 30 });
    const moved = await rescheduleAppointment(businessId, created.id, { scheduledAt: free[1].start });
    expect(moved.id).not.toBe(created.id);

    const { getAppointment } = await import("@/lib/services/appointments");
    const old = await getAppointment(businessId, created.id);
    expect(old.status).toBe("CANCELLED");

    const cancelled = await cancelAppointment(businessId, moved.id);
    expect(cancelled.status).toBe("CANCELLED");
  });

  itDb("respects holidays", async () => {
    const { checkAvailability, updateSchedulingConfig } = await import("@/lib/services/appointments");
    const date = nextWeekdayDate(8);
    await updateSchedulingConfig(businessId, { slotMinutes: 30, days: {}, holidays: [date] });
    const result = await checkAvailability({ businessId, date });
    expect(result.slots).toEqual([]);
  });
});
