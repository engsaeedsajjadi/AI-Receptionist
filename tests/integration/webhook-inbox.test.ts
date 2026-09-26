import { NextRequest } from "next/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { closeDb, db } from "@/db";
import { callMessages, calls, webhookEvents } from "@/db/schema";
import { AppError } from "@/lib/errors";
import { computeHmacHex } from "@/lib/security";
import {
  canonicalPayloadHash,
  claimWebhookInbox,
  completeWebhookInbox,
  failWebhookInbox,
  pruneWebhookInbox,
} from "@/lib/webhook-inbox";
import { ensureDbReady, hasTestDatabase, itDb, truncateAll } from "../helpers/db";
import { uniqueTestIp } from "../helpers/http";
import { createAgent, createBusiness } from "../helpers/fixtures";
import { POST as callStarted } from "@/app/api/v1/webhooks/voice/call-started/route";
import { POST as callEnded } from "@/app/api/v1/webhooks/voice/call-ended/route";
import { POST as transcript } from "@/app/api/v1/webhooks/voice/transcript/route";
import { POST as toolCall } from "@/app/api/v1/webhooks/voice/tool-call/route";
import { POST as audioWebhook } from "@/app/api/v1/webhooks/voice/audio/route";

const SECRET = "dev-webhook-secret";
let keySeq = 0;
const nextKey = (tag: string) => `inbox-${tag}-${Date.now()}-${keySeq++}`;
const extId = (tag: string) => `ext-${tag}-${Date.now()}-${Math.random().toString(36).slice(2)}`;

