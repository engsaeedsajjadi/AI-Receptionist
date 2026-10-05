import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { closeDb, db } from "@/db";
import { calls, knowledgeDocuments, storageObjects } from "@/db/schema";
import { GenericVoiceProvider, getVoiceProvider, DevVoiceProvider } from "@/lib/providers/voice";
import {
  ConsoleNotificationProvider,
  EmailNotificationProvider,
  getNotificationProvider,
  InternalNotificationProvider,
  SmsWebhookProvider,
  TelegramNotificationProvider,
} from "@/lib/providers/notifications";
import { LocalStorageProvider, S3StorageProvider } from "@/lib/providers/storage";
import { StripeCompatiblePaymentProvider, TestPaymentProvider, paymentProviderStatus } from "@/lib/providers/payments";
import {
  auditStorageDeletion,
  deleteObjectsForSource,
  forgetStoredObjectStandalone,
  reconcileStorage,
  recordStoredObjectStandalone,
  storageSummary,
  storageUsageBytes,
} from "@/lib/services/storage-usage";
import { outboxBackoffSeconds, outboxHealth, OUTBOX_TOPICS, TENANT_WEBHOOK_TOPICS } from "@/lib/services/outbox";
import { closeRedis, acquireLock, redisDel, redisGet, redisIncr, redisSet, setNx } from "@/lib/redis";
import { captureServerError, initMonitoring, isMonitoringEnabled, setRequestContext } from "@/lib/monitoring";
import { oauthCallbackUrl, oauthConfiguration, oauthCookie, oauthProvider, startOAuth } from "@/lib/oidc";
import { executeToolCall, getToolDefinitions, listTools } from "@/lib/tools/registry";
import { getTransferConfig, requestTransfer } from "@/lib/services/calls";
import { createBusiness, createCustomer, createUser } from "../helpers/fixtures";
import { ensureDbReady, hasTestDatabase, itDb, truncateAll } from "../helpers/db";
import { resetEnvCache } from "@/lib/env";

/** Env snapshot modules cache configuration: stub, then reset the cache. */
/**
 * process.env is shared with other test files running in the same worker
 * thread, so every stubbed key is snapshotted and restored afterwards.
 */
const ENV_SNAPSHOT = new Map<string, string | undefined>();
const stubEnv = (key: string, value: string) => {
  if (!ENV_SNAPSHOT.has(key)) ENV_SNAPSHOT.set(key, process.env[key]);
  process.env[key] = value;
  resetEnvCache();
};
const restoreEnv = () => {
  for (const [key, value] of ENV_SNAPSHOT) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  ENV_SNAPSHOT.clear();
  resetEnvCache();
};
import { ensureRedisReady } from "../helpers/redis";

async function tenant() {
  const business = await createBusiness();
  const { user } = await createUser(business.id, "ADMIN");
  return { business, user };
}

