import { NextRequest } from "next/server";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { closeDb, db } from "@/db";
import { businesses, calls, webhookEvents } from "@/db/schema";
import { resetEnvCache } from "@/lib/env";
import { computeHmacHex } from "@/lib/security";
import {
  validateMediaBootstrapConfig,
  type MediaBootstrapConfig,
} from "@/lib/voice/media-bootstrap";
import { POST as callStarted } from "@/app/api/v1/webhooks/voice/call-started/route";
import { ensureDbReady, hasTestDatabase, itDb, truncateAll } from "../helpers/db";
import { uniqueTestIp } from "../helpers/http";
import { createBusiness } from "../helpers/fixtures";

const WEBHOOK_SECRET = "dev-webhook-secret";
const MEDIA_SECRET = "s3-media-signing-secret";
const MEDIA_URL = "wss://media.example.test/media";
let keySeq = 0;
const nextKey = () => `mb-${Date.now()}-${keySeq++}`;
const extId = () => `mb-${Date.now()}-${Math.random().toString(36).slice(2)}`;

function post(body: unknown, key: string): NextRequest {
  const raw = JSON.stringify(body);
  return new NextRequest(
    new Request("http://localhost/api/v1/webhooks/voice/call-started", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-webhook-signature": computeHmacHex(WEBHOOK_SECRET, raw),
        "x-idempotency-key": key,
        "x-real-ip": uniqueTestIp(),
      },
      body: raw,
    }),
  );
}

type CapturedCall = { url: string; body: Record<string, unknown> };
type Scripted = { ok: boolean; status: number; body: unknown };

const OK = { ok: true, status: 200, body: {} };
const FAIL_500 = { ok: false, status: 500, body: { error: "boom" } };

