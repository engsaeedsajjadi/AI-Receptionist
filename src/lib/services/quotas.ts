import { metrics } from "@/lib/telemetry";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { agents, auditLogs, businesses, quotaBuckets, quotaOverrides, quotaReservations, subscriptions, users } from "@/db/schema";
import { AppError } from "@/lib/errors";
import { assertTenantScope, requestContext } from "@/lib/request-context";
import { effectivePlan } from "@/lib/billing-catalog";
import { AmountsSchema, checkLimit, decimal, METERS, planPolicies, PolicySchema, storedUnits, units, windowStart, type Amounts, type Meter, type Policy } from "@/lib/quota-policy";
import { requirePlatformAdmin } from "@/lib/services/platform";
export type QuotaTx = Parameters<Parameters<typeof db.transaction>[0]>[0];
async function lockTenant(tx: QuotaTx, businessId: string, active = true) {
  const [tenant] = await tx.select({ active: businesses.isActive }).from(businesses).where(eq(businesses.id, businessId)).for("update");
  if (!tenant || (active && !tenant.active)) throw new AppError(403, "FORBIDDEN", "Tenant is inactive or missing");
}
async function policyFor(tx: Pick<typeof db, "select">, businessId: string, now: Date) {
  const [subscription] = await tx.select().from(subscriptions).where(eq(subscriptions.businessId, businessId));
  const [override] = await tx.select().from(quotaOverrides).where(eq(quotaOverrides.businessId, businessId));
  const plan = effectivePlan(subscription, now) as keyof ReturnType<typeof planPolicies>;
  return { plan, policy: { ...(planPolicies()[plan] ?? {}), ...PolicySchema.parse(override?.policy ?? {}) } as Policy };
}
function normalize(input: Amounts): Record<string, string> {
  return Object.fromEntries(Object.entries(AmountsSchema.parse(input)).sort(([a], [b]) => a.localeCompare(b)).map(([meter, quantity]) => [meter, decimal(units(quantity!))]));
}
function same(a: Record<string, string>, b: Record<string, string>) { return JSON.stringify(Object.entries(a).sort()) === JSON.stringify(Object.entries(b).sort()); }
function exceeded(meter: string) { metrics().quotaRejections.inc({ meter }); return new AppError(402, "QUOTA_EXCEEDED", "Tenant usage limit reached", { meter }); }
export async function reserveUsage(businessId: string, key: string, input: Amounts, now = new Date()) {
  assertTenantScope(businessId); z.string().min(1).max(255).parse(key);
  const amounts = normalize(input);
  if ("active_agents" in amounts || "tenant_users" in amounts) throw new AppError(400, "BAD_REQUEST", "Use transactional inventory admission for resource counts");
  return db.transaction(async (tx) => {
    await lockTenant(tx, businessId);
    const [existing] = await tx.select().from(quotaReservations).where(and(eq(quotaReservations.businessId, businessId), eq(quotaReservations.idempotencyKey, key)));
    if (existing) {
      if (!same(existing.amounts, amounts)) throw new AppError(409, "CONFLICT", "Reservation key was reused with different amounts");
      return { ...existing, reused: true, warnings: [] as Meter[] };
    }
    const { policy } = await policyFor(tx, businessId, now);
    const windows: Record<string, string> = {}, warnings: Meter[] = [];
    for (const [name, value] of Object.entries(amounts)) {
      const meter = name as Meter, start = windowStart(meter, now); windows[meter] = start.toISOString();
      await tx.insert(quotaBuckets).values({ businessId, meter, windowStart: start }).onConflictDoNothing();
      const predicate = and(eq(quotaBuckets.businessId, businessId), eq(quotaBuckets.meter, meter), eq(quotaBuckets.windowStart, start));
      const [bucket] = await tx.select().from(quotaBuckets).where(predicate);
      const limit = checkLimit(policy[meter], storedUnits(bucket.consumed) + storedUnits(bucket.reserved) + storedUnits(value));
      if (limit.blocked) throw exceeded(meter);
      if (limit.warning) warnings.push(meter);
      await tx.update(quotaBuckets).set({ reserved: sql`${quotaBuckets.reserved} + ${value}::numeric` }).where(predicate);
    }
    const [reservation] = await tx.insert(quotaReservations).values({ businessId, idempotencyKey: key, amounts, windows }).returning();
    return { ...reservation, reused: false, warnings };
  });
}
async function finish(businessId: string, id: string, actual?: Amounts) {
  assertTenantScope(businessId); z.string().uuid().parse(id);
  const normalized = actual === undefined ? undefined : normalize(actual);
  return db.transaction(async (tx) => {
    await lockTenant(tx, businessId, false);
    const [reservation] = await tx.select().from(quotaReservations).where(and(eq(quotaReservations.businessId, businessId), eq(quotaReservations.id, id)));
    if (!reservation) throw new AppError(404, "NOT_FOUND", "Reservation not found");
    const target = normalized ? "settled" : "released";
    if (reservation.status !== "reserved") {
      if (reservation.status !== target || (normalized && !same(reservation.settledAmounts ?? {}, normalized))) throw new AppError(409, "CONFLICT", "Reservation already finalized differently");
      return { overrun: Object.entries(normalized ?? {}).some(([meter, value]) => storedUnits(value) > storedUnits(reservation.amounts[meter])) };
    }
    if (normalized && !same(Object.fromEntries(Object.keys(normalized).map(k => [k, "0"])), Object.fromEntries(Object.keys(reservation.amounts).map(k => [k, "0"])))) throw new AppError(400, "BAD_REQUEST", "Settlement meters must match reservation");
    let overrun = false;
    for (const [meter, reserved] of Object.entries(reservation.amounts)) {
      const consumed = normalized?.[meter] ?? "0.0000";
      overrun ||= storedUnits(consumed) > storedUnits(reserved);
      await tx.update(quotaBuckets).set({ reserved: sql`${quotaBuckets.reserved} - ${reserved}::numeric`, consumed: sql`${quotaBuckets.consumed} + ${consumed}::numeric` })
        .where(and(eq(quotaBuckets.businessId, businessId), eq(quotaBuckets.meter, meter), eq(quotaBuckets.windowStart, new Date(reservation.windows[meter]))));
    }
    await tx.update(quotaReservations).set({ status: target, settledAmounts: normalized ?? null, completedAt: new Date() }).where(and(eq(quotaReservations.id, id), eq(quotaReservations.businessId, businessId)));
    if (overrun) await tx.insert(auditLogs).values({ businessId, actorType: "system", action: "quota.provider_overrun", entityType: "quota_reservation", entityId: id, metadata: { reserved: reservation.amounts, actual: normalized } });
    return { overrun };
  });
}
export const settleUsage = (businessId: string, id: string, actual: Amounts) => finish(businessId, id, actual);
export const releaseUsage = (businessId: string, id: string) => finish(businessId, id);
export async function withUsageReservation<T>(businessId: string, amounts: Amounts, execute: () => Promise<T>, actual: (result: T) => Amounts, key = crypto.randomUUID()) {
  const reservation = await reserveUsage(businessId, key, amounts);
  if (reservation.reused) throw new AppError(409, "CONFLICT", "Operation already reserved; do not execute twice");
  let result: T;
  try { result = await execute(); }
  catch (error) { if (error instanceof AppError && error.code === "PROVIDER_TIMEOUT") throw error; await releaseUsage(businessId, reservation.id); throw error; }
  // A settlement failure must retain the reservation; execution already succeeded.
  const { overrun } = await settleUsage(businessId, reservation.id, actual(result));
  if (overrun) throw new AppError(502, "PROVIDER_ERROR", "Provider exceeded reserved usage; consumption recorded for reconciliation");
  return result;
}
export async function inventoryQuota(tx: QuotaTx, businessId: string, meter: "active_agents" | "tenant_users", delta: number) {
  assertTenantScope(businessId); z.number().int().nonnegative().parse(delta); await lockTenant(tx, businessId);
  const table = meter === "active_agents" ? agents : users;
  const [{ count }] = await tx.select({ count: sql<number>`count(*)::int` }).from(table).where(and(eq(table.businessId, businessId), eq(table.isActive, true)));
  const { policy } = await policyFor(tx, businessId, new Date());
  if (checkLimit(policy[meter], units(count + delta)).blocked) throw exceeded(meter);
}
export async function getQuotaStatus(businessId: string) {
  assertTenantScope(businessId);
  return db.transaction(async (tx) => {
    await lockTenant(tx, businessId);
    const now = new Date(), { plan, policy } = await policyFor(tx, businessId, now);
    const meters = [];
    for (const meter of METERS) {
      const start = windowStart(meter, now);
      const [bucket] = await tx.select().from(quotaBuckets).where(and(eq(quotaBuckets.businessId, businessId), eq(quotaBuckets.meter, meter), eq(quotaBuckets.windowStart, start)));
      let consumed = bucket?.consumed ?? "0.0000";
      if (meter === "active_agents" || meter === "tenant_users") {
        const table = meter === "active_agents" ? agents : users;
        const [{ count }] = await tx.select({ count: sql<number>`count(*)::int` }).from(table).where(and(eq(table.businessId, businessId), eq(table.isActive, true)));
        consumed = decimal(units(count));
      }
      const reserved = bucket?.reserved ?? "0.0000", limit = policy[meter] ?? { hard: null, soft: null, grace: 0 };
      meters.push({ meter, connected: ["calls", "llm_input_tokens", "llm_output_tokens", "embedding_tokens", "tts_characters", "active_agents", "tenant_users"].includes(meter), windowStart: start.toISOString(), consumed, reserved, ...limit, ...checkLimit(limit, storedUnits(consumed) + storedUnits(reserved)) });
    }
    return { plan, meters };
  });
}
export const OverrideSchema = z.object({ businessId: z.string().uuid(), policy: PolicySchema, reason: z.string().trim().min(10).max(1000) }).strict();
export async function updateQuotaOverride(actorId: string, input: unknown) {
  const body = OverrideSchema.parse(input);
  return db.transaction(async (tx) => {
    await requirePlatformAdmin(tx, actorId, true);
    await lockTenant(tx, body.businessId, false);
    const [previous] = await tx.select().from(quotaOverrides).where(eq(quotaOverrides.businessId, body.businessId));
    const merged = { ...(previous?.policy ?? {}), ...body.policy };
    await tx.insert(quotaOverrides).values({ businessId: body.businessId, policy: merged }).onConflictDoUpdate({ target: quotaOverrides.businessId, set: { policy: merged, updatedAt: new Date() } });
    await tx.insert(auditLogs).values({ businessId: body.businessId, actorType: "platform_admin", actorId, action: "quota.override_changed", entityType: "business", entityId: body.businessId, requestId: requestContext.getStore()?.requestId, metadata: { reason: body.reason, policy: merged, previousPolicy: previous?.policy ?? {} } });
    return { businessId: body.businessId, policy: merged };
  });
}