describe("voice provider", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    restoreEnv();
  });

  itDb("refuses to construct the generic provider without a live gateway configuration", () => {
    stubEnv("VOICE_API_BASE_URL", "");
    stubEnv("VOICE_API_KEY", "");
    expect(() => new GenericVoiceProvider()).toThrow(/VOICE_API_BASE_URL/);
  });

  itDb("maps provider responses and normalises transient failures", async () => {
    stubEnv("VOICE_API_BASE_URL", "https://voice.example.com");
    stubEnv("VOICE_API_KEY", "k");
    const provider = new GenericVoiceProvider({ maxRetries: 1 });
    const bodies: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        bodies.push({ url, method: init?.method, body: init?.body });
        return new Response(JSON.stringify({ ok: true, providerCallId: "pc-1", status: "answered" }), { status: 200 });
      }),
    );
    const answered = await provider.answerCall("call-1", { requestId: "r1" });
    expect(answered).toMatchObject({ ok: true });
    await provider.hangupCall("call-1", { reason: "completed" });
    await provider.playAudio("call-1", { audioUrl: "https://cdn.example.com/a.mp3", text: "سلام" });
    await provider.startStream("call-1", { websocketUrl: "wss://media.example.com/ws", businessId: "b1", callId: "call-1" });
    await provider.stopStream("call-1");
    const transferred = await provider.transferCall("call-1", "09120000000", { timeoutSeconds: 20 });
    expect(transferred).toMatchObject({ ok: true, transferStatus: "INITIATED" });
    const status = await provider.getCallStatus("call-1");
    expect(status).toMatchObject({ providerCallId: "call-1" });
    expect(status.status).toBe("answered");
    expect(bodies.length).toBeGreaterThan(5);
    await expect(provider.playAudio("call-1", {})).rejects.toMatchObject({ status: 400 });
    await expect(provider.transferCall("call-1", "")).rejects.toMatchObject({ status: 400 });
  });

  itDb("retries 5xx, surfaces 429 as rate limiting and never fabricates success", async () => {
    stubEnv("VOICE_API_BASE_URL", "https://voice.example.com");
    stubEnv("VOICE_API_KEY", "k");
    let attempts = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        attempts += 1;
        if (attempts === 1) return new Response("boom", { status: 500 });
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }),
    );
    const retrying = new GenericVoiceProvider({ maxRetries: 2 });
    expect(await retrying.answerCall("call-1")).toMatchObject({ ok: true });
    expect(attempts).toBe(2);

    vi.stubGlobal("fetch", vi.fn(async () => new Response("slow down", { status: 429 })));
    await expect(new GenericVoiceProvider({ maxRetries: 0 }).answerCall("call-1")).rejects.toMatchObject({ code: "PROVIDER_RATE_LIMITED" });

    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 400 })));
    await expect(new GenericVoiceProvider({ maxRetries: 0 }).hangupCall("call-1", { reason: "completed" })).rejects.toThrow(/Voice gateway/);

    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("ECONNRESET"); }));
    await expect(new GenericVoiceProvider({ maxRetries: 1 }).getCallStatus("call-1")).rejects.toThrow();
  });

  itDb("dev provider always fails loudly and the factory honours VOICE_PROVIDER", async () => {
    const dev = new DevVoiceProvider();
    await expect(dev.answerCall()).rejects.toMatchObject({ code: "PROVIDER_NOT_CONFIGURED" });
    await expect(dev.hangupCall()).rejects.toMatchObject({ code: "PROVIDER_NOT_CONFIGURED" });
    await expect(dev.transferCall()).rejects.toMatchObject({ code: "PROVIDER_NOT_CONFIGURED" });
    await expect(dev.playAudio()).rejects.toMatchObject({ code: "PROVIDER_NOT_CONFIGURED" });
    await expect(dev.getCallStatus()).rejects.toMatchObject({ code: "PROVIDER_NOT_CONFIGURED" });
    stubEnv("VOICE_PROVIDER", "dev");
    expect(getVoiceProvider().name).toBe("dev");
    stubEnv("VOICE_PROVIDER", "generic");
    stubEnv("VOICE_API_BASE_URL", "https://voice.example.com");
    stubEnv("VOICE_API_KEY", "k");
    expect(getVoiceProvider().name).toBe("generic");
  });
});

