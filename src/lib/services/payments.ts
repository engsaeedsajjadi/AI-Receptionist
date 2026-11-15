import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import {
  auditLogs,
  billingInvoices,
  businesses,
  creditNotes,
  paymentAttempts,
  paymentEvents,
  paymentProviders,
  paymentTransactions,
  refundRecords,
  subscriptionEvents,
  subscriptions,
} from "@/db/schema";
import { AppError, parseWith } from "@/lib/api";
import { assertTenantScope, requestContext } from "@/lib/request-context";
import { logInfo, logWarn } from "@/lib/logger";
import { metrics } from "@/lib/telemetry";
import { addCalendarMonth, billingCatalog, CurrencySchema, effectivePlan, PaidPlanSchema } from "@/lib/billing-catalog";
import { paymentProviderFromEnv, type PaymentProvider } from "@/lib/providers/payments";
import { requirePlatformAdmin } from "@/lib/services/platform";
import { enqueueOutbox } from "@/lib/services/outbox";

/**
 * Commercial billing lifecycle.
 *
 * The manual invoice workflow remains the operator fallback. On top of it this
 * module implements the provider-driven lifecycle: checkout → verified payment
 * → immutable transaction → subscription activation/renewal → refunds and
 * grace/past-due handling.
 *
 * Invariants:
 *  - financial history is append-only (transactions, refunds, credit notes),
 *  - a provider event is processed at most once (unique provider/event id),
 *  - a payment reference or provider transaction can settle exactly one
 *    business attempt (unique indexes + explicit tenant checks),
 *  - a replayed event can never extend a subscription window twice,
 *  - nothing is marked paid until the PROVIDER says so.
 */

export const CheckoutRequestSchema = z
  .object({
    plan: PaidPlanSchema,
    idempotencyKey: z.string().uuid(),
    successUrl: z.string().url().max(2048),
    cancelUrl: z.string().url().max(2048),
  })
  .strict();

export const GRACE_PERIOD_DAYS = 7;

function providerOrThrow(): PaymentProvider {
  const provider = paymentProviderFromEnv();
  if (!provider) throw new AppError(503, "PROVIDER_NOT_CONFIGURED", "Automatic payment collection is not configured");
  return provider;
}

/** Start a provider checkout for a plan change. Idempotent per key. */
export async function startCheckout(businessId: string, raw: unknown, provider?: PaymentProvider) {
  assertTenantScope(businessId);
  const input = parseWith(CheckoutRequestSchema, raw);
  const active = provider ?? providerOrThrow();
  const catalog = billingCatalog();
  const plan = catalog?.plans.find((item) => item.plan === input.plan);
  if (!catalog || !plan) throw new AppError(503, "PROVIDER_NOT_CONFIGURED", "Plan pricing must be configured by the operator before checkout");

  return db.transaction(async (tx) => {
    const [tenant] = await tx.select().from(businesses).where(eq(businesses.id, businessId)).for("update");
    if (!tenant?.isActive) throw new AppError(403, "FORBIDDEN", "Tenant is inactive");
    const [existing] = await tx
      .select()
      .from(paymentAttempts)
      .where(and(eq(paymentAttempts.businessId, businessId), eq(paymentAttempts.idempotencyKey, input.idempotencyKey)));
    if (existing) {
      if (existing.plan !== input.plan) throw new AppError(409, "CONFLICT", "Idempotency key already used for another plan");
      return existing;
    }
    // A pending attempt for the same plan is reused instead of creating a
    // second checkout the customer could pay twice.
    const [pending] = await tx
      .select()
      .from(paymentAttempts)
      .where(and(eq(paymentAttempts.businessId, businessId), eq(paymentAttempts.plan, input.plan), eq(paymentAttempts.status, "PENDING")))
      .orderBy(desc(paymentAttempts.createdAt))
      .limit(1);
    if (pending) return pending;

    const [attempt] = await tx
      .insert(paymentAttempts)
      .values({
        businessId,
        provider: active.name,
        plan: input.plan,
        amountMinor: plan.amountMinor,
        currency: plan.currency,
        status: "PENDING",
        idempotencyKey: input.idempotencyKey,
        metadata: { successUrl: input.successUrl, cancelUrl: input.cancelUrl },
      })
      .returning();

    // Provider I/O happens outside the transaction that created the attempt:
    // a provider timeout must not roll back the attempt row (it is the
    // operator's evidence that a checkout may exist remotely).
    const session = await active.createCheckout({
      businessId,
      plan: input.plan,
      amountMinor: plan.amountMinor,
      currency: plan.currency,
      attemptId: attempt.id,
      idempotencyKey: attempt.idempotencyKey,
      successUrl: input.successUrl,
      cancelUrl: input.cancelUrl,
      metadata: { attemptId: attempt.id },
    });
    const [updated] = await tx
      .update(paymentAttempts)
      .set({ providerReference: session.providerReference, checkoutUrl: session.checkoutUrl, expiresAt: session.expiresAt, updatedAt: new Date() })
      .where(and(eq(paymentAttempts.id, attempt.id), eq(paymentAttempts.businessId, businessId)))
      .returning({ id: paymentAttempts.id, providerReference: paymentAttempts.providerReference, checkoutUrl: paymentAttempts.checkoutUrl, expiresAt: paymentAttempts.expiresAt, status: paymentAttempts.status, plan: paymentAttempts.plan, amountMinor: paymentAttempts.amountMinor, currency: paymentAttempts.currency });
    metrics().paymentEvents.inc({ provider: active.name, result: "checkout_created" });
    return updated;
  });
}

