import { afterAll, beforeAll, describe, expect, vi } from "vitest";
import { eq } from "drizzle-orm";
import { closeDb, db } from "@/db";
import { calls } from "@/db/schema";
import { resetEnvCache } from "@/lib/env";
import { requestTransfer } from "@/lib/services/calls";
import { executeIdempotentToolCall } from "@/lib/tools/registry";
import { ensureDbReady, hasTestDatabase, itDb, truncateAll } from "../helpers/db";
import { createBusiness } from "../helpers/fixtures";

type CapturedCall = { url: string; body: Record<string, unknown> };

/**
 * transfer_call cannot join a DB transaction (its gateway dial is
 * un-rollbackable), so crash safety comes from claim-then-reconcile keyed
 * by the operation id — these tests prove the reconciliation half (the
 * outcome-row half is covered by the tool-idempotency suite).
 */
describe("transfer_call crash recovery (claim-then-reconcile)", () => {
  const runIntegration = hasTestDatabase();
  const savedEnv = { ...process.env };
  const gatewayCalls: CapturedCall[] = [];
  // Scripted gateway outcomes (shifted per transfer POST); default success.
  let script: Array<{ ok: boolean; status: number; body: unknown }> = [];
  const callsFor = (tag: string) => gatewayCalls.filter((c) => c.url.includes("/transfer"));

  beforeAll(async () => {
    if (!(await ensureDbReady())) return;
    await truncateAll();
    process.env.VOICE_PROVIDER = "generic";
    process.env.VOICE_API_BASE_URL = "https://gateway.example.test";
    process.env.VOICE_API_KEY = "test-gateway-key";
    resetEnvCache();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: unknown, init?: { body?: unknown }) => {
        gatewayCalls.push({
          url: String(url),
          body: (init?.body ? JSON.parse(String(init.body)) : {}) as Record<string, unknown>,
        });
        const next = script.shift() ?? { ok: true, status: 200, body: { status: "completed" } };
        return { ok: next.ok, status: next.status, text: async () => JSON.stringify(next.body) };
      }),
    );
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

  async function seedCall(businessId: string, suffix: string) {
    const [row] = await db
      .insert(calls)
      .values({
        businessId,
        externalCallId: `transfer-${suffix}-${Date.now()}`,
        phoneNumber: "09123456789",
        status: "IN_PROGRESS",
      })
      .returning();
    return row;
  }

  itDb("same-operation retry after TRANSFERRED returns success without re-dialing", async () => {
    const business = await createBusiness();
    const call = await seedCall(business.id, "noredial");
    const key = `transfer-op-${Date.now()}`;
    gatewayCalls.length = 0;

    const first = await requestTransfer(business.id, call.id, {
      destination: "02112345678",
      requestId: `t-req-1-${Date.now()}`,
      idempotencyKey: key,
    });
    expect(first.status).toBe("TRANSFERRED");
    expect(callsFor("x")).toHaveLength(1);
    expect(gatewayCalls[0].body).toMatchObject({ destination: "02112345678", idempotencyKey: key });

    // Crash-retry of the SAME operation (outcome row lost): reconciles to
    // success from the recorded state — the gateway is never dialed again.
    const second = await requestTransfer(business.id, call.id, {
      destination: "02112345678",
      requestId: `t-req-2-${Date.now()}`,
      idempotencyKey: key,
    });
    expect(second.status).toBe("TRANSFERRED");
    expect(callsFor("x")).toHaveLength(1);

    const [row] = await db.select().from(calls).where(eq(calls.id, call.id)).limit(1);
    expect(row.status).toBe("TRANSFERRED");
    expect(row.transferIdempotencyKey).toBe(key);
  });

  itDb("a DIFFERENT operation after TRANSFERRED still fails (no key confusion)", async () => {
    const business = await createBusiness();
    const call = await seedCall(business.id, "otherop");
    await requestTransfer(business.id, call.id, {
      destination: "02112345678",
      requestId: `t-req-a-${Date.now()}`,
      idempotencyKey: `transfer-op-a-${Date.now()}`,
    });
    await expect(
      requestTransfer(business.id, call.id, {
        destination: "02112345678",
        requestId: `t-req-b-${Date.now()}`,
        idempotencyKey: `transfer-op-b-${Date.now()}`,
      }),
    ).rejects.toMatchObject({ code: "TRANSFER_UNAVAILABLE" });
  });

  itDb("same-operation retry after a failed dial re-issues with the SAME provider key", async () => {
    const business = await createBusiness();
    const call = await seedCall(business.id, "redial");
    const key = `transfer-op-redial-${Date.now()}`;
    gatewayCalls.length = 0;
    // The provider retries twice internally, so the first requestTransfer
    // needs 3 consecutive failures; the recovery then succeeds.
    const fail = { ok: false, status: 502, body: { error: "gateway exploded" } };
    script = [fail, fail, fail, { ok: true, status: 200, body: { status: "completed" } }];

    const first = await requestTransfer(business.id, call.id, {
      destination: "02112345678",
      requestId: `t-req-f1-${Date.now()}`,
      idempotencyKey: key,
    });
    expect(first.status).toBe("TRANSFER_FAILED");

    // Recovery: the operation re-asserts ownership and re-dials. The
    // provider key is STABLE across attempts, so a gateway that honors it
    // can never connect two transfers for one operation.
    const second = await requestTransfer(business.id, call.id, {
      destination: "02112345678",
      requestId: `t-req-f2-${Date.now()}`,
      idempotencyKey: key,
    });
    expect(second.status).toBe("TRANSFERRED");
    // 3 failed attempts + 1 recovery dial, ALL carrying the stable key.
    expect(callsFor("x")).toHaveLength(4);
    for (const c of gatewayCalls) {
      expect(c.body.idempotencyKey).toBe(key);
    }
  });

  itDb("transfer_call through the idempotent tool path dials once and replays", async () => {
    const business = await createBusiness();
    const call = await seedCall(business.id, "toolpath");
    const execId = `tool-exec-transfer-${Date.now()}`;
    gatewayCalls.length = 0;
    script = [];

    const run = (tag: string) =>
      executeIdempotentToolCall({
        businessId: business.id,
        callId: call.id,
        toolExecId: execId,
        tool: "transfer_call",
        args: { destination: "02112345678" },
        requestId: `t-tool-${tag}-${Date.now()}`,
        actor: "agent-runtime",
      });
    const first = await run("a");
    const second = await run("b");
    expect(first.duplicate).toBe(false);
    expect(first.result.status).toBe("SUCCESS");
    expect(second.duplicate).toBe(true);
    expect(second.result).toEqual(first.result);
    expect(callsFor("x")).toHaveLength(1);
    expect(gatewayCalls[0].body.idempotencyKey).toBe(execId);
  });
});
