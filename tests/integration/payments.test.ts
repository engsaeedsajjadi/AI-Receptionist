import { afterAll, beforeAll, describe, expect, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db, closeDb } from "@/db";
import {
  billingInvoices,
  creditNotes,
  outboxEvents,
  paymentAttempts,
  paymentEvents,
  paymentTransactions,
  refundRecords,
  subscriptionEvents,
  subscriptions,
  users,
} from "@/db/schema";
import { requestInvoice } from "@/lib/services/billing";
import {
  applySuccessfulPayment,
  billingLedger,
  GRACE_PERIOD_DAYS,
  handleProviderWebhook,
  issueCreditNote,
  listPaymentProviders,
  markAttemptTerminal,
  reconcileBillingLifecycle,
  refundPayment,
  startCheckout,
  subscriptionStatus,
  verifyCheckout,
} from "@/lib/services/payments";
import { paymentProviderStatus, TestPaymentProvider } from "@/lib/providers/payments";
import { resetEnvCache } from "@/lib/env";
import { createBusiness, createUser } from "../helpers/fixtures";
import { ensureDbReady, hasTestDatabase, itDb, truncateAll } from "../helpers/db";

const catalog = {
  issuer: "Synthetic Test Issuer",
  paymentInstructions: "Test fixture only, no real payment account",
  plans: [
    { plan: "STARTER", amountMinor: 1234, currency: "USD" },
    { plan: "BUSINESS", amountMinor: 4567, currency: "USD" },
  ],
};

async function platformAdmin() {
  const business = await createBusiness();
  const { user } = await createUser(business.id);
  await db.update(users).set({ role: "SUPER_ADMIN", mfaEnabled: true }).where(eq(users.id, user.id));
  return { business, user };
}

async function tenant() {
  const business = await createBusiness();
  const { user } = await createUser(business.id);
  await db.update(users).set({ role: "ADMIN" }).where(eq(users.id, user.id));
  return { business, user };
}