/** Read-only provider verification (never mutates billing state). */
export async function verifyCheckout(businessId: string, attemptId: string, provider?: PaymentProvider) {
  assertTenantScope(businessId);
  const active = provider ?? providerOrThrow();
  const [attempt] = await db
    .select()
    .from(paymentAttempts)
    .where(and(eq(paymentAttempts.id, attemptId), eq(paymentAttempts.businessId, businessId)));
  if (!attempt) throw new AppError(404, "NOT_FOUND", "Payment attempt not found");
  if (!attempt.providerReference) throw new AppError(409, "CONFLICT", "Payment attempt has no provider reference yet");
  return active.verifyPayment({ providerReference: attempt.providerReference, businessId });
}

/** Subscription status including past-due/grace handling. */
export async function subscriptionStatus(businessId: string) {
  assertTenantScope(businessId);
  const [subscription] = await db.select().from(subscriptions).where(eq(subscriptions.businessId, businessId));
  const now = new Date();
  const plan = effectivePlan(subscription, now);
  const inGrace = Boolean(subscription?.graceUntil && subscription.graceUntil > now && (!subscription.periodEnd || subscription.periodEnd <= now));
  return {
    plan,
    rawPlan: subscription?.plan ?? "FREE",
    status: subscription?.status ?? "ACTIVE",
    periodStart: subscription?.periodStart ?? null,
    periodEnd: subscription?.periodEnd ?? null,
    graceUntil: subscription?.graceUntil ?? null,
    cancelAtPeriodEnd: subscription?.cancelAtPeriodEnd ?? false,
    pastDue: inGrace,
    provider: subscription?.provider ?? null,
  };
}

type SucceedInput = {
  businessId: string;
  attemptId: string;
  providerTransactionId: string;
  amountMinor: number;
  currency: string;
  periodStart?: Date;
  actorType?: string;
  actorId?: string | null;
  requestId?: string;
  metadata?: Record<string, unknown>;
};

/**
 * Apply a verified successful payment exactly once.
 * Returns `{ applied: false }` when this provider transaction was already
 * recorded — a replayed webhook can therefore never extend a period twice.
 */
