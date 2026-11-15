import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { billingInvoices, subscriptions, businesses, auditLogs } from "@/db/schema";
import { AppError, mapUniqueViolation } from "@/lib/api";
import { assertTenantScope, requestContext } from "@/lib/request-context";
import { addCalendarMonth, billingCatalog, CurrencySchema, effectivePlan, PaidPlanSchema } from "@/lib/billing-catalog";
import { requirePlatformAdmin } from "@/lib/services/platform";
import { enqueueOutbox } from "@/lib/services/outbox";
export const InvoiceRequestSchema = z.object({ plan: PaidPlanSchema, idempotencyKey: z.string().uuid() }).strict();
export const PaymentSchema = z.object({ id: z.string().uuid(), businessId: z.string().uuid(),
  amountMinor: z.number().int().positive(), currency: CurrencySchema,
  paymentReference: z.string().trim().min(5).max(255) }).strict();
export async function getBilling(businessId: string) {
  assertTenantScope(businessId);
  const [subscription] = await db.select().from(subscriptions).where(eq(subscriptions.businessId, businessId));
  const invoices = await db.select().from(billingInvoices).where(eq(billingInvoices.businessId, businessId)).orderBy(desc(billingInvoices.createdAt)).limit(100);
  const catalog = billingCatalog();
  return { plan: effectivePlan(subscription), subscription: subscription ?? null, invoices,
    availablePlans: catalog?.plans ?? [], paymentMode: "manual_invoice", quotasEnforced: false, enforcedQuotaMeters: ["calls", "llm_input_tokens", "llm_output_tokens", "embedding_tokens", "tts_characters", "active_agents", "tenant_users"] };
}
export async function requestInvoice(businessId: string, input: unknown) {
  assertTenantScope(businessId);
  const body = InvoiceRequestSchema.parse(input);
  return db.transaction(async (tx) => {
    const [tenant] = await tx.select().from(businesses).where(eq(businesses.id, businessId)).for("update");
    if (!tenant?.isActive) throw new AppError(403, "FORBIDDEN", "Tenant is inactive");
    const [existing] = await tx.select().from(billingInvoices).where(and(eq(billingInvoices.businessId, businessId), eq(billingInvoices.idempotencyKey, body.idempotencyKey)));
    if (existing) {
      if (existing.plan !== body.plan) throw new AppError(409, "CONFLICT", "Idempotency key already used for another plan");
      return existing;
    }
    const catalog = billingCatalog();
    const plan = catalog?.plans.find((item) => item.plan === body.plan);
    if (!catalog || !plan) throw new AppError(503, "PROVIDER_NOT_CONFIGURED", "Plan pricing and invoice issuer must be configured by the operator");
    const [subscription] = await tx.select().from(subscriptions).where(eq(subscriptions.businessId, businessId));
    const active = effectivePlan(subscription);
    if (active !== "FREE" && (active !== body.plan || subscription?.cancelAtPeriodEnd)) throw new AppError(409, "CONFLICT", "Change plans after the current period, or resume renewal first");
    const [invoice] = await tx.insert(billingInvoices).values({ businessId, ...plan,
      idempotencyKey: body.idempotencyKey, customerName: tenant.name, issuer: catalog.issuer,
      paymentInstructions: catalog.paymentInstructions }).returning();
    await enqueueOutbox(tx, {
      businessId,
      topic: "invoice.created",
      idempotencyKey: `invoice.created:${invoice.id}`,
      payload: { businessId, id: invoice.id, invoiceId: invoice.id, plan: invoice.plan,
        amountMinor: invoice.amountMinor, currency: invoice.currency, mode: "manual_invoice" },
    });
    return invoice;
  });
}
export async function cancelInvoice(businessId: string, invoiceId: string) {
  assertTenantScope(businessId); z.string().uuid().parse(invoiceId);
  const [invoice] = await db.update(billingInvoices).set({ status: "void" })
    .where(and(eq(billingInvoices.businessId, businessId), eq(billingInvoices.id, invoiceId), eq(billingInvoices.status, "open"))).returning();
  if (!invoice) throw new AppError(409, "CONFLICT", "Only your open invoice can be voided");
  return invoice;
}
export async function setSubscriptionCancellation(businessId: string, cancelAtPeriodEnd: boolean) {
  assertTenantScope(businessId);
  return db.transaction(async (tx) => {
    await tx.select({ id: businesses.id }).from(businesses).where(eq(businesses.id, businessId)).for("update");
    const [subscription] = await tx.update(subscriptions).set({ cancelAtPeriodEnd, updatedAt: new Date() })
      .where(eq(subscriptions.businessId, businessId)).returning();
    if (!subscription) throw new AppError(404, "NOT_FOUND", "No paid subscription exists");
    if (cancelAtPeriodEnd) await tx.update(billingInvoices).set({ status: "void" }).where(and(eq(billingInvoices.businessId, businessId), eq(billingInvoices.status, "open")));
    await enqueueOutbox(tx, {
      businessId,
      topic: "subscription.changed",
      idempotencyKey: `subscription.changed:cancel:${subscription.id}:${subscription.updatedAt.toISOString()}`,
      payload: { businessId, id: subscription.id, plan: subscription.plan,
        change: cancelAtPeriodEnd ? "cancel_at_period_end" : "resume", periodEnd: subscription.periodEnd?.toISOString() ?? null },
    });
    return subscription;
  });
}
export async function listPlatformInvoices(actorId: string) {
  await requirePlatformAdmin(db, actorId);
  return db.select().from(billingInvoices).where(eq(billingInvoices.status, "open")).orderBy(desc(billingInvoices.createdAt)).limit(100);
}
export async function recordInvoicePayment(actorId: string, input: unknown) {
  const body = PaymentSchema.parse(input);
  try {
    return await db.transaction(async (tx) => {
      await requirePlatformAdmin(tx, actorId, true);
      const [tenant] = await tx.select().from(businesses).where(eq(businesses.id, body.businessId)).for("update");
      if (!tenant?.isActive) throw new AppError(409, "CONFLICT", "Tenant is inactive");
      const [invoice] = await tx.select().from(billingInvoices).where(and(eq(billingInvoices.id, body.id), eq(billingInvoices.businessId, body.businessId))).for("update");
      if (!invoice) throw new AppError(404, "NOT_FOUND", "Invoice not found");
      if (invoice.amountMinor !== body.amountMinor || invoice.currency !== body.currency) throw new AppError(409, "CONFLICT", "Payment amount/currency must match the invoice exactly");
      if (invoice.status === "paid" && invoice.paymentReference === body.paymentReference) return invoice;
      if (invoice.status !== "open") throw new AppError(409, "CONFLICT", "Invoice is not open");
      const [subscription] = await tx.select().from(subscriptions).where(eq(subscriptions.businessId, body.businessId));
      const now = new Date(), active = effectivePlan(subscription, now);
      if (active !== "FREE" && (active !== invoice.plan || subscription?.cancelAtPeriodEnd)) throw new AppError(409, "CONFLICT", "Subscription cannot be renewed or switched during this period");
      const extending = active === invoice.plan && subscription?.periodEnd;
      const periodStart = extending ? subscription.periodStart! : now;
      const periodEnd = addCalendarMonth(extending ? subscription.periodEnd! : now);
      await tx.insert(subscriptions).values({ businessId: body.businessId, plan: invoice.plan, periodStart, periodEnd })
        .onConflictDoUpdate({ target: subscriptions.businessId, set: { plan: invoice.plan, periodStart, periodEnd, cancelAtPeriodEnd: false, updatedAt: now } });
      const [paid] = await tx.update(billingInvoices).set({ status: "paid", paidAt: now, paymentReference: body.paymentReference }).where(eq(billingInvoices.id, invoice.id)).returning();
      await enqueueOutbox(tx, {
        businessId: body.businessId,
        topic: "payment.received",
        idempotencyKey: `payment.received:${invoice.id}`,
        payload: { businessId: body.businessId, id: invoice.id, invoiceId: invoice.id, plan: invoice.plan,
          amountMinor: invoice.amountMinor, currency: invoice.currency, paymentReference: body.paymentReference,
          mode: "manual_invoice", actorId },
      });
      await enqueueOutbox(tx, {
        businessId: body.businessId,
        topic: "subscription.changed",
        idempotencyKey: `subscription.changed:${invoice.id}`,
        payload: { businessId: body.businessId, id: invoice.id, plan: invoice.plan, change: "renewed",
          periodStart: periodStart.toISOString(), periodEnd: periodEnd.toISOString() },
      });
      await tx.insert(auditLogs).values({ businessId: body.businessId, actorType: "platform_admin", actorId,
        action: "billing.payment_recorded", entityType: "invoice", entityId: invoice.id, requestId: requestContext.getStore()?.requestId,
        metadata: { amountMinor: invoice.amountMinor, currency: invoice.currency, paymentReference: body.paymentReference, periodEnd: periodEnd.toISOString() } });
      return paid;
    });
  } catch (error) { mapUniqueViolation(error, { billing_invoices_payment_reference: { code: "CONFLICT", message: "Payment reference already assigned to an invoice" } }); }
}

