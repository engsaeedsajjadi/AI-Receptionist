import { and, eq, gte, inArray, lt, ne } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { appointments, businesses, customers, leads, users } from "@/db/schema";
import { AppError } from "@/lib/errors";
import { acquireLock } from "@/lib/redis";
import { normalizePersianText } from "@/lib/normalization";

// ---------------------------------------------------------------------------
// Business schedule configuration (stored in businesses.settings.scheduling)
// ---------------------------------------------------------------------------

const DayScheduleSchema = z.object({
  enabled: z.boolean().default(true),
  start: z.string().regex(/^\d{2}:\d{2}$/).default("09:00"),
  end: z.string().regex(/^\d{2}:\d{2}$/).default("18:00"),
});

export const SchedulingConfigSchema = z.object({
  slotMinutes: z.number().int().min(10).max(240).default(30),
  days: z
    .record(z.string(), DayScheduleSchema)
    .default({})
    .transform((days) => {
      const full: Record<string, { enabled: boolean; start: string; end: string }> = {};
      // 0=Sunday..6=Saturday. Default: every day 09:00-18:00 (Tehran).
      for (let d = 0; d < 7; d++) {
        full[String(d)] = days[String(d)] ?? { enabled: true, start: "09:00", end: "18:00" };
      }
      return full;
    }),
  holidays: z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)).default([]),
});

export type SchedulingConfig = z.infer<typeof SchedulingConfigSchema>;

const DEFAULT_CONFIG: SchedulingConfig = {
  slotMinutes: 30,
  days: Object.fromEntries(
    Array.from({ length: 7 }, (_, d) => [String(d), { enabled: true, start: "09:00", end: "18:00" }]),
  ),
  holidays: [],
};

export async function getSchedulingConfig(businessId: string): Promise<{ config: SchedulingConfig; timezone: string }> {
  const [biz] = await db
    .select({ settings: businesses.settings, timezone: businesses.timezone })
    .from(businesses)
    .where(eq(businesses.id, businessId))
    .limit(1);
  if (!biz) throw new AppError(404, "BUSINESS_NOT_FOUND", "Business not found");
  const raw = (biz.settings as Record<string, unknown> | null)?.scheduling;
  const parsed = SchedulingConfigSchema.safeParse(raw ?? {});
  return { config: parsed.success ? parsed.data : DEFAULT_CONFIG, timezone: biz.timezone ?? "Asia/Tehran" };
}

export async function updateSchedulingConfig(businessId: string, raw: unknown): Promise<SchedulingConfig> {
  const config = SchedulingConfigSchema.parse(raw);
  const [biz] = await db
    .select({ settings: businesses.settings })
    .from(businesses)
    .where(eq(businesses.id, businessId))
    .limit(1);
  if (!biz) throw new AppError(404, "BUSINESS_NOT_FOUND", "Business not found");
  const settings = { ...((biz.settings as Record<string, unknown>) ?? {}), scheduling: config };
  await db.update(businesses).set({ settings, updatedAt: new Date() }).where(eq(businesses.id, businessId));
  return config;
}

// ---------------------------------------------------------------------------
// Time helpers (timezone-aware via Intl for Asia/Tehran etc.)
// ---------------------------------------------------------------------------

function zonedParts(date: Date, timeZone: string): { y: number; m: number; d: number; wd: number; minutes: number } {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = Object.fromEntries(fmt.formatToParts(date).map((p) => [p.type, p.value]));
  const wdMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    y: Number(parts.year),
    m: Number(parts.month),
    d: Number(parts.day),
    wd: wdMap[parts.weekday] ?? 0,
    minutes: (Number(parts.hour) % 24) * 60 + Number(parts.minute),
  };
}

function dateKeyInZone(date: Date, timeZone: string): string {
  const p = zonedParts(date, timeZone);
  return `${p.y}-${String(p.m).padStart(2, "0")}-${String(p.d).padStart(2, "0")}`;
}

function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

function overlaps(aStart: Date, aEnd: Date, bStart: Date, bEnd: Date): boolean {
  return aStart < bEnd && bStart < aEnd;
}

// ---------------------------------------------------------------------------
// Availability
// ---------------------------------------------------------------------------

export type AvailabilitySlot = { start: string; end: string; available: boolean };