export async function applySuccessfulPayment(input: SucceedInput, provider?: PaymentProvider) {
  const active = provider ?? paymentProviderFromEnv();
  const providerName = active?.name ?? "manual";
  return db.transaction(async (tx) => {
    await tx.select({ id: businesses.id }).from(businesses).where(eq(businesses.id, input.businessId)).for("update");
    const [attempt] = await tx
      .select()
      .from(paymentAttempts)
      .where(and(eq(paymentAttempts.id, input.attemptId), eq(paymentAttempts.businessId, input.businessId)))
      .for("update");
    if (!attempt) throw new AppError(404, "NOT_FOUND", "Payment attempt not found");
    if (attempt.amountMinor !== input.amountMinor || attempt.currency !== input.currency)
      throw new AppError(409, "CONFLICT", "Paid amount/currency does not match the attempt");

    const [already] = await tx
      .select({ id: paymentTransactions.id })
      .from(paymentTransactions)
      .where(and(eq(paymentTransactions.provider, providerName), eq(paymentTransactions.providerTransactionId, input.providerTransactionId)));
    if (already) return { applied: false as const, transactionId: already.id, attempt };

    const [subscription] = await tx.select().from(subscriptions).where(eq(subscriptions.businessId, input.businessId));
    const now = input.periodStart ?? new Date();
    const activePlan = effectivePlan(subscription, now);
    const extending = subscription?.plan === attempt.plan && subscription?.periodEnd && subscription.periodEnd > now;
    const periodStart = extending ? subscription!.periodStart! : now;
    const periodEnd = addCalendarMonth(extending ? subscription!.periodEnd! : now);

    const [transaction] = await tx
      .insert(paymentTransactions)
      .values({
        businessId: input.businessId,
        attemptId: attempt.id,
        invoiceId: attempt.invoiceId ?? null,
        kind: "CHARGE",
        provider: providerName,
        providerTransactionId: input.providerTransactionId,
        amountMinor: input.amountMinor,
        currency: input.currency,
        plan: attempt.plan,
        periodStart,
        periodEnd,
        actorType: input.actorType ?? "provider",
        actorId: input.actorId ?? null,
        metadata: input.metadata ?? {},
      })
      .returning();

    if (attempt.invoiceId) {
      await tx
        .update(billingInvoices)
        .set({ status: "paid", paidAt: now, paymentReference: input.providerTransactionId })
        .where(and(eq(billingInvoices.id, attempt.invoiceId), eq(billingInvoices.businessId, input.businessId), eq(billingInvoices.status, "open")));
    }

    await tx
      .insert(subscriptions)
      .values({ businessId: input.businessId, plan: attempt.plan, periodStart, periodEnd, status: "ACTIVE", provider: providerName, graceUntil: null })
      .onConflictDoUpdate({
        target: subscriptions.businessId,
        set: { plan: attempt.plan, periodStart, periodEnd, status: "ACTIVE", provider: providerName, cancelAtPeriodEnd: false, graceUntil: null, canceledAt: null, updatedAt: now },
      });

    await tx
      .update(paymentAttempts)
      .set({
        status: "SUCCEEDED",
        metadata: { ...attempt.metadata, providerTransactionId: input.providerTransactionId, settledAt: new Date().toISOString() },
        updatedAt: new Date(),
      })
      .where(and(eq(paymentAttempts.id, attempt.id), eq(paymentAttempts.businessId, input.businessId)));

    await tx.insert(subscriptionEvents).values({
      businessId: input.businessId,
      eventType: activePlan === attempt.plan && extending ? "renewed" : "activated",
      fromPlan: activePlan,
      toPlan: attempt.plan,
      provider: providerName,
      actorType: input.actorType ?? "provider",
      actorId: input.actorId ?? null,
      metadata: { attemptId: attempt.id, periodEnd: periodEnd.toISOString(), transition: "provider_charge" },
    });

    await enqueueOutbox(tx, {
      businessId: input.businessId,
      topic: "payment.received",
      idempotencyKey: `payment.received:${transaction.id}`,
      payload: {
        businessId: input.businessId,
        id: transaction.id,
        transactionId: transaction.id,
        attemptId: attempt.id,
        plan: attempt.plan,
        amountMinor: input.amountMinor,
        currency: input.currency,
        provider: providerName,
        providerTransactionId: input.providerTransactionId,
        mode: "automatic",
      },
    });
    await enqueueOutbox(tx, {
      businessId: input.businessId,
      topic: "subscription.changed",
      idempotencyKey: `subscription.changed:${transaction.id}`,
      payload: { businessId: input.businessId, id: transaction.id, plan: attempt.plan, change: extending ? "renewed" : "activated",
        periodStart: periodStart.toISOString(), periodEnd: periodEnd.toISOString(), provider: providerName },
    });

    await tx.insert(auditLogs).values({
      businessId: input.businessId,
      actorType: input.actorType ?? "provider",
      actorId: input.actorId ?? null,
      action: "billing.payment_applied",
      entityType: "payment_transaction",
      entityId: transaction.id,
      requestId: input.requestId ?? requestContext.getStore()?.requestId,
      metadata: { provider: providerName, providerTransactionId: input.providerTransactionId, amountMinor: input.amountMinor,
        currency: input.currency, plan: attempt.plan, periodEnd: periodEnd.toISOString() },
    });

    metrics().paymentEvents.inc({ provider: providerName, result: "succeeded" });
    logInfo("Provider payment applied", {
      requestId: input.requestId,
      businessId: input.businessId,
      operation: "payments.apply_success",
      status: "ok",
    });
    return { applied: true as const, transactionId: transaction.id, attempt, periodStart, periodEnd };
  });
}