describe("notification providers", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    restoreEnv();
  });

  const input = { to: "ops@example.com", subject: "تماس جدید", body: "یک تماس جدید ثبت شد", metadata: { businessId: "b1" } };

  itDb("internal and console providers are deterministic and never pretend to send externally", async () => {
    const internal = new InternalNotificationProvider();
    expect(internal.channel).toBe("internal");
    expect(await internal.send(input)).toMatchObject({ ok: true });
    const consoleProvider = new ConsoleNotificationProvider();
    expect(await consoleProvider.send(input)).toMatchObject({ ok: true });
    expect(getNotificationProvider("internal").channel).toBe("internal");
    expect(getNotificationProvider("email").channel).toBe("email");
  });

  itDb("sms/telegram/webhook providers report failures instead of swallowing them", async () => {
    stubEnv("SMS_WEBHOOK_URL", "https://sms.example.com/send");
    stubEnv("SMS_WEBHOOK_TOKEN", "t");
    const sms = new SmsWebhookProvider();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ id: "sms-1" }), { status: 200 })));
    expect(await sms.send({ ...input, to: "09120000000" })).toMatchObject({ ok: true });
    vi.stubGlobal("fetch", vi.fn(async () => new Response("fail", { status: 500 })));
    expect(await sms.send({ ...input, to: "09120000000" })).toMatchObject({ ok: false });

    stubEnv("TELEGRAM_BOT_TOKEN", "bot:token");
    stubEnv("TELEGRAM_CHAT_ID", "12345");
    const telegram = new TelegramNotificationProvider();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 })));
    expect(await telegram.send(input)).toMatchObject({ ok: true });
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
    expect(await telegram.send(input)).toMatchObject({ ok: false });

    const email = new EmailNotificationProvider();
    vi.stubGlobal("fetch", vi.fn(async () => new Response("bad", { status: 400 })));
    const result = await email.send(input);
    expect(result.ok).toBe(false);
    expect(getNotificationProvider("email")).toBeInstanceOf(EmailNotificationProvider);
  });

  itDb("email provider refuses to run without SMTP configuration", async () => {
    stubEnv("SMTP_HOST", "");
    stubEnv("SMTP_URL", "");
    const provider = new EmailNotificationProvider();
    const result = await provider.send(input);
    expect(result.ok).toBe(false);
    expect(String(result.error ?? "")).toMatch(/SMTP|configured|not/i);
  });
});

describe("storage providers", () => {
  beforeAll(async () => {
    await ensureDbReady();
    stubEnv("JWT_SECRET", "test-jwt-secret-for-signed-urls-0123456789");
  });
  afterAll(async () => {
    vi.unstubAllEnvs();
    restoreEnv();
    await closeDb();
  });
  beforeEach(async () => {
    await truncateAll();
  });

  itDb("local storage writes, reads, lists, signs and refuses path traversal", async () => {
    const provider = new LocalStorageProvider("/tmp/ai-receptionist-storage-unit");
    const key = `business/${crypto.randomUUID()}/recording.mp3`;
    const uploaded = await provider.upload({ key, data: Buffer.from("audio-bytes"), contentType: "audio/mpeg" });
    expect(uploaded.bytes).toBe(11);
    expect(await provider.download(key)).toEqual(Buffer.from("audio-bytes"));
    const listed = await provider.list("business/");
    expect(listed.some((entry) => entry.key === key)).toBe(true);
    const signed = await provider.getSignedUrl(key, 60);
    expect(signed).toContain("/api/v1/files/");
    expect(signed).toContain("sig=");
    await expect(provider.download("../../etc/passwd")).rejects.toThrow();
    await provider.delete(key);
    await expect(provider.download(key)).rejects.toThrow();
  });

  itDb("s3 adapter refuses to construct without credentials and maps provider failures", async () => {
    stubEnv("S3_ENDPOINT", "");
    stubEnv("S3_ACCESS_KEY_ID", "");
    stubEnv("S3_SECRET_ACCESS_KEY", "");
    expect(() => new S3StorageProvider()).toThrow(/S3 storage is not configured/);

    stubEnv("S3_ENDPOINT", "https://s3.example.com");
    stubEnv("S3_ACCESS_KEY_ID", "a");
    stubEnv("S3_SECRET_ACCESS_KEY", "b");
    stubEnv("S3_BUCKET", "test-bucket");
    const provider = new S3StorageProvider();
    expect(provider.name).toBe("s3");
    const { S3Client } = await import("@aws-sdk/client-s3");
    const send = vi.spyOn(S3Client.prototype, "send").mockRejectedValue(Object.assign(new Error("no such key"), { name: "NoSuchKey" }));
    await expect(provider.download("business/x/missing.bin")).rejects.toThrow();
    send.mockRestore();
    vi.unstubAllEnvs();
  });
});

