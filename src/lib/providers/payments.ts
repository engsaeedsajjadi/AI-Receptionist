import { z } from "zod";
import { AppError } from "@/lib/errors";
import { withCircuitBreaker } from "@/lib/circuit-breaker";
import { getEnv } from "@/lib/env";
import { logError, logWarn } from "@/lib/logger";
import { metrics } from "@/lib/telemetry";

/**
 * Payment provider abstraction.
 *
 * Billing is never coupled to one payment company: the lifecycle below is the
 * contract every gateway must satisfy, and only `capabilities()` differ between
 * providers. A provider that cannot do something must say so — the service
 * layer then fails honestly instead of fabricating success.
 */

export const PaymentProviderName = z.enum(["test", "stripe", "manual"]);
export type PaymentProviderNameType = z.infer<typeof PaymentProviderName>;

export type ProviderCapabilities = {
  checkout: boolean;
  refunds: boolean;
  partialRefunds: boolean;
  cancelSubscription: boolean;
  renewSubscription: boolean;
  webhooks: boolean;
  /** Live gateway acceptance has actually been exercised against this account. */
  liveVerified: boolean;
};

export type CheckoutRequest = {
  businessId: string;
  plan: string;
  amountMinor: number;
  currency: string;
  invoiceId?: string | null;
  attemptId: string;
  idempotencyKey: string;
  successUrl: string;
  cancelUrl: string;
  metadata?: Record<string, unknown>;
  expiresInMinutes?: number;
};

export type CheckoutSession = {
  providerReference: string;
  checkoutUrl: string;
  status: "PENDING";
  expiresAt: Date | null;
  raw?: unknown;
};

export type PaymentVerification = {
  /** Provider-side truth: never derived from a client redirect. */
  status: "PENDING" | "SUCCEEDED" | "FAILED" | "EXPIRED" | "CANCELED";
  amountMinor: number | null;
  currency: string | null;
  providerTransactionId: string | null;
  providerReference: string;
  failureCode?: string | null;
  failureMessage?: string | null;
  raw?: unknown;
};

export type RefundRequest = {
  providerTransactionId: string;
  amountMinor: number;
  reason?: string;
  idempotencyKey: string;
};

export type RefundResult = {
  providerRefundId: string;
  amountMinor: number;
  /** `PARTIAL` when the provider refunded less than requested. */
  status: "SUCCEEDED" | "PARTIAL" | "FAILED";
  raw?: unknown;
};

export type ProviderWebhookEvent = {
  eventId: string;
  eventType: string;
  /** Verified by the provider adapter (signature/HMAC) before this is returned. */
  verified: boolean;
  data: Record<string, unknown>;
};

export interface PaymentProvider {
  readonly name: string;
  capabilities(): ProviderCapabilities;
  createCheckout(request: CheckoutRequest): Promise<CheckoutSession>;
  verifyPayment(input: { providerReference: string; businessId: string }): Promise<PaymentVerification>;
  parseWebhook(input: { rawBody: string; headers: Record<string, string | undefined>; businessId?: string | null }): Promise<ProviderWebhookEvent>;
  refund(request: RefundRequest): Promise<RefundResult>;
  cancelSubscription(input: { providerSubscriptionId: string; atPeriodEnd: boolean; businessId: string }): Promise<{ status: string }>;
  renewSubscription(input: { providerSubscriptionId: string; businessId: string }): Promise<{ status: string; periodEnd?: Date | null }>;
}

type HttpPaymentOptions = {
  baseURL: string;
  apiKey: string;
  webhookSecret: string;
  timeoutMs: number;
  providerName: string;
  mode: "live" | "test";
};

/**
 * Errors that mean "the provider is unhealthy" (network, timeout, 5xx) and
 * therefore feed the circuit breaker. Client errors and rate limits are the
 * caller's problem (or the provider asking us to slow down) and must not open
 * the circuit for every tenant.
 */
function isProviderHealthFailure(error: unknown): boolean {
  if (error instanceof AppError) {
    const upstream = (error.details as { upstreamStatus?: number } | undefined)?.upstreamStatus;
    // Prefer the provider's own status: our outward status is always 502, so a
    // 4xx from the provider would otherwise look like a provider outage.
    if (typeof upstream === "number") return upstream >= 500 || upstream === 408;
    return error.status >= 500 || error.status === 408;
  }
  return true; // network errors, aborts and unexpected throws
}