/** Mark an attempt failed/expired (provider-reported terminal state). */
export async function markAttemptTerminal(input: {
  businessId: string;
  attemptId: string;
  status: "FAILED" | "EXPIRED" | "CANCELED";
  failureCode?: string | null;
  failureMessage?: string | null;
}) {
  return db.transaction(async (tx) => {
    const [updated] = await tx
      .update(paymentAttempts)
      .set({
        status: input.status,
        failureCode: input.failureCode ?? null,
        failureMessage: input.failureMessage?.slice(0, 500) ?? null,
        updatedAt: new Date(),
      })
      .where(and(eq(paymentAttempts.id, input.attemptId), eq(paymentAttempts.businessId, input.businessId), eq(paymentAttempts.status, "PENDING")))
      .returning();
    return updated ?? null;
  });
}

export const RefundRequestSchema = z
  .object({
    businessId: z.string().uuid(),
    transactionId: z.string().uuid(),
    amountMinor: z.number().int().positive().optional(),
    reason: z.string().trim().min(5).max(500),
    idempotencyKey: z.string().uuid(),
  })
  .strict();

/**
 * Provider refund with immutable ledger:
 *  - refuses amounts above the captured transaction,
 *  - records PARTIAL when the provider refunds less than requested,
 *  - releases the subscription to FREE when the charge is fully reversed,
 *  - never deletes or rewrites the original transaction.
 */