describe("fail-closed media bootstrap (real database, scripted gateway)", () => {
  const runIntegration = hasTestDatabase();
  const savedEnv = { ...process.env };
  const gatewayCalls: CapturedCall[] = [];
  let script: Scripted[] = [];
  let voiceEnvSnapshot: Record<string, string | undefined> = {};

  const answers = () => gatewayCalls.filter((c) => c.url.endsWith("/answer"));
  const streamStarts = () => gatewayCalls.filter((c) => c.url.endsWith("/stream/start"));

  beforeAll(async () => {
    if (!(await ensureDbReady())) return;
    await truncateAll();
    process.env.VOICE_PROVIDER = "generic";
    process.env.VOICE_API_BASE_URL = "https://gateway.example.test";
    process.env.VOICE_API_KEY = "test-gateway-key";
    process.env.VOICE_AUTO_ANSWER = "true";
    process.env.VOICE_MEDIA_PUBLIC_URL = MEDIA_URL;
    process.env.VOICE_MEDIA_TOKEN = MEDIA_SECRET;
    resetEnvCache();
    voiceEnvSnapshot = {
      VOICE_PROVIDER: process.env.VOICE_PROVIDER,
      VOICE_API_BASE_URL: process.env.VOICE_API_BASE_URL,
      VOICE_API_KEY: process.env.VOICE_API_KEY,
      VOICE_AUTO_ANSWER: process.env.VOICE_AUTO_ANSWER,
      VOICE_MEDIA_PUBLIC_URL: process.env.VOICE_MEDIA_PUBLIC_URL,
      VOICE_MEDIA_TOKEN: process.env.VOICE_MEDIA_TOKEN,
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: unknown, init?: { body?: unknown }) => {
        gatewayCalls.push({
          url: String(url),
          body: (init?.body ? JSON.parse(String(init.body)) : {}) as Record<string, unknown>,
        });
        const next = script.shift() ?? OK;
        return { ok: next.ok, status: next.status, text: async () => JSON.stringify(next.body) };
      }),
    );
  });

  beforeEach(async () => {
    if (!(await ensureDbReady())) return;
    await truncateAll();
    gatewayCalls.length = 0;
    script = [];
  });

  afterEach(() => {
    Object.assign(process.env, voiceEnvSnapshot);
    resetEnvCache();
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    for (const key of Object.keys(process.env)) {
      if (!(key in savedEnv)) delete process.env[key];
    }
    Object.assign(process.env, savedEnv);
    resetEnvCache();
    if (runIntegration) {
      await truncateAll().catch(() => undefined);
      await closeDb();
    }
  });

  function setVoiceEnv(patch: Record<string, string>) {
    Object.assign(process.env, patch);
    resetEnvCache();
  }

  async function inboxRow(key: string) {
    const [row] = await db
      .select()
      .from(webhookEvents)
      .where(and(eq(webhookEvents.scope, "voice:call-started"), eq(webhookEvents.idempotencyKey, key)))
      .limit(1);
    return row ?? null;
  }

  async function callRow(externalCallId: string) {
    const [row] = await db.select().from(calls).where(eq(calls.externalCallId, externalCallId)).limit(1);
    return row ?? null;
  }

  type StartedJson = {
    ok: boolean;
    callId: string;
    duplicate: boolean;
    media: { attempted: boolean; answered: boolean; streaming: boolean; reason?: string };
  };

  // -- Pure config validation ------------------------------------------------
  describe("validateMediaBootstrapConfig", () => {
    const valid: MediaBootstrapConfig = {
      provider: "generic",
      gatewayBaseUrl: "https://gateway.example.test",
      gatewayApiKey: "k",
      autoAnswer: true,
      mediaPublicUrl: "wss://media.example.test/media",
      mediaTokenSecret: "s",
      mediaTokenTtlSeconds: 900,
    };
    it("accepts a complete valid config", () => {
      expect(validateMediaBootstrapConfig(valid)).toEqual({ ok: true });
    });
    it("rejects a non-generic provider", () => {
      expect(validateMediaBootstrapConfig({ ...valid, provider: "dev" })).toEqual({
        ok: false,
        reason: "voice_provider_not_configured",
      });
    });
    it("rejects missing gateway credentials", () => {
      expect(validateMediaBootstrapConfig({ ...valid, gatewayBaseUrl: "" })).toEqual({
        ok: false,
        reason: "voice_provider_not_configured",
      });
      expect(validateMediaBootstrapConfig({ ...valid, gatewayApiKey: "  " })).toEqual({
        ok: false,
        reason: "voice_provider_not_configured",
      });
    });
    it("rejects disabled auto-answer", () => {
      expect(validateMediaBootstrapConfig({ ...valid, autoAnswer: false })).toEqual({
        ok: false,
        reason: "auto_answer_disabled",
      });
    });
    it("rejects a missing media URL", () => {
      expect(validateMediaBootstrapConfig({ ...valid, mediaPublicUrl: "" })).toEqual({
        ok: false,
        reason: "media_public_url_missing",
      });
    });
    it("rejects a non-websocket media URL", () => {
      expect(validateMediaBootstrapConfig({ ...valid, mediaPublicUrl: "https://media.example.test/x" })).toEqual({
        ok: false,
        reason: "media_config_invalid",
      });
    });
    it("rejects a malformed media URL", () => {
      expect(validateMediaBootstrapConfig({ ...valid, mediaPublicUrl: "::::" })).toEqual({
        ok: false,
        reason: "media_config_invalid",
      });
    });
    it("rejects a missing token secret", () => {
      expect(validateMediaBootstrapConfig({ ...valid, mediaTokenSecret: "" })).toEqual({
        ok: false,
        reason: "media_token_missing",
      });
    });
    it("rejects a non-positive token TTL", () => {
      expect(validateMediaBootstrapConfig({ ...valid, mediaTokenTtlSeconds: 0 })).toEqual({
        ok: false,
        reason: "media_config_invalid",
      });
    });
  });

  // -- A) config failure → graceful 200, never answer -------------------------
  describe("config failures (graceful 200, no answer)", () => {
    itDb("missing provider → 200, answered=false, no answerCall", async () => {
      setVoiceEnv({ VOICE_PROVIDER: "dev" });
      const business = await createBusiness(`MB No Provider ${Date.now()}`);
      const key = nextKey();
      const externalCallId = extId();
      const res = await callStarted(
        post({ business_id: business.id, external_call_id: externalCallId, phone_number: "09123456789" }, key),
      );
      expect(res.status).toBe(200);
      const json = (await res.json()) as StartedJson;
      expect(json.media).toMatchObject({
        attempted: false,
        answered: false,
        reason: "voice_provider_not_configured",
      });
      expect(answers()).toHaveLength(0);
      expect(streamStarts()).toHaveLength(0);
      // The call record and inbox event survive the config failure.
      expect(await callRow(externalCallId)).not.toBeNull();
      expect(await inboxRow(key)).toMatchObject({ status: "COMPLETED" });
    });

    itDb("env autoAnswer=false → 200, no answerCall", async () => {
      setVoiceEnv({ VOICE_AUTO_ANSWER: "false" });
      const business = await createBusiness(`MB No Auto ${Date.now()}`);
      const key = nextKey();
      const res = await callStarted(
        post({ business_id: business.id, external_call_id: extId(), phone_number: "09123456789" }, key),
      );
      expect(res.status).toBe(200);
      expect(((await res.json()) as StartedJson).media).toMatchObject({
        attempted: false,
        answered: false,
        reason: "auto_answer_disabled",
      });
      expect(answers()).toHaveLength(0);
    });

    itDb("per-business autoAnswer=false → 200, no answerCall", async () => {
      const business = await createBusiness(`MB Biz No Auto ${Date.now()}`);
      const [biz] = await db.select().from(businesses).where(eq(businesses.id, business.id)).limit(1);
      await db
        .update(businesses)
        .set({ settings: { ...((biz?.settings as Record<string, unknown>) ?? {}), voice: { autoAnswer: false } } })
        .where(eq(businesses.id, business.id));
      const key = nextKey();
      const res = await callStarted(
        post({ business_id: business.id, external_call_id: extId(), phone_number: "09123456789" }, key),
      );
      expect(res.status).toBe(200);
      expect(((await res.json()) as StartedJson).media).toMatchObject({
        attempted: false,
        answered: false,
        reason: "auto_answer_disabled",
      });
      expect(answers()).toHaveLength(0);
    });

    itDb("missing media URL → 200, no answerCall, call row persisted", async () => {
      setVoiceEnv({ VOICE_MEDIA_PUBLIC_URL: "" });
      const business = await createBusiness(`MB No URL ${Date.now()}`);
      const key = nextKey();
      const externalCallId = extId();
      const res = await callStarted(
        post({ business_id: business.id, external_call_id: externalCallId, phone_number: "09123456789" }, key),
      );
      expect(res.status).toBe(200);
      expect(((await res.json()) as StartedJson).media).toMatchObject({
        attempted: false,
        answered: false,
        reason: "media_public_url_missing",
      });
      expect(answers()).toHaveLength(0);
      const row = await callRow(externalCallId);
      expect(row).not.toBeNull();
      expect(row?.status).toBe("RINGING");
    });

    itDb("missing token secret → 200, no answerCall", async () => {
      setVoiceEnv({ VOICE_MEDIA_TOKEN: "" });
      const business = await createBusiness(`MB No Secret ${Date.now()}`);
      const key = nextKey();
      const res = await callStarted(
        post({ business_id: business.id, external_call_id: extId(), phone_number: "09123456789" }, key),
      );
      expect(res.status).toBe(200);
      expect(((await res.json()) as StartedJson).media).toMatchObject({
        attempted: false,
        answered: false,
        reason: "media_token_missing",
      });
      expect(answers()).toHaveLength(0);
    });

    itDb("invalid media URL → 200 media_config_invalid, no answerCall", async () => {
      const business = await createBusiness(`MB Bad URL ${Date.now()}`);
      for (const bad of ["https://media.example.test/not-websocket", "::::"]) {
        setVoiceEnv({ VOICE_MEDIA_PUBLIC_URL: bad });
        const key = nextKey();
        const res = await callStarted(
          post({ business_id: business.id, external_call_id: extId(), phone_number: "09123456789" }, key),
        );
        expect(res.status).toBe(200);
        expect(((await res.json()) as StartedJson).media).toMatchObject({
          attempted: false,
          answered: false,
          reason: "media_config_invalid",
        });
      }
      expect(answers()).toHaveLength(0);
    });

    itDb("no broken-config path ever calls answerCall (aggregate invariant)", async () => {
      const business = await createBusiness(`MB Matrix ${Date.now()}`);
      const variants: Record<string, string>[] = [
        { VOICE_PROVIDER: "dev" },
        { VOICE_AUTO_ANSWER: "false" },
        { VOICE_MEDIA_PUBLIC_URL: "" },
        { VOICE_MEDIA_TOKEN: "" },
        { VOICE_MEDIA_PUBLIC_URL: "http://media.example.test/x" },
      ];
      for (const patch of variants) {
        setVoiceEnv({ ...voiceEnvSnapshot as Record<string, string>, ...patch });
        const res = await callStarted(
          post({ business_id: business.id, external_call_id: extId(), phone_number: "09123456789" }, nextKey()),
        );
        expect(res.status).toBe(200);
        expect(((await res.json()) as StartedJson).media.answered).toBe(false);
      }
      expect(answers()).toHaveLength(0);
      expect(streamStarts()).toHaveLength(0);
    });
  });

  // -- B) transient provider failure → retryable 502 --------------------------
  describe("transient failures (retryable 502)", () => {
    itDb("answer failure → 502, inbox FAILED, stream never attempted, call kept", async () => {
      // GenericVoiceProvider retries twice internally: 3 scripted failures
      // make one answerCall throw.
      script = [FAIL_500, FAIL_500, FAIL_500];
      const business = await createBusiness(`MB Answer Fail ${Date.now()}`);
      const key = nextKey();
      const externalCallId = extId();
      const body = { business_id: business.id, external_call_id: externalCallId, phone_number: "09123456789" };
      const res = await callStarted(post(body, key));
      expect(res.status).toBe(502);
      const err = (await res.json()) as { error: { code: string; message: string } };
      expect(err.error.code).toBe("VOICE_ERROR");
      expect(err.error.message).toContain("Voice answer failed");

      expect(answers()).toHaveLength(3);
      // startStream is never called before a successful answer.
      expect(streamStarts()).toHaveLength(0);

      const row = await inboxRow(key);
      expect(row).toMatchObject({ status: "FAILED", attempts: 1 });
      expect(row?.errorMessage).toContain("VOICE_ERROR");
      // Retryable failure does not lose the call record.
      expect(await callRow(externalCallId)).not.toBeNull();
    });

    itDb("stream failure → 502, inbox FAILED, answer durably recorded", async () => {
      script = [OK, FAIL_500, FAIL_500, FAIL_500];
      const business = await createBusiness(`MB Stream Fail ${Date.now()}`);
      const key = nextKey();
      const externalCallId = extId();
      const res = await callStarted(
        post({ business_id: business.id, external_call_id: externalCallId, phone_number: "09123456789" }, key),
      );
      expect(res.status).toBe(502);
      const err = (await res.json()) as { error: { code: string; message: string } };
      expect(err.error.code).toBe("VOICE_ERROR");
      expect(err.error.message).toContain("Voice stream start failed");

      expect(answers()).toHaveLength(1);
      expect(streamStarts()).toHaveLength(3);
      const row = await inboxRow(key);
      expect(row).toMatchObject({ status: "FAILED", attempts: 1 });
      const call = await callRow(externalCallId);
      expect(call).not.toBeNull();
      expect((call?.metadata as { bootstrap?: unknown })?.bootstrap).toMatchObject({ answered: true });
      expect((call?.metadata as { bootstrap?: { streaming?: boolean } })?.bootstrap?.streaming).not.toBe(true);
    });

    itDb("retry after answer_failed re-executes bootstrap with stable keys", async () => {
      script = [FAIL_500, FAIL_500, FAIL_500];
      const business = await createBusiness(`MB Retry Answer ${Date.now()}`);
      const key = nextKey();
      const externalCallId = extId();
      const body = { business_id: business.id, external_call_id: externalCallId, phone_number: "09123456789" };
      expect((await callStarted(post(body, key))).status).toBe(502);

      script = [OK, OK];
      const res = await callStarted(post(body, key));
      expect(res.status).toBe(200);
      const json = (await res.json()) as StartedJson;
      expect(json.media).toMatchObject({ attempted: true, answered: true, streaming: true });

      expect(await inboxRow(key)).toMatchObject({ status: "COMPLETED", attempts: 2 });
      // Same redelivery: still exactly one call row (idempotent + retryable).
      const rows = await db.select().from(calls).where(eq(calls.externalCallId, externalCallId));
      expect(rows).toHaveLength(1);
      // Every answer attempt (failed + retried) carries the SAME stable key.
      expect(answers()).toHaveLength(4);
      for (const a of answers()) expect(a.body.idempotencyKey).toBe(`answer:${json.callId}`);
      expect(streamStarts()).toHaveLength(1);
      expect(streamStarts()[0].body.idempotencyKey).toBe(`stream:${json.callId}`);
    });

    itDb("retry after stream_start_failed reconciles: no duplicate answer, stable stream key", async () => {
      script = [OK, FAIL_500, FAIL_500, FAIL_500];
      const business = await createBusiness(`MB Retry Stream ${Date.now()}`);
      const key = nextKey();
      const externalCallId = extId();
      const body = { business_id: business.id, external_call_id: externalCallId, phone_number: "09123456789" };
      expect((await callStarted(post(body, key))).status).toBe(502);

      script = [OK];
      const res = await callStarted(post(body, key));
      expect(res.status).toBe(200);
      expect(((await res.json()) as StartedJson).media).toMatchObject({
        attempted: true,
        answered: true,
        streaming: true,
      });

      // The answered stage is NOT repeated: exactly one answer overall.
      expect(answers()).toHaveLength(1);
      // The pending stream stage re-runs with the SAME stable key.
      expect(streamStarts()).toHaveLength(4);
      const keys = new Set(streamStarts().map((s) => s.body.idempotencyKey));
      expect([...keys]).toHaveLength(1);
      expect(await inboxRow(key)).toMatchObject({ status: "COMPLETED", attempts: 2 });
      const call = await callRow(externalCallId);
      expect((call?.metadata as { bootstrap?: unknown })?.bootstrap).toMatchObject({
        answered: true,
        streaming: true,
      });
    });
  });

  // -- C) ordering + success ---------------------------------------------------
  describe("ordering and success", () => {
    itDb("full success: answer → stream order, stable keys, per-call token", async () => {
      const business = await createBusiness(`MB Success ${Date.now()}`);
      const key = nextKey();
      const externalCallId = extId();
      const res = await callStarted(
        post({ business_id: business.id, external_call_id: externalCallId, phone_number: "09123456789" }, key),
      );
      expect(res.status).toBe(200);
      const json = (await res.json()) as StartedJson;
      expect(json.media).toMatchObject({ attempted: true, answered: true, streaming: true });
      expect(json.media.reason).toBeUndefined();

      expect(answers()).toHaveLength(1);
      expect(streamStarts()).toHaveLength(1);
      // validate → token → answer → stream: answer precedes stream/start.
      expect(gatewayCalls.map((c) => c.url)).toEqual([
        expect.stringContaining("/answer"),
        expect.stringContaining("/stream/start"),
      ]);
      expect(answers()[0].body.idempotencyKey).toBe(`answer:${json.callId}`);
      expect(streamStarts()[0].body.idempotencyKey).toBe(`stream:${json.callId}`);
      expect(streamStarts()[0].body.websocketUrl).toBe(MEDIA_URL);
      expect(String(streamStarts()[0].body.mediaToken).startsWith("v1.")).toBe(true);
      // The bearer token never leaks into the webhook response.
      expect(JSON.stringify(json)).not.toContain(String(streamStarts()[0].body.mediaToken).slice(0, 24));
      expect(await inboxRow(key)).toMatchObject({ status: "COMPLETED" });
    });

    itDb("completed bootstrap is not repeated on duplicate delivery", async () => {
      const business = await createBusiness(`MB Dup ${Date.now()}`);
      const key = nextKey();
      const externalCallId = extId();
      const body = { business_id: business.id, external_call_id: externalCallId, phone_number: "09123456789" };
      expect((await callStarted(post(body, key))).status).toBe(200);
      expect(answers()).toHaveLength(1);
      expect(streamStarts()).toHaveLength(1);

      // Same call, NEW header key: reconciles to "already done", no side effects.
      const res2 = await callStarted(post(body, nextKey()));
      expect(res2.status).toBe(200);
      expect(((await res2.json()) as StartedJson).media).toMatchObject({
        attempted: false,
        answered: true,
        streaming: true,
        reason: "duplicate",
      });
      expect(answers()).toHaveLength(1);
      expect(streamStarts()).toHaveLength(1);

      // Same key redelivery: inbox duplicate, provider untouched.
      const res3 = await callStarted(post(body, key));
      expect(res3.status).toBe(200);
      expect(await res3.json()).toMatchObject({ ok: true, duplicate: true });
      expect(answers()).toHaveLength(1);
      expect(streamStarts()).toHaveLength(1);
    });
  });
});