/** Only for database resources: the caller's resource write and debit share this transaction. */
export async function consumeUsageInTransaction(tx: QuotaTx, businessId: string, meter: Meter, quantity: number, key: string) {
  assertTenantScope(businessId); await lockTenant(tx, businessId);
  const value = decimal(units(quantity)), now = new Date(), start = windowStart(meter, now);
  const [existing] = await tx.select().from(quotaReservations).where(and(eq(quotaReservations.businessId, businessId), eq(quotaReservations.idempotencyKey, key)));
  if (existing) {
    if (existing.status !== "settled" || !same(existing.amounts, { [meter]: value })) throw new AppError(409, "CONFLICT", "Quota operation key conflict");
    return;
  }
  const { policy } = await policyFor(tx, businessId, now);
  await tx.insert(quotaBuckets).values({ businessId, meter, windowStart: start }).onConflictDoNothing();
  const predicate = and(eq(quotaBuckets.businessId, businessId), eq(quotaBuckets.meter, meter), eq(quotaBuckets.windowStart, start));
  const [bucket] = await tx.select().from(quotaBuckets).where(predicate);
  if (checkLimit(policy[meter], storedUnits(bucket.consumed) + storedUnits(bucket.reserved) + storedUnits(value)).blocked) throw exceeded(meter);
  await tx.update(quotaBuckets).set({ consumed: sql`${quotaBuckets.consumed} + ${value}::numeric` }).where(predicate);
  await tx.insert(quotaReservations).values({ businessId, idempotencyKey: key, amounts: { [meter]: value }, settledAmounts: { [meter]: value }, windows: { [meter]: start.toISOString() }, status: "settled", completedAt: now });
}