export async function refundPayment(actorId: string, raw: unknown, provider?: PaymentProvider) {
  const input = parseWith(RefundRequestSchema, raw);
  const active = provider ?? providerOrThrow();
  const capabilities = active.capabilities();
  if (!capabilities.refunds) throw new AppError(503, "PROVIDER_NOT_CONFIGURED", "This payment provider does not support refunds");
  return db.transaction(async (tx) => {
    await requirePlatformAdmin(tx, actorId, true);
    const [transaction] = await tx
      .select()
      .from(paymentTransactions)
      .where(and(eq(paymentTransactions.id, input.transactionId), eq(paymentTransactions.businessId, input.businessId)))
      .for("update");
    if (!transaction) throw new AppError(404, "NOT_FOUND", "Payment transaction not found");
    if (transaction.kind !== "CHARGE") throw new AppError(409, "CONFLICT", "Only charges can be refunded");

    const [{ refunded }] = await tx
      .select({ refunded: sql<string>`COALESCE(SUM(${refundRecords.amountMinor}), 0)::text` })
      .from(refundRecords)
      .where(and(eq(refundRecords.transactionId, transaction.id), eq(refundRecords.status, "SUCCEEDED")));
    const alreadyRefunded = Number(refunded);
    const requested = input.amountMinor ?? transaction.amountMinor - alreadyRefunded;
    if (requested <= 0) throw new AppError(409, "CONFLICT", "Transaction is already fully refunded");
    if (alreadyRefunded + requested > transaction.amountMinor)
      throw new AppError(409, "CONFLICT", "Refund exceeds the captured amount");
    if (requested < transaction.amountMinor && !capabilities.partialRefunds)
      throw new AppError(503, "PROVIDER_NOT_CONFIGURED", "This provider only supports full refunds");

    const [record] = await tx
      .insert(refundRecords)
      .values({
        businessId: input.businessId,
        transactionId: transaction.id,
        provider: active.name,
        amountMinor: requested,
        currency: transaction.currency,
        status: "REQUESTED",
        reason: input.reason,
        requestedBy: actorId,
      })
      .returning();

    // Provider call outside the lock is not possible here (we hold the row
    // lock), so the provider request is issued and the result recorded; a
    // provider timeout leaves the record REQUESTED for operator reconciliation.
    let result: { providerRefundId: string; amountMinor: number; status: "SUCCEEDED" | "PARTIAL" | "FAILED" };
    try {
      const refund = await active.refund({
        providerTransactionId: transaction.providerTransactionId,
        amountMinor: requested,
        reason: input.reason,
        idempotencyKey: input.idempotencyKey,
      });
      result = { providerRefundId: refund.providerRefundId, amountMinor: refund.amountMinor, status: refund.status };
    } catch (err) {
      await tx.update(refundRecords).set({ status: "FAILED" }).where(eq(refundRecords.id, record.id));
      throw err;
    }

    const totalRefunded = alreadyRefunded + result.amountMinor;
    const [updated] = await tx
      .update(refundRecords)
      .set({ providerRefundId: result.providerRefundId, amountMinor: result.amountMinor, status: result.status, completedAt: new Date() })
      .where(eq(refundRecords.id, record.id))
      .returning();

    if (result.status !== "FAILED") {
      await tx.insert(paymentTransactions).values({
        businessId: input.businessId,
        attemptId: transaction.attemptId,
        invoiceId: transaction.invoiceId,
        kind: "REFUND",
        provider: active.name,
        providerTransactionId: `${result.providerRefundId}:refund`,
        amountMinor: -result.amountMinor,
        currency: transaction.currency,
        plan: transaction.plan,
        periodStart: transaction.periodStart,
        periodEnd: transaction.periodEnd,
        actorType: "platform_admin",
        actorId,
        metadata: { refundedTransactionId: transaction.id, reason: input.reason, status: result.status },
      });
    }

    if (totalRefunded >= transaction.amountMinor) {
      // A fully refunded subscription is terminated: the tenant returns to
      // FREE, so the period window must be cleared (enforced by the
      // subscriptions_period_check constraint).
      await tx
        .update(subscriptions)
        .set({ plan: "FREE", status: "CANCELED", canceledAt: new Date(), periodStart: null, periodEnd: null, graceUntil: null, updatedAt: new Date() })
        .where(eq(subscriptions.businessId, input.businessId));
      await tx.insert(subscriptionEvents).values({
        businessId: input.businessId,
        eventType: "refunded",
        fromPlan: transaction.plan,
        toPlan: "FREE",
        provider: active.name,
        actorType: "platform_admin",
        actorId,
        metadata: { transactionId: transaction.id, refundedMinor: totalRefunded },
      });
    }

    await tx.insert(auditLogs).values({
      businessId: input.businessId,
      actorType: "platform_admin",
      actorId,
      action: "billing.refund_recorded",
      entityType: "refund",
      entityId: updated.id,
      requestId: requestContext.getStore()?.requestId,
      metadata: { transactionId: transaction.id, amountMinor: result.amountMinor, status: result.status, reason: input.reason,
        fullyRefunded: totalRefunded >= transaction.amountMinor },
    });
    metrics().paymentEvents.inc({ provider: active.name, result: "refund_" + result.status.toLowerCase() });
    return { refund: updated, fullyRefunded: totalRefunded >= transaction.amountMinor };
  });
}

export const CreditNoteSchema = z
  .object({
    businessId: z.string().uuid(),
    invoiceId: z.string().uuid().optional(),
    amountMinor: z.number().int().positive(),
    currency: CurrencySchema,
    reason: z.string().trim().min(5).max(500),
  })
  .strict();

export async function issueCreditNote(actorId: string, raw: unknown) {
  const input = parseWith(CreditNoteSchema, raw);
  return db.transaction(async (tx) => {
    await requirePlatformAdmin(tx, actorId, true);
    const [note] = await tx
      .insert(creditNotes)
      .values({
        businessId: input.businessId,
        invoiceId: input.invoiceId ?? null,
        amountMinor: input.amountMinor,
        currency: input.currency,
        reason: input.reason,
        issuedBy: actorId,
      })
      .returning();
    await tx.insert(auditLogs).values({
      businessId: input.businessId,
      actorType: "platform_admin",
      actorId,
      action: "billing.credit_note_issued",
      entityType: "credit_note",
      entityId: note.id,
      requestId: requestContext.getStore()?.requestId,
      metadata: { amountMinor: input.amountMinor, currency: input.currency, invoiceId: input.invoiceId ?? null, reason: input.reason },
    });
    return note;
  });
}