export async function checkAvailability(input: {
  businessId: string;
  date: string; // YYYY-MM-DD in business timezone
  durationMinutes?: number;
  assignedUserId?: string;
}): Promise<{ date: string; timezone: string; slots: AvailabilitySlot[] }> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date)) {
    throw new AppError(400, "VALIDATION_ERROR", "date must be YYYY-MM-DD");
  }
  const { config, timezone } = await getSchedulingConfig(input.businessId);
  const duration = input.durationMinutes ?? config.slotMinutes;

  if (config.holidays.includes(input.date)) {
    return { date: input.date, timezone, slots: [] };
  }

  // Resolve weekday by probing noon UTC (safe for Tehran ±offsets).
  const probe = new Date(`${input.date}T12:00:00Z`);
  const weekday = zonedParts(probe, timezone).wd;
  const day = config.days[String(weekday)];
  if (!day?.enabled) return { date: input.date, timezone, slots: [] };

  const dayStart = new Date(`${input.date}T00:00:00Z`);
  const dayEnd = new Date(dayStart.getTime() + 36 * 3600 * 1000); // cover TZ spillover
  const existing = await db
    .select()
    .from(appointments)
    .where(
      and(
        eq(appointments.businessId, input.businessId),
        ne(appointments.status, "CANCELLED"),
        gte(appointments.scheduledAt, dayStart),
        lt(appointments.scheduledAt, dayEnd),
      ),
    );

  const slots: AvailabilitySlot[] = [];
  for (let m = toMinutes(day.start); m + duration <= toMinutes(day.end); m += config.slotMinutes) {
    // Build slot start in business TZ by offset probing (handles Tehran DST-free +30:30/+... generically).
    const slotStart = zonedTimeToUtc(input.date, m, timezone);
    const slotEnd = new Date(slotStart.getTime() + duration * 60_000);
    const busy = existing.some((a) => {
      if (!a.scheduledAt) return false;
      if (input.assignedUserId && a.assignedUserId && a.assignedUserId !== input.assignedUserId) return false;
      const aEnd = new Date(a.scheduledAt.getTime() + (a.durationMinutes ?? 30) * 60_000);
      return overlaps(slotStart, slotEnd, a.scheduledAt, aEnd);
    });
    slots.push({ start: slotStart.toISOString(), end: slotEnd.toISOString(), available: !busy });
  }
  return { date: input.date, timezone, slots };
}

/** Convert a wall-clock time in `timeZone` to a UTC Date (offset probing). */
function zonedTimeToUtc(dateKey: string, minutes: number, timeZone: string): Date {
  const hh = String(Math.floor(minutes / 60)).padStart(2, "0");
  const mm = String(minutes % 60).padStart(2, "0");
  const guess = new Date(`${dateKey}T${hh}:${mm}:00Z`);
  // Probe the zone offset at the guessed instant and correct.
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const asUtc = new Date(guess.toLocaleString("en-US", { timeZone: "UTC" }));
  const asZone = new Date(guess.toLocaleString("en-US", { timeZone }));
  void fmt;
  const offsetMs = asUtc.getTime() - asZone.getTime();
  return new Date(guess.getTime() + offsetMs);
}

// ---------------------------------------------------------------------------
// Booking (race-safe via distributed lock + transaction + overlap check)
// ---------------------------------------------------------------------------

type SlotFields = {
  leadId?: string;
  customerId?: string;
  assignedUserId?: string;
  title?: string;
  durationMinutes: number;
  notes?: string;
};

/** Holiday + working-hours validation shared by book/reschedule. Returns the business-day key. */
async function assertSlotWithinSchedule(
  businessId: string,
  start: Date,
  durationMinutes: number,
): Promise<{ key: string; timezone: string }> {
  const end = new Date(start.getTime() + durationMinutes * 60_000);
  const { config, timezone } = await getSchedulingConfig(businessId);
  const key = dateKeyInZone(start, timezone);
  if (config.holidays.includes(key)) {
    throw new AppError(409, "APPOINTMENT_CONFLICT", "Selected day is a holiday");
  }
  const weekday = zonedParts(start, timezone).wd;
  const day = config.days[String(weekday)];
  const startMinutes = zonedParts(start, timezone).minutes;
  const endMinutes = startMinutes + durationMinutes;
  void end;
  if (!day?.enabled || startMinutes < toMinutes(day.start) || endMinutes > toMinutes(day.end)) {
    throw new AppError(409, "APPOINTMENT_CONFLICT", "Selected time is outside working hours");
  }
  return { key, timezone };
}

