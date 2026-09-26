import { and, desc, eq, inArray } from "drizzle-orm";
import { db, type DbExecutor } from "@/db";
import { appointments, calls, customers, leads } from "@/db/schema";
import { AppError } from "@/lib/errors";
import { normalizePersianText, normalizePhone } from "@/lib/normalization";

export type CustomerInput = {
  businessId: string;
  phone: string;
  name?: string;
  email?: string;
  metadata?: Record<string, unknown>;
  /** Run inside this executor (caller's transaction) instead of the root client. */
  db?: DbExecutor;
};

/**
 * Find-or-create with (businessId, phone) deduplication.
 * Race-safe: unique constraint + onConflictDoNothing + re-select, so
 * concurrent calls for the same number never create duplicates.
 */
export async function findOrCreateCustomer(input: CustomerInput) {
  const phone = normalizePhone(input.phone);
  if (!phone) throw new AppError(400, "VALIDATION_ERROR", "Invalid phone number");
  const name = input.name ? normalizePersianText(input.name) : "";
  const dx = input.db ?? db;

  const [existing] = await dx
    .select()
    .from(customers)
    .where(and(eq(customers.businessId, input.businessId), eq(customers.phone, phone)))
    .limit(1);

  if (existing) {
    // Fill in missing profile fields on repeat encounters; never blank them.
    const patch: { name?: string; email?: string | null; updatedAt: Date } = { updatedAt: new Date() };
    let needsUpdate = false;
    if (name && !existing.name) {
      patch.name = name;
      needsUpdate = true;
    }
    if (input.email && !existing.email) {
      patch.email = input.email;
      needsUpdate = true;
    }
    if (!needsUpdate) return existing;
    const [updated] = await dx
      .update(customers)
      .set(patch)
      .where(eq(customers.id, existing.id))
      .returning();
    return updated ?? existing;
  }

  const [created] = await dx
    .insert(customers)
    .values({
      businessId: input.businessId,
      phone,
      name,
      email: input.email ?? null,
      metadata: input.metadata ?? {},
    })
    .onConflictDoNothing({ target: [customers.businessId, customers.phone] })
    .returning();

  if (created) return created;

  // Lost a race: another transaction inserted the row — re-select it.
  const [row] = await dx
    .select()
    .from(customers)
    .where(and(eq(customers.businessId, input.businessId), eq(customers.phone, phone)))
    .limit(1);
  if (!row) throw new AppError(500, "INTERNAL_ERROR", "Customer upsert failed");
  return row;
}

export async function getCustomer(businessId: string, customerId: string) {
  const [row] = await db
    .select()
    .from(customers)
    .where(and(eq(customers.id, customerId), eq(customers.businessId, businessId)))
    .limit(1);
  if (!row) throw new AppError(404, "CUSTOMER_NOT_FOUND", "Customer not found");
  return row;
}

export async function updateCustomer(
  businessId: string,
  customerId: string,
  patch: { name?: string; email?: string | null; metadata?: Record<string, unknown> },
) {
  const [updated] = await db
    .update(customers)
    .set({
      name: patch.name ? normalizePersianText(patch.name) : undefined,
      email: patch.email === undefined ? undefined : patch.email,
      metadata: patch.metadata,
      updatedAt: new Date(),
    })
    .where(and(eq(customers.id, customerId), eq(customers.businessId, businessId)))
    .returning();
  if (!updated) throw new AppError(404, "CUSTOMER_NOT_FOUND", "Customer not found");
  return updated;
}

/** Customer 360° history: calls, leads, appointments (tenant-scoped). */
export async function getCustomerHistory(
  businessId: string,
  customerId: string,
  opts?: { limit?: number },
) {
  await getCustomer(businessId, customerId);
  const limit = Math.min(opts?.limit ?? 20, 100);

  const [customerLeads, customerCalls] = await Promise.all([
    db
      .select()
      .from(leads)
      .where(and(eq(leads.businessId, businessId), eq(leads.customerId, customerId)))
      .orderBy(desc(leads.createdAt))
      .limit(limit),
    db
      .select()
      .from(calls)
      .where(and(eq(calls.businessId, businessId), eq(calls.customerId, customerId)))
      .orderBy(desc(calls.createdAt))
      .limit(limit),
  ]);

  const leadIds = customerLeads.map((l) => l.id);
  const customerAppointments =
    leadIds.length > 0
      ? await db
          .select()
          .from(appointments)
          .where(and(eq(appointments.businessId, businessId), inArray(appointments.leadId, leadIds)))
          .orderBy(desc(appointments.createdAt))
          .limit(limit)
      : [];

  return { leads: customerLeads, calls: customerCalls, appointments: customerAppointments };
}