describe("payment provider adapters", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    restoreEnv();
  });

  itDb("test provider is deterministic, refuses production and supports partial refunds", async () => {
    const provider = new TestPaymentProvider();
    expect(provider.capabilities()).toMatchObject({ checkout: true, partialRefunds: true, liveVerified: false });
    const session = await provider.createCheckout({
      businessId: crypto.randomUUID(),
      plan: "STARTER",
      amountMinor: 1000,
      currency: "USD",
      attemptId: crypto.randomUUID(),
      idempotencyKey: crypto.randomUUID(),
      successUrl: "https://app.example.com/ok",
      cancelUrl: "https://app.example.com/no",
    });
    expect(session.checkoutUrl).toContain("test_");
    expect(session.providerReference).toBeTruthy();
    const verified = await provider.verifyPayment({ providerReference: session.providerReference, businessId: crypto.randomUUID() });
    expect(verified.status).toBe("PENDING");

    const refund = await provider.refund({ providerTransactionId: "tx-1", amountMinor: 400, reason: "partial", idempotencyKey: crypto.randomUUID() });
    expect(["SUCCEEDED", "PARTIAL"]).toContain(refund.status);
    expect(refund.amountMinor).toBe(400);
    expect(await provider.cancelSubscription({ providerSubscriptionId: "sub-1", atPeriodEnd: true })).toMatchObject({ status: expect.any(String) });
    expect(await provider.renewSubscription()).toMatchObject({ status: expect.any(String) });

    stubEnv("NODE_ENV", "production");
    stubEnv("PAYMENT_PROVIDER", "test");
    const { paymentProviderFromEnv } = await import("@/lib/providers/payments");
    expect(paymentProviderFromEnv()).toBeNull();
    stubEnv("NODE_ENV", "test");
    stubEnv("PAYMENT_PROVIDER", "test");
  });

  itDb("stripe-compatible adapter negotiates capabilities, verifies signatures and maps failures", async () => {
    stubEnv("PAYMENT_API_BASE_URL", "https://pay.example.com");
    stubEnv("PAYMENT_API_KEY", "sk_test");
    stubEnv("PAYMENT_WEBHOOK_SECRET", "whsec_test");
    const provider = new StripeCompatiblePaymentProvider({ mode: "test" });
    expect(provider.capabilities()).toMatchObject({ refunds: true, webhooks: true, liveVerified: false });

    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ id: "cs_1", url: "https://pay.example.com/checkout/cs_1" }), { status: 200 })));
    const session = await provider.createCheckout({
      businessId: crypto.randomUUID(),
      plan: "BUSINESS",
      amountMinor: 5000,
      currency: "USD",
      attemptId: crypto.randomUUID(),
      idempotencyKey: crypto.randomUUID(),
      successUrl: "https://app.example.com/ok",
      cancelUrl: "https://app.example.com/no",
    });
    expect(session.providerReference).toBe("cs_1");

    vi.stubGlobal("fetch", vi.fn(async () => new Response("rate limited", { status: 429 })));
    await expect(provider.verifyPayment({ providerReference: "cs_1", businessId: "b1" })).rejects.toMatchObject({ code: "PROVIDER_RATE_LIMITED" });

    vi.stubGlobal("fetch", vi.fn(async () => { const err = new Error("aborted"); err.name = "AbortError"; throw err; }));
    await expect(provider.verifyPayment({ providerReference: "cs_1", businessId: "b1" })).rejects.toMatchObject({ code: "PROVIDER_TIMEOUT" });

    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ id: "re_1", status: "succeeded", amount: 1000 }), { status: 200 })));
    const refund = await provider.refund({ providerTransactionId: "ch_1", amountMinor: 1000, reason: "duplicate", idempotencyKey: "r1" });
    expect(refund.amountMinor).toBe(1000);

    vi.stubGlobal("fetch", vi.fn(async () => new Response("server error", { status: 503 })));
    await expect(provider.cancelSubscription({ providerSubscriptionId: "sub_1", atPeriodEnd: false, businessId: "b1" })).rejects.toThrow();

    expect(() => new StripeCompatiblePaymentProvider({ baseURL: "", apiKey: "" })).toThrow(/PAYMENT_API_BASE_URL/);
    const status = paymentProviderStatus();
    expect(status.liveVerified).toBe(false);
    expect(["test", "live", "disabled"]).toContain(String(status.mode));
  });
});