/**
 * Overlap check + insert inside a caller-owned transaction.
 * The caller must hold the `appt:{businessId}:{dayKey}` distributed lock.
 */
async function insertAppointmentTx(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  businessId: string,
  fields: SlotFields,
  start: Date,
  end: Date,
) {
  const existing = await tx
    .select()
    .from(appointments)
    .where(
      and(
        eq(appointments.businessId, businessId),
        ne(appointments.status, "CANCELLED"),
        lt(appointments.scheduledAt, end),
        gte(appointments.scheduledAt, new Date(start.getTime() - 12 * 3600 * 1000)),
      ),
    );
  for (const a of existing) {
    if (!a.scheduledAt) continue;
    if (fields.assignedUserId && a.assignedUserId && a.assignedUserId !== fields.assignedUserId) continue;
    const aEnd = new Date(a.scheduledAt.getTime() + (a.durationMinutes ?? 30) * 60_000);
    if (overlaps(start, end, a.scheduledAt, aEnd)) {
      throw new AppError(409, "APPOINTMENT_CONFLICT", "Appointment time is no longer available.");
    }
  }
  const [created] = await tx
    .insert(appointments)
    .values({
      businessId,
      leadId: fields.leadId ?? null,
      customerId: fields.customerId ?? null,
      assignedUserId: fields.assignedUserId ?? null,
      title: fields.title ? normalizePersianText(fields.title) : null,
      scheduledAt: start,
      durationMinutes: fields.durationMinutes,
      status: "SCHEDULED",
      notes: fields.notes ? normalizePersianText(fields.notes) : null,
    })
    .returning();
  return created;
}

export const CreateAppointmentSchema = z.object({
  leadId: z.string().uuid().optional(),
  customerId: z.string().uuid().optional(),
  assignedUserId: z.string().uuid().optional(),
  title: z.string().max(255).optional(),
  scheduledAt: z.string().datetime({ offset: true }),
  durationMinutes: z.number().int().min(10).max(480).default(30),
  notes: z.string().max(2000).optional(),
});

export type CreateAppointmentInput = z.infer<typeof CreateAppointmentSchema>;

/**
 * Referenced entities must belong to the booking business: FK constraints
 * only prove global existence, so without this check a caller could link
 * an appointment to another tenant's lead, customer, or user.
 */
async function assertAppointmentRefsInBusiness(
  businessId: string,
  input: { leadId?: string; customerId?: string; assignedUserId?: string },
): Promise<void> {
  if (input.leadId) {
    const [row] = await db
      .select({ id: leads.id })
      .from(leads)
      .where(and(eq(leads.id, input.leadId), eq(leads.businessId, businessId)))
      .limit(1);
    if (!row) throw new AppError(404, "LEAD_NOT_FOUND", "Lead not found");
  }
  if (input.customerId) {
    const [row] = await db
      .select({ id: customers.id })
      .from(customers)
      .where(and(eq(customers.id, input.customerId), eq(customers.businessId, businessId)))
      .limit(1);
    if (!row) throw new AppError(404, "CUSTOMER_NOT_FOUND", "Customer not found");
  }
  if (input.assignedUserId) {
    const [row] = await db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.id, input.assignedUserId), eq(users.businessId, businessId)))
      .limit(1);
    if (!row) throw new AppError(404, "USER_NOT_FOUND", "User not found");
  }
}