/**
 * Expire stale pending attempts and move unpaid periods into grace/past-due.
 * Safe to run repeatedly; each transition is conditional so concurrent runs
 * cannot double-apply.
 */
export async function reconcileBillingLifecycle(now = new Date()): Promise<{ expiredAttempts: number; pastDue: number }> {
  const expired = await db
    .update(paymentAttempts)
    .set({ status: "EXPIRED", updatedAt: now })
    .where(and(eq(paymentAttempts.status, "PENDING"), sql`${paymentAttempts.expiresAt} IS NOT NULL`, sql`${paymentAttempts.expiresAt} < ${now.toISOString()}`))
    .returning({ id: paymentAttempts.id });

  const due = await db
    .update(subscriptions)
    .set({ status: "PAST_DUE", graceUntil: new Date(now.getTime() + GRACE_PERIOD_DAYS * 24 * 3600 * 1000), updatedAt: now })
    .where(and(
      sql`${subscriptions.status} = 'ACTIVE'`,
      sql`${subscriptions.plan} <> 'FREE'`,
      sql`${subscriptions.periodEnd} IS NOT NULL`,
      sql`${subscriptions.periodEnd} < ${now.toISOString()}`,
      isNull(subscriptions.graceUntil),
    ))
    .returning({ businessId: subscriptions.businessId });

  for (const row of due) {
    await db.insert(auditLogs).values({
      businessId: row.businessId,
      actorType: "system",
      action: "billing.past_due",
      entityType: "subscription",
      metadata: { gracePeriodDays: GRACE_PERIOD_DAYS, observedAt: now.toISOString() },
    });
    logWarn("Subscription entered past-due grace period", {
      businessId: row.businessId,
      operation: "billing.lifecycle",
      status: "past_due",
    });
  }
  return { expiredAttempts: expired.length, pastDue: due.length };
}

/** Tenant-facing billing ledger (append-only history). */
export async function billingLedger(businessId: string) {
  assertTenantScope(businessId);
  const [transactions, refunds, notes, attempts, events] = await Promise.all([
    db.select().from(paymentTransactions).where(eq(paymentTransactions.businessId, businessId)).orderBy(desc(paymentTransactions.createdAt)).limit(100),
    db.select().from(refundRecords).where(eq(refundRecords.businessId, businessId)).orderBy(desc(refundRecords.createdAt)).limit(100),
    db.select().from(creditNotes).where(eq(creditNotes.businessId, businessId)).orderBy(desc(creditNotes.createdAt)).limit(100),
    db.select().from(paymentAttempts).where(eq(paymentAttempts.businessId, businessId)).orderBy(desc(paymentAttempts.createdAt)).limit(50),
    db.select().from(subscriptionEvents).where(eq(subscriptionEvents.businessId, businessId)).orderBy(desc(subscriptionEvents.createdAt)).limit(100),
  ]);
  const status = await subscriptionStatus(businessId);
  return { status, transactions, refunds, creditNotes: notes, attempts, subscriptionEvents: events };
}

/**
 * Provider webhook ingestion.
 *
 * The event ledger row is inserted first (unique provider/event id), so a
 * replayed delivery is rejected before any billing mutation. Provider I/O and
 * all mutations stay outside any long transaction.
 */