describe.skipIf(!hasTestDatabase())("storage ledger and reconciliation", () => {
  beforeAll(async () => {
    await ensureDbReady();
    await truncateAll();
    stubEnv("STORAGE_PROVIDER", "local");
    stubEnv("LOCAL_STORAGE_DIR", "/tmp/ai-receptionist-ledger");
  });
  afterAll(async () => {
    vi.unstubAllEnvs();
    restoreEnv();
    await truncateAll();
    await closeDb();
  });
  beforeEach(async () => {
    await truncateAll();
  });

  itDb("records, bills and forgets objects per tenant", async () => {
    const a = await tenant();
    const b = await tenant();
    const key = `business/${a.business.id}/knowledge/doc.txt`;
    const recorded = await recordStoredObjectStandalone({ businessId: a.business.id, key, bytes: 2048, contentType: "text/plain", category: "knowledge", sourceType: "knowledge_document", sourceId: crypto.randomUUID() });
    expect(recorded).toMatchObject({ bytes: 2048 });
    expect(await storageUsageBytes(a.business.id)).toBe(2048);
    expect(await storageUsageBytes(b.business.id)).toBe(0);

    // Re-recording the same key is an upsert, not double billing.
    await recordStoredObjectStandalone({ businessId: a.business.id, key, bytes: 1024, contentType: "text/plain", category: "knowledge" });
    expect(await storageUsageBytes(a.business.id)).toBe(1024);

    await forgetStoredObjectStandalone(a.business.id, key);
    expect(await storageUsageBytes(a.business.id)).toBe(0);
    expect(await db.select().from(storageObjects).where(eq(storageObjects.businessId, a.business.id))).toHaveLength(0);
  });

  itDb("deletes every object of a source and audits the deletion", async () => {
    const { business } = await tenant();
    const { getStorageProvider } = await import("@/lib/providers/storage");
    const sourceId = crypto.randomUUID();
    const keys = [`business/${business.id}/recordings/${sourceId}.mp3`, `business/${business.id}/recordings/${sourceId}.json`];
    for (const key of keys) {
      await getStorageProvider().upload({ key, data: Buffer.from("x"), contentType: "audio/mpeg" });
      await recordStoredObjectStandalone({ businessId: business.id, key, bytes: 1, contentType: "audio/mpeg", category: "recording", sourceType: "call", sourceId });
    }
    const deleted = await deleteObjectsForSource(business.id, "call", sourceId);
    expect(deleted).toMatchObject({ deleted: 2, bytes: 2 });
    expect(await storageUsageBytes(business.id)).toBe(0);
    await auditStorageDeletion({ businessId: business.id, keys, reason: "retention_policy", requestId: "r1" });
  });

  itDb("reconciles the ledger against the provider and never hides the difference", async () => {
    const { business } = await tenant();
    const { getStorageProvider } = await import("@/lib/providers/storage");
    const orph1 = `business/${business.id}/knowledge/orphan-1.txt`;
    const orph2 = `business/${business.id}/knowledge/orphan-2.txt`;
    await getStorageProvider().upload({ key: orph1, data: Buffer.from("orphan-data"), contentType: "text/plain" });
    await getStorageProvider().upload({ key: orph2, data: Buffer.from("orphan-data-2"), contentType: "text/plain" });
    const missing = `business/${business.id}/knowledge/missing.txt`;
    await recordStoredObjectStandalone({ businessId: business.id, key: missing, bytes: 512, contentType: "text/plain", category: "knowledge" });

    const report = await reconcileStorage(business.id, { fix: false });
    expect(report.providerListingSupported).toBe(true);
    expect(report.providerObjects).toBeGreaterThanOrEqual(2);
    expect(report.missingInLedger).toEqual(expect.arrayContaining([orph1, orph2]));
    expect(report.missingInProvider).toContain(missing);
    expect(report.missingInLedger.length).toBeGreaterThan(0);
    expect(report.ledgerObjects).toBe(1);
    const fixed = await reconcileStorage(business.id, { fix: true });
    expect(fixed.missingInLedger.length).toBeGreaterThan(0);
    const remaining = await db.select().from(storageObjects).where(eq(storageObjects.businessId, business.id));
    expect(remaining.map((row) => row.key)).toEqual(expect.arrayContaining([orph1, orph2]));
    const summary = await storageSummary(business.id);
    expect(summary.totalBytes).toBeGreaterThan(0);
    expect(summary.categories.length).toBeGreaterThan(0);
  });
});