async function postJson(options: HttpPaymentOptions, path: string, body: unknown, idempotencyKey?: string): Promise<{ status: number; json: Record<string, unknown> }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);
  try {
    return await withCircuitBreaker(
      `payment:${options.providerName}`,
      async () => {
        const res = await fetch(`${options.baseURL}${path}`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${options.apiKey}`,
            "Content-Type": "application/json",
            ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        const text = await res.text();
        let json: Record<string, unknown> = {};
        try {
          json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
        } catch {
          json = { raw: text };
        }
        if (!res.ok) {
          if (res.status === 429)
            throw new AppError(429, "PROVIDER_RATE_LIMITED", "Payment provider rate limited", {
              detail: json,
              upstreamStatus: 429,
            });
          throw new AppError(502, "PROVIDER_ERROR", `Payment provider error (HTTP ${res.status})`, {
            detail: json,
            upstreamStatus: res.status,
          });
        }
        return { status: res.status, json };
      },
      { shouldCountFailure: isProviderHealthFailure },
    );
  } catch (err) {
    const aborted = err instanceof Error && err.name === "AbortError";
    metrics().providerErrors.inc({ provider: options.providerName, operation: "payments" });
    logError("Payment provider request failed", {
      provider: options.providerName,
      operation: `payments${path}`,
      status: "error",
      error: err instanceof Error ? err.message : String(err),
    });
    if (aborted) throw new AppError(504, "PROVIDER_TIMEOUT", "Payment provider timeout");
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Stripe-compatible adapter (Stripe, and gateways exposing a Stripe-compatible
 * API such as some Iranian PSP dashboards behind a shim). Uses the documented
 * `/v1/checkout/sessions`, `/v1/payment_intents/{id}` and `/v1/refunds`
 * endpoints and Stripe's `Stripe-Signature` HMAC verification scheme. Live
 * acceptance for a real account is an operator step (see docs).
 */
export class StripeCompatiblePaymentProvider implements PaymentProvider {
  readonly name: string;
  private options: HttpPaymentOptions;

  constructor(overrides?: Partial<HttpPaymentOptions>) {
    const env = getEnv();
    const baseURL = (overrides?.baseURL ?? env.PAYMENT_API_BASE_URL ?? "").replace(/\/$/, "");
    const apiKey = overrides?.apiKey ?? env.PAYMENT_API_KEY ?? "";
    const webhookSecret = overrides?.webhookSecret ?? env.PAYMENT_WEBHOOK_SECRET ?? "";
    if (!baseURL || !apiKey) {
      throw new AppError(503, "PROVIDER_NOT_CONFIGURED", "PAYMENT_API_BASE_URL and PAYMENT_API_KEY are required for the payment provider");
    }
    this.name = overrides?.providerName ?? "stripe";
    this.options = {
      baseURL,
      apiKey,
      webhookSecret,
      timeoutMs: overrides?.timeoutMs ?? env.PAYMENT_TIMEOUT_MS ?? 15_000,
      providerName: this.name,
      mode: (overrides?.mode ?? env.PAYMENT_MODE ?? "test") as "live" | "test",
    };
  }

  capabilities(): ProviderCapabilities {
    return { checkout: true, refunds: true, partialRefunds: true, cancelSubscription: true, renewSubscription: true, webhooks: true, liveVerified: false };
  }

  async createCheckout(request: CheckoutRequest): Promise<CheckoutSession> {
    const { json } = await postJson(
      this.options,
      "/v1/checkout/sessions",
      {
        mode: "payment",
        success_url: request.successUrl,
        cancel_url: request.cancelUrl,
        client_reference_id: request.attemptId,
        metadata: { businessId: request.businessId, plan: request.plan, invoiceId: request.invoiceId ?? "", ...(request.metadata ?? {}) },
        line_items: [
          {
            quantity: 1,
            price_data: {
              currency: request.currency.toLowerCase(),
              unit_amount: request.amountMinor,
              product_data: { name: `${request.plan} plan` },
            },
          },
        ],
      },
      request.idempotencyKey,
    );
    const providerReference = String(json.id ?? "");
    const checkoutUrl = String(json.url ?? "");
    if (!providerReference || !checkoutUrl) throw new AppError(502, "PROVIDER_ERROR", "Payment provider did not return a checkout session");
    const expiresAt = typeof json.expires_at === "number" ? new Date(json.expires_at * 1000) : null;
    return { providerReference, checkoutUrl, status: "PENDING", expiresAt, raw: json };
  }

  async verifyPayment(input: { providerReference: string; businessId: string }): Promise<PaymentVerification> {
    const { json } = await postJson(this.options, `/v1/checkout/sessions/${encodeURIComponent(input.providerReference)}`, {});
    const paymentStatus = String(json.payment_status ?? "unpaid");
    const status: PaymentVerification["status"] =
      paymentStatus === "paid" ? "SUCCEEDED" : json.status === "expired" ? "EXPIRED" : json.status === "complete" ? "PENDING" : "PENDING";
    return {
      status,
      amountMinor: typeof json.amount_total === "number" ? json.amount_total : null,
      currency: typeof json.currency === "string" ? json.currency.toUpperCase() : null,
      providerTransactionId: typeof json.payment_intent === "string" ? json.payment_intent : null,
      providerReference: input.providerReference,
      failureCode: null,
      failureMessage: null,
      raw: json,
    };
  }

  async parseWebhook(input: { rawBody: string; headers: Record<string, string | undefined>; businessId?: string | null }): Promise<ProviderWebhookEvent> {
    const signature = input.headers["stripe-signature"];
    if (!this.options.webhookSecret) throw new AppError(503, "PROVIDER_NOT_CONFIGURED", "PAYMENT_WEBHOOK_SECRET is required to verify payment webhooks");
    if (!signature) throw new AppError(401, "INVALID_SIGNATURE", "Missing payment webhook signature");
    // Stripe scheme: `t=<timestamp>,v1=<hex hmac of "timestamp.payload">`.
    const parts = Object.fromEntries(signature.split(",").map((piece) => piece.split("=") as [string, string]));
    const timestamp = Number(parts.t);
    if (!Number.isFinite(timestamp)) throw new AppError(401, "INVALID_SIGNATURE", "Malformed payment webhook signature");
    if (Math.abs(Date.now() / 1000 - timestamp) > 300) throw new AppError(401, "STALE_TIMESTAMP", "Payment webhook timestamp outside replay window");
    const { createHmac, timingSafeEqual } = await import("node:crypto");
    const expected = createHmac("sha256", this.options.webhookSecret).update(`${parts.t}.${input.rawBody}`).digest("hex");
    const provided = parts.v1 ?? "";
    const a = Buffer.from(expected, "utf8");
    const b = Buffer.from(provided, "utf8");
    if (a.length !== b.length || !timingSafeEqual(a, b)) throw new AppError(401, "INVALID_SIGNATURE", "Payment webhook signature mismatch");
    const parsed = JSON.parse(input.rawBody) as { id?: string; type?: string; data?: { object?: Record<string, unknown> } };
    if (!parsed.id || !parsed.type) throw new AppError(400, "INVALID_PAYLOAD", "Payment webhook payload is missing id/type");
    return { eventId: parsed.id, eventType: parsed.type, verified: true, data: parsed.data?.object ?? {} };
  }

  async refund(request: RefundRequest): Promise<RefundResult> {
    const { json } = await postJson(
      this.options,
      "/v1/refunds",
      { payment_intent: request.providerTransactionId, amount: request.amountMinor, reason: "requested_by_customer", metadata: { note: request.reason ?? "" } },
      request.idempotencyKey,
    );
    const refundedMinor = typeof json.amount === "number" ? json.amount : request.amountMinor;
    const status: RefundResult["status"] = json.status === "failed" ? "FAILED" : refundedMinor < request.amountMinor ? "PARTIAL" : "SUCCEEDED";
    return { providerRefundId: String(json.id ?? ""), amountMinor: refundedMinor, status, raw: json };
  }

  async cancelSubscription(input: { providerSubscriptionId: string; atPeriodEnd: boolean; businessId: string }): Promise<{ status: string }> {
    const path = input.atPeriodEnd
      ? `/v1/subscriptions/${encodeURIComponent(input.providerSubscriptionId)}`
      : `/v1/subscriptions/${encodeURIComponent(input.providerSubscriptionId)}/cancel`;
    const { json } = await postJson(this.options, path, input.atPeriodEnd ? { cancel_at_period_end: true } : {});
    return { status: String(json.status ?? (input.atPeriodEnd ? "active" : "canceled")) };
  }

  async renewSubscription(input: { providerSubscriptionId: string; businessId: string }): Promise<{ status: string; periodEnd?: Date | null }> {
    const { json } = await postJson(this.options, `/v1/subscriptions/${encodeURIComponent(input.providerSubscriptionId)}/resume`, {});
    const periodEnd = typeof json.current_period_end === "number" ? new Date(json.current_period_end * 1000) : null;
    return { status: String(json.status ?? "active"), periodEnd };
  }
}

/**
 * Deterministic local provider used by tests and by `PAYMENT_PROVIDER=test`.
 * It never claims live verification and refuses to be selected in production.
 */
export class TestPaymentProvider implements PaymentProvider {
  readonly name = "test";
  private sessions = new Map<string, { request: CheckoutRequest; status: PaymentVerification["status"] }>();

  capabilities(): ProviderCapabilities {
    return { checkout: true, refunds: true, partialRefunds: true, cancelSubscription: true, renewSubscription: true, webhooks: true, liveVerified: false };
  }

  async createCheckout(request: CheckoutRequest): Promise<CheckoutSession> {
    const providerReference = `test_${request.attemptId}`;
    this.sessions.set(providerReference, { request, status: "PENDING" });
    return { providerReference, checkoutUrl: `https://payments.example.test/checkout/${providerReference}`, status: "PENDING", expiresAt: new Date(Date.now() + 3600_000) };
  }

  async verifyPayment(input: { providerReference: string; businessId: string }): Promise<PaymentVerification> {
    const session = this.sessions.get(input.providerReference);
    if (!session) throw new AppError(404, "NOT_FOUND", "Unknown test checkout session");
    return {
      status: session.status,
      amountMinor: session.request.amountMinor,
      currency: session.request.currency,
      providerTransactionId: session.status === "SUCCEEDED" ? `txn_${input.providerReference}` : null,
      providerReference: input.providerReference,
    };
  }

  /** Test-only: drive a session to a terminal state (never exposed over HTTP). */
  settle(providerReference: string, status: PaymentVerification["status"]): void {
    const session = this.sessions.get(providerReference);
    if (!session) throw new AppError(404, "NOT_FOUND", "Unknown test checkout session");
    session.status = status;
  }

  async parseWebhook(input: { rawBody: string; headers: Record<string, string | undefined> }): Promise<ProviderWebhookEvent> {
    const body = JSON.parse(input.rawBody) as { id?: string; type?: string; data?: Record<string, unknown> };
    if (!body.id || !body.type) throw new AppError(400, "INVALID_PAYLOAD", "Payment webhook payload is missing id/type");
    return { eventId: body.id, eventType: body.type, verified: true, data: body.data ?? {} };
  }

  async refund(request: RefundRequest): Promise<RefundResult> {
    return { providerRefundId: `re_${request.idempotencyKey}`, amountMinor: request.amountMinor, status: "SUCCEEDED" };
  }

  async cancelSubscription(input: { providerSubscriptionId: string; atPeriodEnd: boolean }): Promise<{ status: string }> {
    return { status: input.atPeriodEnd ? "active" : "canceled" };
  }

  async renewSubscription(): Promise<{ status: string; periodEnd?: Date | null }> {
    return { status: "active", periodEnd: null };
  }
}

export function paymentProviderFromEnv(): PaymentProvider | null {
  const env = getEnv();
  const configured = env.PAYMENT_PROVIDER ?? "disabled";
  switch (configured) {
    case "stripe":
    case "compatible":
      return new StripeCompatiblePaymentProvider();
    case "test":
      if (env.NODE_ENV === "production") {
        logWarn("PAYMENT_PROVIDER=test is not allowed in production; automatic collection is disabled", {
          operation: "payments.config",
          status: "disabled",
        });
        return null;
      }
      return new TestPaymentProvider();
    case "disabled":
      return null;
    default:
      throw new AppError(503, "PROVIDER_NOT_CONFIGURED", `Unsupported PAYMENT_PROVIDER: ${configured}`);
  }
}

/** Capability report for the platform control plane (honest, never optimistic). */
export function paymentProviderStatus() {
  const env = getEnv();
  const configured = env.PAYMENT_PROVIDER ?? "disabled";
  const provider = paymentProviderFromEnv();
  return {
    configured,
    available: provider !== null,
    capabilities: provider?.capabilities() ?? null,
    webhooksConfigured: Boolean(env.PAYMENT_WEBHOOK_SECRET),
    mode: env.PAYMENT_MODE ?? "test",
    automaticCollection: provider !== null && Boolean(env.PAYMENT_WEBHOOK_SECRET),
    liveVerified: false,
    note: provider === null
      ? "Automatic collection is disabled; manual invoice settlement remains available."
      : "Provider contract implemented; live acceptance requires operator credentials.",
  };
}