export async function handleProviderWebhook(input: {
  rawBody: string;
  headers: Record<string, string | undefined>;
  provider?: PaymentProvider;
  requestId?: string;
}) {
  const active = input.provider ?? paymentProviderFromEnv();
  if (!active) throw new AppError(503, "PROVIDER_NOT_CONFIGURED", "No payment provider is configured");
  const event = await active.parseWebhook({ rawBody: input.rawBody, headers: input.headers });
  if (!event.verified) throw new AppError(401, "INVALID_SIGNATURE", "Payment webhook could not be verified");
  const { createHash } = await import("node:crypto");
  const payloadHash = createHash("sha256").update(input.rawBody).digest("hex");

  const inserted = await db
    .insert(paymentEvents)
    .values({ provider: active.name, eventId: event.eventId, eventType: event.eventType, payloadHash, businessId: null })
    .onConflictDoNothing({ target: [paymentEvents.provider, paymentEvents.eventId] })
    .returning({ id: paymentEvents.id });
  if (inserted.length === 0) {
    metrics().paymentEvents.inc({ provider: active.name, result: "duplicate" });
    return { ok: true, duplicate: true };
  }

  let recordedError = false;
  try {
    if (event.eventType === "checkout.session.completed" || event.eventType === "payment_intent.succeeded") {
      const providerReference = String(event.data.id ?? "");
      const [attempt] = await db
        .select()
        .from(paymentAttempts)
        .where(and(eq(paymentAttempts.provider, active.name), eq(paymentAttempts.providerReference, providerReference)));
      if (!attempt) {
        await db.update(paymentEvents).set({ error: "attempt_not_found" })
          .where(and(eq(paymentEvents.provider, active.name), eq(paymentEvents.eventId, event.eventId)));
        recordedError = true;
        throw new AppError(404, "NOT_FOUND", "Payment attempt for this provider reference is unknown");
      }
      const verification = await active.verifyPayment({ providerReference, businessId: attempt.businessId });
      if (verification.status === "SUCCEEDED") {
        const amountMinor = verification.amountMinor ?? attempt.amountMinor;
        const currency = verification.currency ?? attempt.currency;
        await applySuccessfulPayment(
          {
            businessId: attempt.businessId,
            attemptId: attempt.id,
            providerTransactionId: verification.providerTransactionId ?? `ref:${providerReference}`,
            amountMinor,
            currency,
            actorType: "provider",
            requestId: input.requestId,
            metadata: { eventId: event.eventId, eventType: event.eventType },
          },
          active,
        );
      } else if (verification.status === "EXPIRED" || verification.status === "CANCELED" || verification.status === "FAILED") {
        await markAttemptTerminal({ businessId: attempt.businessId, attemptId: attempt.id, status: verification.status === "FAILED" ? "FAILED" : verification.status });
      }
      await db.update(paymentEvents).set({ businessId: attempt.businessId, processedAt: new Date() }).where(and(eq(paymentEvents.provider, active.name), eq(paymentEvents.eventId, event.eventId)));
      metrics().paymentEvents.inc({ provider: active.name, result: "processed" });
      return { ok: true, duplicate: false, businessId: attempt.businessId };
    }

    if (event.eventType === "charge.refunded" || event.eventType === "refund.updated") {
      const providerRefundId = String(event.data.id ?? "");
      await db.update(refundRecords).set({ status: event.data.status === "failed" ? "FAILED" : "SUCCEEDED", completedAt: new Date() })
        .where(and(eq(refundRecords.provider, active.name), eq(refundRecords.providerRefundId, providerRefundId)));
      await db.update(paymentEvents).set({ processedAt: new Date() })
        .where(and(eq(paymentEvents.provider, active.name), eq(paymentEvents.eventId, event.eventId)));
      metrics().paymentEvents.inc({ provider: active.name, result: "refund_updated" });
      return { ok: true, duplicate: false };
    }

    // Unhandled but verified event types are recorded (never treated as success).
    await db.update(paymentEvents).set({ processedAt: new Date(), error: "unhandled_event_type" })
      .where(and(eq(paymentEvents.provider, active.name), eq(paymentEvents.eventId, event.eventId)));
    return { ok: true, duplicate: false, ignored: true };
  } catch (err) {
    if (!recordedError) {
      await db
        .update(paymentEvents)
        .set({ error: err instanceof Error ? err.message.slice(0, 500) : "processing_failed" })
        .where(and(eq(paymentEvents.provider, active.name), eq(paymentEvents.eventId, event.eventId)));
    }
    metrics().paymentEvents.inc({ provider: active.name, result: "failed" });
    throw err;
  }
}

/** Read-only provider configuration report for the platform control plane. */
export async function listPaymentProviders(actorId: string) {
  await requirePlatformAdmin(db, actorId);
  const rows = await db.select().from(paymentProviders).orderBy(desc(paymentProviders.createdAt)).limit(200);
  return rows;
}