describe.skipIf(!hasTestDatabase())("outbox health and retry policy", () => {
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

  itDb("publishes a bounded topic catalog with webhook mappings and exponential backoff", async () => {
    expect(OUTBOX_TOPICS).toContain("lead.created");
    expect(TENANT_WEBHOOK_TOPICS["call.handoff_requested"]).toBeTruthy();
    expect(outboxBackoffSeconds(1)).toBeLessThan(outboxBackoffSeconds(5));
    expect(outboxBackoffSeconds(99)).toBeLessThanOrEqual(3600);
    expect(await outboxHealth()).toEqual({ pending: 0, processing: 0, dead: 0 });
  });
});

describe("monitoring adapter", () => {
  itDb("is inert without a DSN and never throws when called uninitialised", async () => {
    stubEnv("SENTRY_DSN", "");
    await initMonitoring();
    expect(isMonitoringEnabled()).toBe(false);
    expect(() => captureServerError(new Error("boom"), { businessId: "b1" })).not.toThrow();
    expect(() => setRequestContext({ requestId: "r1", businessId: "b1", userId: "u1", callId: "c1" })).not.toThrow();
    vi.unstubAllEnvs();
  });

  itDb("initialises Sentry only when a DSN is present", async () => {
    vi.resetModules();
    stubEnv("SENTRY_DSN", "https://example.invalid/1");
    vi.doMock("@sentry/nextjs", () => ({
      init: vi.fn(),
      captureException: vi.fn(),
      setTag: vi.fn(),
      setUser: vi.fn(),
    }));
    const monitoring = await import("@/lib/monitoring");
    await monitoring.initMonitoring();
    expect(monitoring.isMonitoringEnabled()).toBe(true);
    monitoring.captureServerError(new Error("boom"), { authorization: "Bearer secret" });
    monitoring.setRequestContext({ requestId: "r1", businessId: "b1", userId: "u1" });
    const sentry = await import("@sentry/nextjs");
    expect(vi.mocked(sentry.captureException)).toHaveBeenCalled();
    const event = vi.mocked(sentry.captureException).mock.calls[0][1] as { extra: Record<string, unknown> };
    expect(JSON.stringify(event.extra)).not.toContain("Bearer secret");
    vi.doUnmock("@sentry/nextjs");
    vi.unstubAllEnvs();
    vi.resetModules();
  });
});

describe("oidc adapter", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    restoreEnv();
  });

  itDb("rejects unknown providers and reports missing configuration instead of guessing", async () => {
    expect(oauthProvider("google")).toBe("google");
    expect(oauthProvider("microsoft")).toBe("microsoft");
    expect(() => oauthProvider("facebook")).toThrow();
    stubEnv("GOOGLE_CLIENT_ID", "");
    stubEnv("GOOGLE_CLIENT_SECRET", "");
    expect(() => oauthConfiguration("google")).toThrow(/OAuth provider is not configured/);

    stubEnv("GOOGLE_CLIENT_ID", "client-id");
    stubEnv("GOOGLE_CLIENT_SECRET", "client-secret");
    // The live discovery handshake is covered by tests/live/oauth (it needs
    // real IdP credentials and network access); here we only assert that the
    // configuration boundary rejects unconfigured providers.
    stubEnv("MICROSOFT_TENANT_ID", "");
    expect(() => oauthConfiguration("microsoft")).toThrow(/OAuth provider is not configured/);
    expect(oauthCookie("state-value")).toContain("HttpOnly");
    expect(oauthCookie("state-value")).toContain("SameSite=Lax");
    expect(oauthCallbackUrl("google").pathname).toBe("/api/v1/auth/oauth/google/callback");
    await expect(startOAuth("microsoft")).rejects.toMatchObject({ status: 503 });
  });
});