function postJson(body: unknown, key: string, path: string): NextRequest {
  const raw = JSON.stringify(body);
  return new NextRequest(
    new Request(`http://localhost${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-webhook-signature": computeHmacHex(SECRET, raw),
        "x-idempotency-key": key,
        "x-real-ip": uniqueTestIp(),
      },
      body: raw,
    }),
  );
}

async function seedCall(businessId: string, externalCallId: string) {
  const [row] = await db
    .insert(calls)
    .values({ businessId, externalCallId, phoneNumber: "09123456789", status: "IN_PROGRESS" })
    .returning();
  return row;
}

async function inboxRow(scope: string, key: string) {
  const [row] = await db
    .select()
    .from(webhookEvents)
    .where(and(eq(webhookEvents.scope, scope), eq(webhookEvents.idempotencyKey, key)))
    .limit(1);
  return row ?? null;
}

function mustProcess(
  claim: Awaited<ReturnType<typeof claimWebhookInbox>>,
): { eventId: string; leaseToken: string; attempts: number } {
  if (claim.decision !== "process") throw new Error(`expected process, got ${claim.decision}`);
  return claim;
}

describe.skipIf(!hasTestDatabase())("durable webhook inbox (real database)", () => {
  beforeAll(async () => {
    if (!(await ensureDbReady())) return;
    await truncateAll();
  });
  beforeEach(async () => {
    if (!(await ensureDbReady())) return;
    await truncateAll();
  });
  afterAll(async () => {
    if (hasTestDatabase()) {
      await truncateAll().catch(() => undefined);
      await closeDb();
    }
  });

  // -- Group 1: exactly-once claim -------------------------------------------
  describe("exactly-once claim", () => {
    it("canonical hash ignores key order but not content", () => {
      expect(canonicalPayloadHash({ a: 1, b: 2 })).toBe(canonicalPayloadHash({ b: 2, a: 1 }));
      expect(canonicalPayloadHash({ a: 1, b: 2 })).not.toBe(canonicalPayloadHash({ a: 1, b: 3 }));
      expect(canonicalPayloadHash({ a: 1, b: undefined })).toBe(canonicalPayloadHash({ a: 1 }));
    });

    itDb("first claim processes, redelivery (after complete) is a duplicate", async () => {
      const key = nextKey("claim");
      const hash = canonicalPayloadHash({ a: 1 });
      const first = mustProcess(await claimWebhookInbox({ scope: "test:inbox", key, payloadHash: hash }));
      expect(first.attempts).toBe(1);
      expect(await completeWebhookInbox(first.eventId, first.leaseToken, { n: 1 })).toBe(true);

      const second = await claimWebhookInbox({ scope: "test:inbox", key, payloadHash: hash });
      expect(second).toMatchObject({ decision: "duplicate", eventId: first.eventId });

      const rows = await db.select().from(webhookEvents).where(eq(webhookEvents.idempotencyKey, key));
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ status: "COMPLETED", attempts: 1, result: { n: 1 } });
      expect(rows[0].completedAt).not.toBeNull();
    });

    itDb("complete/fail are fenced by the lease token", async () => {
      const key = nextKey("fence");
      const c = mustProcess(
        await claimWebhookInbox({ scope: "test:inbox", key, payloadHash: canonicalPayloadHash({}) }),
      );
      expect(await completeWebhookInbox(c.eventId, "wrong-token")).toBe(false);
      expect(await failWebhookInbox(c.eventId, "wrong-token", new Error("x"))).toBe(false);
      expect((await inboxRow("test:inbox", key))?.status).toBe("PROCESSING");

      expect(await failWebhookInbox(c.eventId, c.leaseToken, new AppError(500, "INTERNAL_ERROR", "boom"))).toBe(
        true,
      );
      const row = await inboxRow("test:inbox", key);
      expect(row?.status).toBe("FAILED");
      expect(row?.errorMessage).toContain("INTERNAL_ERROR");
    });

    itDb("same key in different scopes claims independently", async () => {
      const key = nextKey("scoped");
      const hash = canonicalPayloadHash({ a: 1 });
      const a = mustProcess(await claimWebhookInbox({ scope: "test:scope-a", key, payloadHash: hash }));
      const b = mustProcess(await claimWebhookInbox({ scope: "test:scope-b", key, payloadHash: hash }));
      expect(a.eventId).not.toBe(b.eventId);
      expect(await completeWebhookInbox(a.eventId, a.leaseToken)).toBe(true);
      expect(await completeWebhookInbox(b.eventId, b.leaseToken)).toBe(true);
    });

    itDb("RECEIVED rows are immediately claimable (crashed receiver)", async () => {
      const key = nextKey("received");
      const hash = canonicalPayloadHash({ n: 7 });
      await db.insert(webhookEvents).values({
        scope: "test:inbox",
        idempotencyKey: key,
        status: "RECEIVED",
        payloadHash: hash,
      });
      const c = mustProcess(await claimWebhookInbox({ scope: "test:inbox", key, payloadHash: hash }));
      expect(c.attempts).toBe(1);
    });

    itDb("live PROCESSING lease → busy (no wait)", async () => {
      const key = nextKey("busy");
      const hash = canonicalPayloadHash({ n: 1 });
      await db.insert(webhookEvents).values({
        scope: "test:inbox",
        idempotencyKey: key,
        status: "PROCESSING",
        payloadHash: hash,
        attempts: 1,
        leaseToken: "holder",
        leaseExpiresAt: new Date(Date.now() + 60_000),
      });
      const c = await claimWebhookInbox({ scope: "test:inbox", key, payloadHash: hash, waitMs: 0 });
      expect(c.decision).toBe("busy");
      if (c.decision !== "busy") throw new Error("unreachable");
      expect(c.retryAfterSeconds).toBeGreaterThanOrEqual(1);
      expect(c.retryAfterSeconds).toBeLessThanOrEqual(30);
    });

    itDb("expired PROCESSING lease is reclaimed with a fresh lease", async () => {
      const key = nextKey("reclaim");
      const hash = canonicalPayloadHash({ n: 1 });
      await db.insert(webhookEvents).values({
        scope: "test:inbox",
        idempotencyKey: key,
        status: "PROCESSING",
        payloadHash: hash,
        attempts: 1,
        leaseToken: "dead-worker",
        leaseExpiresAt: new Date(Date.now() - 1000),
      });
      const c = mustProcess(await claimWebhookInbox({ scope: "test:inbox", key, payloadHash: hash }));
      expect(c.attempts).toBe(2);
      expect(c.leaseToken).not.toBe("dead-worker");
    });

    itDb("completed-with-different-bytes is a conflict, not a duplicate", async () => {
      const key = nextKey("conflict");
      const c = mustProcess(
        await claimWebhookInbox({ scope: "test:inbox", key, payloadHash: canonicalPayloadHash({ v: "A" }) }),
      );
      expect(await completeWebhookInbox(c.eventId, c.leaseToken)).toBe(true);
      const again = await claimWebhookInbox({
        scope: "test:inbox",
        key,
        payloadHash: canonicalPayloadHash({ v: "B" }),
      });
      expect(again).toMatchObject({ decision: "conflict", eventId: c.eventId });
    });

    itDb("prune deletes only old terminal rows", async () => {
      const old = new Date(Date.now() - 40 * 86_400_000);
      const mk = (tag: string, status: "COMPLETED" | "FAILED" | "PROCESSING", createdAt: Date) =>
        db.insert(webhookEvents).values({
          scope: "test:prune",
          idempotencyKey: `${tag}-${Date.now()}`,
          status,
          payloadHash: "h",
          createdAt,
        });
      await mk("old-completed", "COMPLETED", old);
      await mk("old-failed", "FAILED", old);
      await mk("old-processing", "PROCESSING", old);
      await mk("new-completed", "COMPLETED", new Date());
      expect(await pruneWebhookInbox(30)).toBe(2);
      const left = await db.select().from(webhookEvents).where(eq(webhookEvents.scope, "test:prune"));
      expect(left.map((r) => r.status).sort()).toEqual(["COMPLETED", "PROCESSING"]);
    });
  });

  // -- Group 2: Redis-down acceptance ----------------------------------------
  describe("redis-down acceptance", () => {
    itDb("transcript webhook is accepted while Redis is down", async () => {
      const business = await createBusiness(`Inbox Redis Down ${Date.now()}`);
      const call = await seedCall(business.id, extId("redisdown"));
      const { resetEnvCache } = await import("@/lib/env");
      const { closeRedis } = await import("@/lib/redis");
      const saved = process.env.REDIS_URL;
      // Dead port (discard): connection refused immediately, no hang.
      process.env.REDIS_URL = "redis://127.0.0.1:9";
      resetEnvCache();
      await closeRedis();
      try {
        const body = {
          business_id: business.id,
          external_call_id: call.externalCallId,
          transcript: "redis is down but the webhook lands",
          event_id: `evt-redisdown-${Date.now()}`,
        };
        const key = nextKey("redisdown");
        const res = await transcript(postJson(body, key, "/api/v1/webhooks/voice/transcript"));
        expect(res.status).toBe(200);
        expect(await res.json()).toMatchObject({ ok: true, duplicate: false });

        const messages = await db.select().from(callMessages).where(eq(callMessages.callId, call.id));
        expect(messages).toHaveLength(1);
        expect((await inboxRow("voice:transcript", key))?.status).toBe("COMPLETED");
      } finally {
        if (saved === undefined) delete process.env.REDIS_URL;
        else process.env.REDIS_URL = saved;
        resetEnvCache();
        await closeRedis();
      }
    });
  });

  // -- Group 3: crash recovery -----------------------------------------------
  describe("crash recovery / lease reclaim", () => {
    itDb("redelivery after a crash reclaims the expired lease and processes once", async () => {
      const business = await createBusiness(`Inbox Reclaim ${Date.now()}`);
      const call = await seedCall(business.id, extId("reclaim"));
      const key = nextKey("crash");
      // All validated fields explicit so the test-side hash equals the route's.
      const body = {
        business_id: business.id,
        external_call_id: call.externalCallId,
        transcript: "reclaim me",
        role: "CUSTOMER",
        is_final: true,
        event_id: `evt-crash-${Date.now()}`,
      };
      // A worker that died mid-processing: lease expired, attempt recorded.
      await db.insert(webhookEvents).values({
        scope: "voice:transcript",
        idempotencyKey: key,
        status: "PROCESSING",
        payloadHash: canonicalPayloadHash(body),
        businessId: business.id,
        attempts: 1,
        leaseToken: "dead-worker",
        leaseExpiresAt: new Date(Date.now() - 1000),
      });

      const res = await transcript(postJson(body, key, "/api/v1/webhooks/voice/transcript"));
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ ok: true, duplicate: false });

      const messages = await db.select().from(callMessages).where(eq(callMessages.callId, call.id));
      expect(messages).toHaveLength(1);
      expect(messages[0].content).toBe("reclaim me");
      const row = await inboxRow("voice:transcript", key);
      expect(row).toMatchObject({ status: "COMPLETED", attempts: 2 });
      expect(row?.leaseToken).not.toBe("dead-worker");
    });
  });

  // -- Group 4: concurrent deliveries ----------------------------------------
  describe("concurrent deliveries", () => {
    itDb("parallel same-key deliveries execute exactly once", async () => {
      const business = await createBusiness(`Inbox Concurrency ${Date.now()}`);
      const call = await seedCall(business.id, extId("conc"));
      const key = nextKey("conc");
      const body = {
        business_id: business.id,
        external_call_id: call.externalCallId,
        transcript: "exactly once under concurrency",
        event_id: `evt-conc-${Date.now()}`,
      };
      const results = await Promise.all(
        [0, 1, 2, 3].map(() => transcript(postJson(body, key, "/api/v1/webhooks/voice/transcript"))),
      );
      for (const res of results) expect(res.status).toBe(200);
      const payloads = (await Promise.all(results.map((r) => r.json()))) as { duplicate: boolean }[];
      expect(payloads.filter((p) => p.duplicate === false)).toHaveLength(1);
      expect(payloads.filter((p) => p.duplicate === true)).toHaveLength(3);

      const messages = await db.select().from(callMessages).where(eq(callMessages.callId, call.id));
      expect(messages).toHaveLength(1);
      expect(await inboxRow("voice:transcript", key)).toMatchObject({ status: "COMPLETED", attempts: 1 });
    });
  });

  // -- Group 5: failure states ------------------------------------------------
  describe("failure states", () => {
    itDb("failed delivery records FAILED; retry with the same key re-processes", async () => {
      const business = await createBusiness(`Inbox Failure ${Date.now()}`);
      const externalCallId = extId("failstate");
      const key = nextKey("failstate");
      const body = {
        business_id: business.id,
        external_call_id: externalCallId,
        transcript: "will fail, then succeed",
        event_id: `evt-failstate-${Date.now()}`,
      };
      // Unknown call → 404, honestly recorded as FAILED (not a fake dup).
      const r1 = await transcript(postJson(body, key, "/api/v1/webhooks/voice/transcript"));
      expect(r1.status).toBe(404);
      const failed = await inboxRow("voice:transcript", key);
      expect(failed).toMatchObject({ status: "FAILED", attempts: 1 });
      expect(failed?.errorMessage).toContain("CALL_NOT_FOUND");

      // The call now exists: the SAME delivery retries and processes.
      const call = await seedCall(business.id, externalCallId);
      const r2 = await transcript(postJson(body, key, "/api/v1/webhooks/voice/transcript"));
      expect(r2.status).toBe(200);
      expect(await r2.json()).toMatchObject({ ok: true, duplicate: false });

      const messages = await db.select().from(callMessages).where(eq(callMessages.callId, call.id));
      expect(messages).toHaveLength(1);
      expect(await inboxRow("voice:transcript", key)).toMatchObject({ status: "COMPLETED", attempts: 2 });
    });
  });

  // -- Group 6: payload conflict ----------------------------------------------
  describe("payload conflict", () => {
    itDb("same key with different bytes → 409, original outcome untouched", async () => {
      const business = await createBusiness(`Inbox Conflict ${Date.now()}`);
      const call = await seedCall(business.id, extId("conflict"));
      const key = nextKey("payload");
      const eventId = `evt-payload-${Date.now()}`;
      const base = { business_id: business.id, external_call_id: call.externalCallId, event_id: eventId };

      const r1 = await transcript(
        postJson({ ...base, transcript: "version A" }, key, "/api/v1/webhooks/voice/transcript"),
      );
      expect(r1.status).toBe(200);

      const r2 = await transcript(
        postJson({ ...base, transcript: "version B" }, key, "/api/v1/webhooks/voice/transcript"),
      );
      expect(r2.status).toBe(409);
      expect(((await r2.json()) as { error: { code: string } }).error.code).toBe("WEBHOOK_PAYLOAD_CONFLICT");

      const messages = await db.select().from(callMessages).where(eq(callMessages.callId, call.id));
      expect(messages).toHaveLength(1);
      expect(messages[0].content).toBe("version A");
      const row = await inboxRow("voice:transcript", key);
      expect(row?.status).toBe("COMPLETED");
      // The route hashes the VALIDATED body (role/is_final defaults applied).
      expect(row?.payloadHash).toBe(
        canonicalPayloadHash({ ...base, transcript: "version A", role: "CUSTOMER", is_final: true }),
      );
    });
  });

  // -- Group 7: route integration ----------------------------------------------
  describe("route integration", () => {
    itDb("call-started writes a COMPLETED inbox row", async () => {
      const business = await createBusiness(`Inbox Routes ${Date.now()}`);
      const key = nextKey("started");
      const res = await callStarted(
        postJson(
          { business_id: business.id, external_call_id: extId("started"), phone_number: "09123456789" },
          key,
          "/api/v1/webhooks/voice/call-started",
        ),
      );
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ ok: true, duplicate: false });
      expect(await inboxRow("voice:call-started", key)).toMatchObject({ status: "COMPLETED" });
    });

    itDb("transcript writes a COMPLETED inbox row", async () => {
      const business = await createBusiness(`Inbox Routes T ${Date.now()}`);
      const call = await seedCall(business.id, extId("trow"));
      const key = nextKey("trow");
      const res = await transcript(
        postJson(
          {
            business_id: business.id,
            external_call_id: call.externalCallId,
            transcript: "route integration",
            event_id: `evt-trow-${Date.now()}`,
          },
          key,
          "/api/v1/webhooks/voice/transcript",
        ),
      );
      expect(res.status).toBe(200);
      expect(await inboxRow("voice:transcript", key)).toMatchObject({ status: "COMPLETED" });
    });

    itDb("tool-call writes a COMPLETED inbox row", async () => {
      const business = await createBusiness(`Inbox Routes Tool ${Date.now()}`);
      const call = await seedCall(business.id, extId("toolrow"));
      const key = nextKey("toolrow");
      const res = await toolCall(
        postJson(
          {
            business_id: business.id,
            external_call_id: call.externalCallId,
            tool: "get_business_info",
            arguments: {},
            event_id: `tool-row-${Date.now()}`,
          },
          key,
          "/api/v1/webhooks/voice/tool-call",
        ),
      );
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ ok: true, status: "SUCCESS" });
      expect(await inboxRow("voice:tool-call", key)).toMatchObject({ status: "COMPLETED" });
    });

    itDb("call-ended writes a COMPLETED inbox row", async () => {
      const business = await createBusiness(`Inbox Routes End ${Date.now()}`);
      const call = await seedCall(business.id, extId("endrow"));
      const key = nextKey("endrow");
      const res = await callEnded(
        postJson(
          {
            business_id: business.id,
            external_call_id: call.externalCallId,
            duration_seconds: 42,
            summary: "route integration summary",
          },
          key,
          "/api/v1/webhooks/voice/call-ended",
        ),
      );
      expect(res.status).toBe(200);
      expect(await inboxRow("voice:call-ended", key)).toMatchObject({ status: "COMPLETED" });
    });

    itDb("audio writes a FAILED inbox row when providers are unconfigured", async () => {
      const business = await createBusiness(`Inbox Routes Audio ${Date.now()}`);
      await createAgent(business.id);
      const call = await seedCall(business.id, extId("audiorow"));
      const key = nextKey("audiorow");
      const res = await audioWebhook(
        postJson(
          {
            business_id: business.id,
            external_call_id: call.externalCallId,
            transcript: "سلام",
            event_id: `evt-audiorow-${Date.now()}`,
          },
          key,
          "/api/v1/webhooks/voice/audio",
        ),
      );
      // Honest failure (no providers in test env) is recorded, not swallowed.
      expect(res.status).toBe(503);
      const row = await inboxRow("voice:audio", key);
      expect(row?.status).toBe("FAILED");
      expect(row?.errorMessage).toContain("PROVIDER_NOT_CONFIGURED");
    });

    itDb("audio partials ack without touching the inbox", async () => {
      const business = await createBusiness(`Inbox Routes Partial ${Date.now()}`);
      const call = await seedCall(business.id, extId("partialrow"));
      const key = nextKey("partialrow");
      const res = await audioWebhook(
        postJson(
          {
            business_id: business.id,
            external_call_id: call.externalCallId,
            transcript: "partial…",
            is_final: false,
          },
          key,
          "/api/v1/webhooks/voice/audio",
        ),
      );
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ ok: true, partial: true });
      expect(await inboxRow("voice:audio", key)).toBeNull();
    });
  });
});