describe.skipIf(!hasTestDatabase())("commercial billing: provider lifecycle", () => {
  beforeAll(async () => {
    await ensureDbReady();
    await truncateAll();
    vi.stubEnv("BILLING_CATALOG_JSON", JSON.stringify(catalog));
  });
  afterAll(async () => {
    vi.unstubAllEnvs();
    await truncateAll();
    await closeDb();
  });

  itDb("creates a checkout idempotently and reuses a pending attempt instead of double-charging", async () => {
    const a = await tenant();
    const provider = new TestPaymentProvider();
    const key = crypto.randomUUID();
    const first = await startCheckout(a.business.id, { plan: "STARTER", idempotencyKey: key, successUrl: "https://app.test/ok", cancelUrl: "https://app.test/no" }, provider);
    expect(first.status).toBe("PENDING");
    expect(first.checkoutUrl).toContain("payments.example.test");

    // Same idempotency key → the very same attempt, no second provider checkout.
    const replay = await startCheckout(a.business.id, { plan: "STARTER", idempotencyKey: key, successUrl: "https://app.test/ok", cancelUrl: "https://app.test/no" }, provider);
    expect(replay.id).toBe(first.id);
    const rows = await db.select().from(paymentAttempts).where(eq(paymentAttempts.businessId, a.business.id));
    expect(rows).toHaveLength(1);

    // A different key for the same plan still reuses the pending attempt.
    const second = await startCheckout(a.business.id, { plan: "STARTER", idempotencyKey: crypto.randomUUID(), successUrl: "https://app.test/ok", cancelUrl: "https://app.test/no" }, provider);
    expect(second.id).toBe(first.id);

    // Same key with a different plan is a conflict, never a silent switch.
    await expect(
      startCheckout(a.business.id, { plan: "BUSINESS", idempotencyKey: key, successUrl: "https://app.test/ok", cancelUrl: "https://app.test/no" }, provider),
    ).rejects.toMatchObject({ status: 409 });
  });

  itDb("applies a verified payment exactly once and never extends a period twice", async () => {
    const a = await tenant();
    const provider = new TestPaymentProvider();
    const attempt = await startCheckout(a.business.id, { plan: "STARTER", idempotencyKey: crypto.randomUUID(), successUrl: "https://app.test/ok", cancelUrl: "https://app.test/no" }, provider);
    provider.settle(attempt.providerReference!, "SUCCEEDED");
    const verification = await verifyCheckout(a.business.id, attempt.id, provider);
    expect(verification.status).toBe("SUCCEEDED");

    const applied = await applySuccessfulPayment(
      {
        businessId: a.business.id,
        attemptId: attempt.id,
        providerTransactionId: "txn-synthetic-1",
        amountMinor: 1234,
        currency: "USD",
      },
      provider,
    );
    expect(applied.applied).toBe(true);
    const status = await subscriptionStatus(a.business.id);
    expect(status.plan).toBe("STARTER");
    expect(status.periodEnd!.getTime()).toBeGreaterThan(Date.now());

    // Replaying the provider transaction is a no-op: same period end, one row.
    const replay = await applySuccessfulPayment(
      {
        businessId: a.business.id,
        attemptId: attempt.id,
        providerTransactionId: "txn-synthetic-1",
        amountMinor: 1234,
        currency: "USD",
      },
      provider,
    );
    expect(replay.applied).toBe(false);
    const after = await subscriptionStatus(a.business.id);
    expect(after.periodEnd!.getTime()).toBe(status.periodEnd!.getTime());
    const transactions = await db.select().from(paymentTransactions).where(eq(paymentTransactions.businessId, a.business.id));
    expect(transactions).toHaveLength(1);
    expect((await db.select().from(subscriptionEvents).where(eq(subscriptionEvents.businessId, a.business.id))).length).toBe(1);

    // Outbox events are written in the same transaction as the state change.
    const outbox = await db.select().from(outboxEvents).where(eq(outboxEvents.businessId, a.business.id));
    expect(outbox.map((row) => row.topic).sort()).toEqual(["payment.received", "subscription.changed"]);
  });

  itDb("rejects amount/currency mismatches, unknown attempts and cross-tenant settlement", async () => {
    const a = await tenant();
    const b = await tenant();
    const provider = new TestPaymentProvider();
    const attempt = await startCheckout(a.business.id, { plan: "STARTER", idempotencyKey: crypto.randomUUID(), successUrl: "https://app.test/ok", cancelUrl: "https://app.test/no" }, provider);
    await expect(
      applySuccessfulPayment(
        { businessId: a.business.id, attemptId: attempt.id, providerTransactionId: "txn-x", amountMinor: 999, currency: "USD" },
        provider,
      ),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      applySuccessfulPayment(
        { businessId: b.business.id, attemptId: attempt.id, providerTransactionId: "txn-y", amountMinor: 1234, currency: "USD" },
        provider,
      ),
    ).rejects.toMatchObject({ status: 404 });
    await expect(verifyCheckout(b.business.id, attempt.id, provider)).rejects.toMatchObject({ status: 404 });
    expect((await billingLedger(b.business.id)).transactions).toHaveLength(0);
  });

  itDb("records failures, expires stale attempts and moves unpaid periods into grace", async () => {
    const a = await tenant();
    const provider = new TestPaymentProvider();
    const attempt = await startCheckout(a.business.id, { plan: "STARTER", idempotencyKey: crypto.randomUUID(), successUrl: "https://app.test/ok", cancelUrl: "https://app.test/no" }, provider);
    const failed = await markAttemptTerminal({ businessId: a.business.id, attemptId: attempt.id, status: "FAILED", failureCode: "card_declined", failureMessage: "x".repeat(900) });
    expect(failed?.status).toBe("FAILED");
    expect(failed?.failureMessage!.length).toBe(500);
    expect(await markAttemptTerminal({ businessId: a.business.id, attemptId: attempt.id, status: "EXPIRED" })).toBeNull();

    const stale = await startCheckout(a.business.id, { plan: "STARTER", idempotencyKey: crypto.randomUUID(), successUrl: "https://app.test/ok", cancelUrl: "https://app.test/no" }, provider);
    await db.update(paymentAttempts).set({ expiresAt: new Date(Date.now() - 60_000) }).where(eq(paymentAttempts.id, stale.id));
    await db
      .insert(subscriptions)
      .values({ businessId: a.business.id, plan: "STARTER", status: "ACTIVE", periodStart: new Date("2020-01-01Z"), periodEnd: new Date("2020-02-01Z"), graceUntil: null })
      .onConflictDoUpdate({
        target: subscriptions.businessId,
        set: { plan: "STARTER", status: "ACTIVE", periodStart: new Date("2020-01-01Z"), periodEnd: new Date("2020-02-01Z"), graceUntil: null },
      });
    const result = await reconcileBillingLifecycle();
    expect(result.expiredAttempts).toBeGreaterThanOrEqual(1);
    expect(result.pastDue).toBeGreaterThanOrEqual(1);
    const status = await subscriptionStatus(a.business.id);
    expect(status.status).toBe("PAST_DUE");
    expect(status.pastDue).toBe(true);
    expect(status.graceUntil!.getTime() - Date.now()).toBeGreaterThan((GRACE_PERIOD_DAYS - 1) * 86_400_000);
    // Idempotent: a second sweep does not push the grace window again.
    const graceUntil = status.graceUntil!.getTime();
    await reconcileBillingLifecycle();
    expect((await subscriptionStatus(a.business.id)).graceUntil!.getTime()).toBe(graceUntil);
  });

  itDb("refunds build an immutable ledger and release the plan when fully reversed", async () => {
    const admin = await platformAdmin();
    const a = await tenant();
    const provider = new TestPaymentProvider();
    const attempt = await startCheckout(a.business.id, { plan: "BUSINESS", idempotencyKey: crypto.randomUUID(), successUrl: "https://app.test/ok", cancelUrl: "https://app.test/no" }, provider);
    await applySuccessfulPayment(
      { businessId: a.business.id, attemptId: attempt.id, providerTransactionId: "txn-refund-1", amountMinor: 4567, currency: "USD" },
      provider,
    );
    const [charge] = await db.select().from(paymentTransactions).where(eq(paymentTransactions.businessId, a.business.id));

    await expect(
      refundPayment(admin.user.id, {
        businessId: a.business.id,
        transactionId: charge.id,
        amountMinor: 5000,
        reason: "customer dispute resolution",
        idempotencyKey: crypto.randomUUID(),
      }, provider),
    ).rejects.toMatchObject({ status: 409 });

    const partial = await refundPayment(admin.user.id, {
      businessId: a.business.id,
      transactionId: charge.id,
      amountMinor: 1000,
      reason: "service credit partial",
      idempotencyKey: crypto.randomUUID(),
    }, provider);
    expect(partial.fullyRefunded).toBe(false);
    expect((await subscriptionStatus(a.business.id)).plan).toBe("BUSINESS");

    const full = await refundPayment(admin.user.id, {
      businessId: a.business.id,
      transactionId: charge.id,
      amountMinor: 3567,
      reason: "remaining balance refunded",
      idempotencyKey: crypto.randomUUID(),
    }, provider);
    expect(full.fullyRefunded).toBe(true);
    expect((await subscriptionStatus(a.business.id)).plan).toBe("FREE");

    // The original charge is never mutated; refunds are their own rows.
    const rows = await db.select().from(refundRecords).where(eq(refundRecords.businessId, a.business.id));
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.status === "SUCCEEDED")).toBe(true);
    const ledger = await billingLedger(a.business.id);
    expect(ledger.transactions.map((row) => row.kind).sort()).toEqual(["CHARGE", "REFUND", "REFUND"]);
    // Charges are positive, refunds negative: a fully reversed charge nets to 0.
    const net = ledger.transactions.reduce((sum, row) => sum + Number(row.amountMinor), 0);
    expect(net).toBe(0);
    expect(ledger.refunds).toHaveLength(2);

    await expect(
      refundPayment(admin.user.id, { businessId: a.business.id, transactionId: charge.id, reason: "already refunded fully", idempotencyKey: crypto.randomUUID() }, provider),
    ).rejects.toMatchObject({ status: 409 });
    // A tenant user cannot refund, and another tenant's transaction is invisible.
    const other = await tenant();
    await expect(
      refundPayment(other.user.id, { businessId: a.business.id, transactionId: charge.id, amountMinor: 1, reason: "not allowed", idempotencyKey: crypto.randomUUID() }, provider),
    ).rejects.toMatchObject({ status: 403 });
  });

  itDb("issues credit notes with audit trails and requires platform privileges", async () => {
    const admin = await platformAdmin();
    const a = await tenant();
    const note = await issueCreditNote(admin.user.id, {
      businessId: a.business.id,
      amountMinor: 250,
      currency: "USD",
      reason: "goodwill credit for outage",
    });
    expect(note.id).toBeTruthy();
    expect((await db.select().from(creditNotes).where(eq(creditNotes.businessId, a.business.id))).length).toBe(1);
    await expect(
      issueCreditNote(a.user.id, { businessId: a.business.id, amountMinor: 100, currency: "USD", reason: "tenant self-service credit" }),
    ).rejects.toMatchObject({ status: 403 });
    expect((await listPaymentProviders(admin.user.id)).length).toBe(0);
    await expect(listPaymentProviders(a.user.id)).rejects.toMatchObject({ status: 403 });
  });

  itDb("processes provider webhooks once, verifies against the provider API, and ignores unknown events", async () => {
    const a = await tenant();
    const provider = new TestPaymentProvider();
    const attempt = await startCheckout(a.business.id, { plan: "STARTER", idempotencyKey: crypto.randomUUID(), successUrl: "https://app.test/ok", cancelUrl: "https://app.test/no" }, provider);
    provider.settle(attempt.providerReference!, "SUCCEEDED");
    const body = JSON.stringify({
      id: "evt-synthetic-1",
      type: "checkout.session.completed",
      data: { id: attempt.providerReference, metadata: { attemptId: attempt.id } },
    });
    const first = await handleProviderWebhook({ rawBody: body, headers: {}, provider });
    expect(first).toMatchObject({ ok: true, duplicate: false, businessId: a.business.id });
    expect((await subscriptionStatus(a.business.id)).plan).toBe("STARTER");

    const replay = await handleProviderWebhook({ rawBody: body, headers: {}, provider });
    expect(replay).toMatchObject({ ok: true, duplicate: true });
    const events = await db.select().from(paymentEvents).where(eq(paymentEvents.provider, "test"));
    expect(events).toHaveLength(1);
    expect((await db.select().from(paymentTransactions).where(eq(paymentTransactions.businessId, a.business.id))).length).toBe(1);

    const unhandled = await handleProviderWebhook({
      rawBody: JSON.stringify({ id: "evt-synthetic-2", type: "customer.updated", data: {} }),
      headers: {},
      provider,
    });
    expect(unhandled).toMatchObject({ ok: true, ignored: true });

    // A webhook referencing an unknown provider reference must fail loudly and
    // be recorded as an error rather than silently succeeding.
    await expect(
      handleProviderWebhook({
        rawBody: JSON.stringify({ id: "evt-synthetic-3", type: "checkout.session.completed", data: { id: "test_unknown" } }),
        headers: {},
        provider,
      }),
    ).rejects.toMatchObject({ status: 404 });
    const [failed] = await db.select().from(paymentEvents).where(eq(paymentEvents.eventId, "evt-synthetic-3"));
    expect(failed.error).toBe("attempt_not_found");
  });

  itDb("keeps an invoice-linked charge and the manual ledger consistent", async () => {
    const a = await tenant();
    const provider = new TestPaymentProvider();
    const invoice = await requestInvoice(a.business.id, { plan: "STARTER", idempotencyKey: crypto.randomUUID() });
    const attempt = await startCheckout(a.business.id, { plan: "STARTER", idempotencyKey: crypto.randomUUID(), successUrl: "https://app.test/ok", cancelUrl: "https://app.test/no" }, provider);
    await db.update(paymentAttempts).set({ invoiceId: invoice.id }).where(eq(paymentAttempts.id, attempt.id));
    await applySuccessfulPayment(
      { businessId: a.business.id, attemptId: attempt.id, providerTransactionId: "txn-invoice-1", amountMinor: 1234, currency: "USD" },
      provider,
    );
    const [row] = await db.select().from(billingInvoices).where(eq(billingInvoices.id, invoice.id));
    expect(row.status).toBe("paid");
    expect(row.paymentReference).toBe("txn-invoice-1");
    expect(row.paidAt).not.toBeNull();
  });

  itDb("reports provider configuration honestly and refuses unconfigured collection", async () => {
    vi.stubEnv("PAYMENT_PROVIDER", "disabled");
    resetEnvCache();
    const a = await tenant();
    await expect(
      startCheckout(a.business.id, { plan: "STARTER", idempotencyKey: crypto.randomUUID(), successUrl: "https://app.test/ok", cancelUrl: "https://app.test/no" }),
    ).rejects.toMatchObject({ status: 503 });

    vi.stubEnv("PAYMENT_PROVIDER", "test");
    resetEnvCache();
    const status = paymentProviderStatus();
    expect(status.available).toBe(true);
    expect(status.liveVerified).toBe(false);
    expect(status.capabilities?.checkout).toBe(true);
    expect(status.webhooksConfigured).toBe(false);
    expect(status.automaticCollection).toBe(false);
    vi.unstubAllEnvs();
    resetEnvCache();
    vi.stubEnv("BILLING_CATALOG_JSON", JSON.stringify(catalog));
  });
});