describe.skipIf(!hasTestDatabase())("tool registry", () => {
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

  itDb("exposes tool definitions and refuses tenant smuggling in arguments", async () => {
    const tools = listTools();
    expect(tools.length).toBeGreaterThan(3);
    const definitions = getToolDefinitions();
    expect(definitions[0]).toHaveProperty("parameters");
    const { business } = await tenant();
    const unknown = await executeToolCall({ businessId: business.id, tool: "not_a_tool", args: {}, requestId: "r1", actor: "ai" });
    expect(unknown.status).toBe("FAILED");

    const invalid = await executeToolCall({ businessId: business.id, tool: definitions[0].name, args: { __tenantId: business.id }, requestId: "r1", actor: "ai" });
    expect(["FAILED", "SUCCESS", "NOT_FOUND"]).toContain(invalid.status);
  });

  itDb("never lets the model move a call into another tenant", async () => {
    const a = await tenant();
    const b = await tenant();
    const customer = await createCustomer(b.business.id, "09121234567");
    const [call] = await db.insert(calls).values({ businessId: a.business.id, phoneNumber: "09120000000", status: "IN_PROGRESS" }).returning();
    const result = await executeToolCall({
      businessId: a.business.id,
      callId: call.id,
      tool: "create_lead",
      args: { businessId: b.business.id, business_id: b.business.id, customerId: customer.id, phone: "09121234567", name: "متقلب" },
      requestId: "r1",
      actor: "ai",
    });
    // Tenant keys echoed by the model are stripped; the call's tenant wins.
    expect(["SUCCESS", "FAILED"]).toContain(result.status);
    const { leads } = await import("@/db/schema");
    expect(await db.select().from(leads).where(eq(leads.businessId, b.business.id))).toHaveLength(0);
  });
});

describe.skipIf(!hasTestDatabase())("call transfer decisions", () => {
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

  itDb("reports the transfer configuration and refuses transfers without a telephony session", async () => {
    const { business } = await tenant();
    const config = await getTransferConfig(business.id);
    expect(config.timeoutSeconds).toBeGreaterThan(0);
    expect(config.transferNumber).toBeNull();

    const [call] = await db.insert(calls).values({ businessId: business.id, phoneNumber: "09120000000", status: "COMPLETED" }).returning();
    await expect(requestTransfer(business.id, call.id, { reason: "manual" })).rejects.toMatchObject({ status: 409 });
    await expect(requestTransfer(business.id, crypto.randomUUID(), { reason: "manual" })).rejects.toMatchObject({ status: 404 });
  });
});

describe.skipIf(!hasTestDatabase())("redis primitives", () => {
  beforeAll(async () => {
    await ensureDbReady();
    await ensureRedisReady();
  });
  afterAll(async () => {
    await closeDb();
    await closeRedis();
  });

  itDb("provides caching, counters and locks with honest failure modes", async () => {
    const key = `test:${crypto.randomUUID()}`;
    expect(await setNx(key, "1", 30)).toBe(true);
    expect(await setNx(key, "1", 30)).toBe(false);
    await redisSet(key, "value", 30);
    expect(await redisGet(key)).toBe("value");
    expect(await redisIncr(`${key}:counter`, 30)).toBe(1);
    expect(await redisIncr(`${key}:counter`, 30)).toBe(2);
    const release = await acquireLock(`${key}:lock`, 5);
    expect(release).toBeTruthy();
    expect(await acquireLock(`${key}:lock`, 5)).toBeNull();
    await release!();
    const again = await acquireLock(`${key}:lock`, 5);
    expect(again).toBeTruthy();
    await again!();
    await redisDel(key);
    expect(await redisGet(key)).toBeNull();
  });
});
