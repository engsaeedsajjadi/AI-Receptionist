import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetBreaker, resetBreakerMemory } from "@/lib/circuit-breaker";
import { TwilioVoiceProvider, twilioOptionsFromEnv } from "@/lib/providers/telephony/twilio";
import { StripeCompatiblePaymentProvider } from "@/lib/providers/payments";

/**
 * The breaker must actually protect the provider transports, not just exist:
 * after repeated provider-health failures the adapter must fail fast with
 * `PROVIDER_CIRCUIT_OPEN` without issuing another network call, and 4xx client
 * errors must never open the circuit.
 */

const ENV_KEYS = ["BREAKER_FAILURE_THRESHOLD", "BREAKER_OPEN_SECONDS"] as const;
const snapshot = new Map<string, string | undefined>();
for (const key of ENV_KEYS) snapshot.set(key, process.env[key]);

function restoreEnv() {
  for (const key of ENV_KEYS) {
    const value = snapshot.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function twilio() {
  return new TwilioVoiceProvider(
    twilioOptionsFromEnv({ accountSid: "AC-unit-test-sid", authToken: "token", timeoutMs: 50 }),
  );
}

function payments() {
  return new StripeCompatiblePaymentProvider({
    baseURL: "https://payments.example.invalid",
    apiKey: "sk_test",
    webhookSecret: "whsec",
    timeoutMs: 50,
    providerName: "stripe-compatible",
    mode: "test",
  });
}

describe("provider transports are breaker-protected", () => {
  beforeEach(async () => {
    resetBreakerMemory();
    await resetBreaker("telephony:twilio");
    await resetBreaker("payment:stripe-compatible");
    process.env.BREAKER_FAILURE_THRESHOLD = "1";
    process.env.BREAKER_OPEN_SECONDS = "60";
    vi.restoreAllMocks();
  });
  afterEach(async () => {
    resetBreakerMemory();
    await resetBreaker("telephony:twilio");
    await resetBreaker("payment:stripe-compatible");
    restoreEnv();
    vi.restoreAllMocks();
  });

  it("stops calling Twilio after a provider-health failure", async () => {
    const fetchMock = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(twilio().getCallStatus("CA1")).rejects.toMatchObject({ code: "VOICE_ERROR" });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await expect(twilio().getCallStatus("CA1")).rejects.toMatchObject({
      status: 503,
      code: "PROVIDER_CIRCUIT_OPEN",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1); // provider untouched while open
  });

  it("keeps answering after a Twilio 404 (client error) instead of opening the circuit", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ message: "not found" }), { status: 404 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(twilio().getCallStatus("CA-missing")).rejects.toMatchObject({ status: 404, code: "CALL_NOT_FOUND" });
    await expect(twilio().getCallStatus("CA-missing")).rejects.toMatchObject({ status: 404, code: "CALL_NOT_FOUND" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not open the circuit on Twilio rate limiting (429 is an instruction to slow down)", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ message: "slow down" }), { status: 429 }));
    vi.stubGlobal("fetch", fetchMock);
    for (let i = 0; i < 3; i += 1) {
      await expect(twilio().getCallStatus("CA1")).rejects.toMatchObject({ status: 429, code: "PROVIDER_RATE_LIMITED" });
    }
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("stops calling the payment provider after repeated 5xx responses", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ error: "down" }), { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      payments().createCheckout({ attemptId: "attempt-1", businessId: "11111111-1111-1111-1111-111111111111", plan: "starter", amountMinor: 1000, currency: "IRR", successUrl: "https://x.test/ok", cancelUrl: "https://x.test/no", idempotencyKey: `idem-${Math.random()}` }),
    ).rejects.toMatchObject({ code: "PROVIDER_ERROR" });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await expect(
      payments().createCheckout({ attemptId: "attempt-2", businessId: "11111111-1111-1111-1111-111111111111", plan: "starter", amountMinor: 1000, currency: "IRR", successUrl: "https://x.test/ok", cancelUrl: "https://x.test/no", idempotencyKey: `idem-${Math.random()}` }),
    ).rejects.toMatchObject({ status: 503, code: "PROVIDER_CIRCUIT_OPEN" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("payment client errors never open the circuit", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ error: "bad request" }), { status: 422 }));
    vi.stubGlobal("fetch", fetchMock);
    for (let i = 0; i < 3; i += 1) {
      await expect(
        payments().createCheckout({ attemptId: `attempt-${i}`, businessId: "11111111-1111-1111-1111-111111111111", plan: "starter", amountMinor: 1000, currency: "IRR", successUrl: "https://x.test/ok", cancelUrl: "https://x.test/no", idempotencyKey: `idem-${Math.random()}` }),
      ).rejects.toMatchObject({ code: "PROVIDER_ERROR" });
    }
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
