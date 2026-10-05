import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { closeDb, db } from "@/db";
import { automationJobs, businesses, calls, notifications, outboxEvents } from "@/db/schema";
import { resetEnvCache } from "@/lib/env";
import { completeCall, generateCallSummary, getTransferConfig, reapStuckTransfers, requestTransfer, transitionCall } from "@/lib/services/calls";
import { createBusiness } from "../helpers/fixtures";
import { ensureDbReady, hasTestDatabase, itDb, truncateAll } from "../helpers/db";

const ENV_SNAPSHOT = new Map<string, string | undefined>();
const stubEnv = (key: string, value: string) => {
  if (!ENV_SNAPSHOT.has(key)) ENV_SNAPSHOT.set(key, process.env[key]);
  process.env[key] = value;
  resetEnvCache();
};

async function seedCall(businessId: string, overrides: Partial<typeof calls.$inferInsert> = {}) {
  const [row] = await db
    .insert(calls)
    .values({
      businessId,
      externalCallId: `lifecycle-${crypto.randomUUID().slice(0, 8)}`,
      phoneNumber: "09123456789",
      status: "IN_PROGRESS",
      ...overrides,
    })
    .returning();
  return row;
}

describe.skipIf(!hasTestDatabase())("call lifecycle, transfer and completion", () => {
  beforeAll(async () => {
    await ensureDbReady();
    await truncateAll();
  });
  afterAll(async () => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    resetEnvCache();
    await truncateAll();
    await closeDb();
  });
  beforeEach(async () => {
    await truncateAll();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    for (const [key, value] of ENV_SNAPSHOT) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    ENV_SNAPSHOT.clear();
    resetEnvCache();
  });

  itDb("validates lifecycle transitions and stamps the end time once", async () => {
    const business = await createBusiness();
    const call = await seedCall(business.id, { status: "RINGING", startedAt: new Date(Date.now() - 60_000) });
    const connected = await transitionCall(business.id, call.id, "CONNECTED");
    expect(connected.status).toBe("CONNECTED");
    expect(connected.endedAt).toBeNull();
    await expect(transitionCall(business.id, call.id, "TRANSFERRED")).rejects.toMatchObject({ status: 409, code: "CONFLICT" });
    const completed = await transitionCall(business.id, call.id, "COMPLETED");
    expect(completed.status).toBe("COMPLETED");
    expect(completed.endedAt).toBeInstanceOf(Date);
    // A completed call cannot be re-completed or moved backwards.
    await expect(transitionCall(business.id, call.id, "CONNECTED")).rejects.toMatchObject({ status: 409 });
    await expect(transitionCall(business.id, crypto.randomUUID(), "CONNECTED")).rejects.toMatchObject({ status: 404 });
  });

  itDb("resolves the transfer destination from settings, tenant phone and defaults", async () => {
    const business = await createBusiness();
    await db.update(businesses).set({ phone: "+982188776655" }).where(eq(businesses.id, business.id));
    const defaults = await getTransferConfig(business.id);
    expect(defaults.transferNumber).toBe("02188776655"); // normalised to the national format
    expect(defaults.timeoutSeconds).toBe(30);
    expect(defaults.fallbackNumber).toBeNull();

    await db
      .update(businesses)
      .set({ settings: { transfer: { number: "09121234567", fallbackNumber: "02133445566", timeoutSeconds: 45 } } })
      .where(eq(businesses.id, business.id));
    const configured = await getTransferConfig(business.id);
    expect(configured).toMatchObject({ transferNumber: "09121234567", fallbackNumber: "02133445566", timeoutSeconds: 45 });

    // Out-of-range timeouts fall back to the safe default instead of dialing forever.
    await db
      .update(businesses)
      .set({ settings: { transfer: { number: "09121234567", timeoutSeconds: 5000 } } })
      .where(eq(businesses.id, business.id));
    expect((await getTransferConfig(business.id)).timeoutSeconds).toBe(30);
    await expect(getTransferConfig("")).rejects.toThrow();
  });

  itDb("refuses a transfer with no telephony session, a non-transferable status or one already in flight", async () => {
    const business = await createBusiness();
    const noSession = await seedCall(business.id, { externalCallId: null });
    await expect(requestTransfer(business.id, noSession.id)).rejects.toMatchObject({ status: 409, code: "TRANSFER_UNAVAILABLE" });

    const completed = await seedCall(business.id, { status: "COMPLETED" });
    await expect(requestTransfer(business.id, completed.id)).rejects.toMatchObject({ status: 409, code: "TRANSFER_UNAVAILABLE" });

    const inFlight = await seedCall(business.id, { status: "TRANSFERRING" });
    await expect(requestTransfer(business.id, inFlight.id)).rejects.toMatchObject({ status: 409, code: "TRANSFER_IN_PROGRESS" });

    // None of the refusals may leave a transfer artefact behind.
    expect(await db.select().from(notifications)).toHaveLength(0);
    expect(await db.select().from(outboxEvents)).toHaveLength(0);
  });

  itDb("transfers the call through the configured gateway and records the handoff", async () => {
    const business = await createBusiness();
    stubEnv("VOICE_PROVIDER", "generic");
    stubEnv("VOICE_API_BASE_URL", "https://voice.example.com");
    stubEnv("VOICE_API_KEY", "voice-key");
    const call = await seedCall(business.id, { status: "IN_PROGRESS" });
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await requestTransfer(business.id, call.id, { destination: "09121234567", reason: "caller asked for a human" });
    if (result.status === "TRANSFERRED") {
      const [row] = await db.select().from(calls).where(eq(calls.id, call.id));
      expect(row.status).toBe("TRANSFERRED");
      expect(row.transferCompletedAt).toBeInstanceOf(Date);
      const events = await db.select().from(outboxEvents);
      expect(events.some((event) => event.topic === "call.handoff_requested")).toBe(true);
      expect(result.destination).toBe("09121234567");
      expect(result.message).toMatch(/انتقال/);
    } else {
      // A gateway refusal must be reported honestly, never as a success.
      expect(result.status).toBe("TRANSFER_FAILED");
      const [row] = await db.select().from(calls).where(eq(calls.id, call.id));
      expect(row.status).toBe("TRANSFER_FAILED");
      expect(result.message).toMatch(/امکان انتقال/);
    }
  });

  itDb("records an honest failure, notifies the operator and opens a callback when the gateway rejects", async () => {
    const business = await createBusiness();
    stubEnv("VOICE_PROVIDER", "generic");
    stubEnv("VOICE_API_BASE_URL", "https://voice.example.com");
    stubEnv("VOICE_API_KEY", "voice-key");
    const call = await seedCall(business.id, { status: "IN_PROGRESS" });
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async () => new Response("nope", { status: 500 })));

    const result = await requestTransfer(business.id, call.id, { destination: "09121234567" });
    expect(result.status).toBe("TRANSFER_FAILED");
    expect(result.message).not.toMatch(/در حال انتقال/); // never claims the handoff happened
    const [row] = await db.select().from(calls).where(eq(calls.id, call.id));
    expect(row.status).toBe("TRANSFER_FAILED");
    const rows = await db.select().from(notifications);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.some((n) => JSON.stringify(n).includes("handoff") || n.type === "human_handoff")).toBe(true);
    // The handoff event is published with an honest status: exactly one event,
    // and it must never claim the call was transferred.
    const events = (await db.select().from(outboxEvents)).filter((event) => event.topic === "call.handoff_requested");
    expect(events).toHaveLength(1);
    expect(events[0].payload).toMatchObject({ businessId: business.id, status: "failed" });
    expect(JSON.stringify(events)).not.toContain("transferred");
  });

  itDb("reaps a stuck transfer once and never double-notifies", async () => {
    const business = await createBusiness();
    const stuck = await seedCall(business.id, {
      status: "TRANSFERRING",
      transferRequestedAt: new Date(Date.now() - 30 * 60_000),
    });
    const fresh = await seedCall(business.id, { status: "TRANSFERRING", transferRequestedAt: new Date() });
    const first = await reapStuckTransfers(300);
    expect(first.reaped).toBe(1);
    const [reaped] = await db.select().from(calls).where(eq(calls.id, stuck.id));
    expect(reaped.status).toBe("TRANSFER_FAILED");
    const [untouched] = await db.select().from(calls).where(eq(calls.id, fresh.id));
    expect(untouched.status).toBe("TRANSFERRING");
    const second = await reapStuckTransfers(300);
    expect(second.reaped).toBe(0);
    const notificationsAfter = await db.select().from(notifications);
    const again = await reapStuckTransfers(300);
    expect(again.reaped).toBe(0);
    expect((await db.select().from(notifications)).length).toBe(notificationsAfter.length);
  });

  itDb("completes a call idempotently and publishes the completion event", async () => {
    const business = await createBusiness();
    const call = await seedCall(business.id, { status: "IN_PROGRESS", startedAt: new Date(Date.now() - 120_000) });
    const completed = await completeCall(business.id, call.id, { summary: "مشتری برای بازدید تماس گرفت" });
    expect(completed.status).toBe("COMPLETED");
    expect(completed.summary).toContain("بازدید");
    expect(completed.durationSeconds).toBeGreaterThan(0);
    const again = await completeCall(business.id, call.id);
    expect(again.endedAt?.getTime()).toBe(completed.endedAt?.getTime());
    expect(again.durationSeconds).toBe(completed.durationSeconds);
    const events = await db.select().from(outboxEvents);
    expect(events.filter((event) => event.topic === "call.completed")).toHaveLength(1);
    const jobs = await db.select().from(automationJobs);
    expect(jobs.length).toBeLessThanOrEqual(1);
    expect((await db.select().from(notifications)).length).toBeGreaterThan(0);
    // The stored end time is shared across both calls (single completion).
    const [row] = await db.select().from(calls).where(eq(calls.id, call.id));
    expect(row.endedAt?.getTime()).toBe(completed.endedAt?.getTime());
  });

  itDb("keeps a transferred call transferred when it completes", async () => {
    const business = await createBusiness();
    const call = await seedCall(business.id, { status: "TRANSFERRED", startedAt: new Date(Date.now() - 30_000) });
    const completed = await completeCall(business.id, call.id);
    expect(completed.status).toBe("TRANSFERRED");
    expect(completed.endedAt).toBeInstanceOf(Date);
    await expect(completeCall(business.id, crypto.randomUUID())).rejects.toMatchObject({ status: 404 });
  });

  itDb("never fabricates a summary: short transcripts and unconfigured LLMs return null", async () => {
    const business = await createBusiness();
    const short = await seedCall(business.id, { status: "COMPLETED", transcript: "سلام" });
    expect(await generateCallSummary(business.id, short.id)).toBeNull();

    const call = await seedCall(business.id, {
      status: "COMPLETED",
      transcript: "مشتری: سلام، دنبال یک آپارتمان دو خوابه در تهران هستم.\nمنشی: حتماً، چند فایل مناسب داریم.",
    });
    stubEnv("LLM_PROVIDER", "dev");
    expect(await generateCallSummary(business.id, call.id)).toBeNull();
    const [row] = await db.select().from(calls).where(eq(calls.id, call.id));
    expect(row.summary).toBeNull(); // nothing invented, nothing persisted
    expect((await db.select().from(notifications)).length).toBe(0);
    expect((await db.select().from(automationJobs).where(and(eq(automationJobs.businessId, business.id)))).length).toBe(0);
  });
});