export async function createAppointment(businessId: string, raw: unknown, opts?: { requestId?: string }) {
  void opts;
  const input = CreateAppointmentSchema.parse(raw);
  const start = new Date(input.scheduledAt);
  if (Number.isNaN(start.getTime())) throw new AppError(400, "VALIDATION_ERROR", "Invalid scheduledAt");
  if (start <= new Date()) throw new AppError(400, "VALIDATION_ERROR", "Appointment must be in the future");
  await assertAppointmentRefsInBusiness(businessId, input);
  const end = new Date(start.getTime() + input.durationMinutes * 60_000);

  const { key } = await assertSlotWithinSchedule(businessId, start, input.durationMinutes);

  // Distributed lock per business+day prevents double-booking races.
  const release = await acquireLock(`appt:${businessId}:${key}`, 15);
  if (!release) throw new AppError(409, "APPOINTMENT_CONFLICT", "Appointment time is being booked, please retry");
  try {
    return await db.transaction(async (tx) =>
      insertAppointmentTx(
        tx,
        businessId,
        {
          leadId: input.leadId ?? undefined,
          customerId: input.customerId ?? undefined,
          assignedUserId: input.assignedUserId ?? undefined,
          title: input.title ?? undefined,
          durationMinutes: input.durationMinutes,
          notes: input.notes ?? undefined,
        },
        start,
        end,
      ),
    );
  } finally {
    await release();
  }
}

export async function rescheduleAppointment(businessId: string, appointmentId: string, raw: unknown) {
  const input = z.object({ scheduledAt: z.string().datetime({ offset: true }), durationMinutes: z.number().int().min(10).max(480).optional() }).parse(raw);
  const [existing] = await db
    .select()
    .from(appointments)
    .where(and(eq(appointments.id, appointmentId), eq(appointments.businessId, businessId)))
    .limit(1);
  if (!existing) throw new AppError(404, "APPOINTMENT_NOT_FOUND", "Appointment not found");
  if (existing.status === "CANCELLED" || existing.status === "COMPLETED") {
    throw new AppError(409, "APPOINTMENT_CONFLICT", `Cannot reschedule a ${existing.status.toLowerCase()} appointment`);
  }

  const start = new Date(input.scheduledAt);
  if (Number.isNaN(start.getTime())) throw new AppError(400, "VALIDATION_ERROR", "Invalid scheduledAt");
  if (start <= new Date()) throw new AppError(400, "VALIDATION_ERROR", "Appointment must be in the future");
  const durationMinutes = input.durationMinutes ?? existing.durationMinutes;
  const end = new Date(start.getTime() + durationMinutes * 60_000);
  const { key } = await assertSlotWithinSchedule(businessId, start, durationMinutes);

  const release = await acquireLock(`appt:${businessId}:${key}`, 15);
  if (!release) throw new AppError(409, "APPOINTMENT_CONFLICT", "Appointment time is being booked, please retry");
  try {
    // Atomic swap: retire the old slot and book the new one in a single
    // transaction. The overlap check sees the old row as CANCELLED, so it is
    // naturally excluded; a crash can never leave both slots booked.
    return await db.transaction(async (tx) => {
      const [retired] = await tx
        .update(appointments)
        .set({ status: "CANCELLED", updatedAt: new Date() })
        .where(
          and(
            eq(appointments.id, appointmentId),
            eq(appointments.businessId, businessId),
            inArray(appointments.status, ["REQUESTED", "SCHEDULED"]),
          ),
        )
        .returning({ id: appointments.id });
      if (!retired) {
        throw new AppError(409, "APPOINTMENT_CONFLICT", "Appointment was already cancelled, completed, or rescheduled");
      }
      return insertAppointmentTx(
        tx,
        businessId,
        {
          leadId: existing.leadId ?? undefined,
          customerId: existing.customerId ?? undefined,
          assignedUserId: existing.assignedUserId ?? undefined,
          title: existing.title ?? undefined,
          durationMinutes,
          notes: `${existing.notes ?? ""}\n(rescheduled from ${appointmentId})`.trim(),
        },
        start,
        end,
      );
    });
  } finally {
    await release();
  }
}

export async function cancelAppointment(businessId: string, appointmentId: string) {
  const [updated] = await db
    .update(appointments)
    .set({ status: "CANCELLED", updatedAt: new Date() })
    .where(and(eq(appointments.id, appointmentId), eq(appointments.businessId, businessId)))
    .returning();
  if (!updated) throw new AppError(404, "APPOINTMENT_NOT_FOUND", "Appointment not found");
  return updated;
}

export async function getAppointment(businessId: string, appointmentId: string) {
  const [row] = await db
    .select()
    .from(appointments)
    .where(and(eq(appointments.id, appointmentId), eq(appointments.businessId, businessId)))
    .limit(1);
  if (!row) throw new AppError(404, "APPOINTMENT_NOT_FOUND", "Appointment not found");
  return row;
}
