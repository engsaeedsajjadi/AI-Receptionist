import { afterAll, beforeAll, describe, expect } from "vitest";
import { and, eq } from "drizzle-orm";
import { closeDb, db } from "@/db";
import { appointments, callMessages, calls, customers, leads, notifications } from "@/db/schema";
import { runAgentTurn } from "@/lib/services/agent";
import { checkAvailability } from "@/lib/services/appointments";
import { executeIdempotentToolCall, executeToolCall } from "@/lib/tools/registry";
import type { ChatCompletionResult, LLMProvider } from "@/lib/providers/llm";
import { ensureDbReady, hasTestDatabase, itDb, truncateAll } from "../helpers/db";
import { createAgent, createBusiness } from "../helpers/fixtures";

type ScriptStep = { content?: string; toolCalls?: ChatCompletionResult["toolCalls"] };

class FakeLLM implements LLMProvider {
  readonly name = "fake";
  private n = 0;
  constructor(private script: ScriptStep[]) {}
  async complete(): Promise<ChatCompletionResult> {
    const step = this.script[Math.min(this.n++, this.script.length - 1)];
    return {
      content: step.content ?? null,
      toolCalls: step.toolCalls ?? [],
      finishReason: "stop",
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      model: "fake-llm",
      latencyMs: 1,
    };
  }
}

const NOTIFY_ARGS = { title: "VIP caller needs follow-up", message: "Call back within one hour" };

describe("P0-3 tool-level idempotency (stored outcomes)", () => {
  const runIntegration = hasTestDatabase();

  beforeAll(async () => {
    if (!(await ensureDbReady())) return;
    await truncateAll();
  });

  afterAll(async () => {
    if (runIntegration) {
      await truncateAll().catch(() => undefined);
      await closeDb();
    }
  });

  async function seedCall(businessId: string, suffix: string) {
    const [row] = await db
      .insert(calls)
      .values({ businessId, externalCallId: `tool-idem-${suffix}-${Date.now()}`, phoneNumber: "09123456789", status: "IN_PROGRESS" })
      .returning();
    return row;
  }

  async function notificationCount(businessId: string): Promise<number> {
    return (
      await db.select({ id: notifications.id }).from(notifications).where(eq(notifications.businessId, businessId))
    ).length;
  }

  itDb("replays the stored outcome on retry (no duplicate side effect)", async () => {
    const business = await createBusiness();
    const call = await seedCall(business.id, "replay");
    const execId = `tool-exec-replay-${Date.now()}`;

    // Crash-retry uses a NEW requestId — identity must NOT depend on it.
    const first = await executeIdempotentToolCall({
      businessId: business.id,
      callId: call.id,
      toolExecId: execId,
      tool: "send_notification",
      args: { ...NOTIFY_ARGS },
      requestId: `req-first-${Date.now()}`,
      actor: "agent-runtime",
    });
    const second = await executeIdempotentToolCall({
      businessId: business.id,
      callId: call.id,
      toolExecId: execId,
      tool: "send_notification",
      args: { ...NOTIFY_ARGS },
      requestId: `req-retry-${Date.now()}`,
      actor: "agent-runtime",
    });

    expect(first.duplicate).toBe(false);
    expect(first.result.status).toBe("SUCCESS");
    expect(second.duplicate).toBe(true);
    expect(second.result).toEqual(first.result);
    expect(await notificationCount(business.id)).toBe(1);
  });

  itDb("serializes concurrent duplicates: one executes, the loser replays", async () => {
    const business = await createBusiness();
    const call = await seedCall(business.id, "race");
    const execId = `tool-exec-race-${Date.now()}`;
    const attempt = (tag: string) =>
      executeIdempotentToolCall({
        businessId: business.id,
        callId: call.id,
        toolExecId: execId,
        tool: "send_notification",
        args: { ...NOTIFY_ARGS },
        requestId: `req-${tag}-${Date.now()}`,
        actor: "agent-runtime",
      });
    const [a, b] = await Promise.all([attempt("a"), attempt("b")]);
    expect([a.duplicate, b.duplicate].sort()).toEqual([false, true]);
    expect(a.result.status).toBe("SUCCESS");
    expect(b.result.status).toBe("SUCCESS");
    expect(await notificationCount(business.id)).toBe(1);
  });

  itDb("executes distinct operations independently", async () => {
    const business = await createBusiness();
    const call = await seedCall(business.id, "distinct");
    const run = (execId: string, message: string) =>
      executeIdempotentToolCall({
        businessId: business.id,
        callId: call.id,
        toolExecId: execId,
        tool: "send_notification",
        args: { title: NOTIFY_ARGS.title, message },
        requestId: `req-${execId}`,
        actor: "agent-runtime",
      });
    const [a, b] = await Promise.all([run(`exec-a-${Date.now()}`, "message A"), run(`exec-b-${Date.now()}`, "message B")]);
    expect(a.duplicate).toBe(false);
    expect(b.duplicate).toBe(false);
    expect(await notificationCount(business.id)).toBe(2);
  });

  itDb("agent-loop retry of the same turn replays tools (one notification)", async () => {
    const business = await createBusiness();
    await createAgent(business.id);
    const call = await seedCall(business.id, "agent");
    const eventId = `turn-retry-${Date.now()}`;
    const llm = () =>
      new FakeLLM([
        {
          toolCalls: [
            { id: `tc-${Date.now()}-1`, name: "send_notification", arguments: { ...NOTIFY_ARGS } },
          ],
        },
        { content: "انجام شد" },
      ]);

    const first = await runAgentTurn({
      businessId: business.id,
      callId: call.id,
      eventId,
      userMessage: "لطفا پیگیری کنید",
      requestId: `agent-first-${Date.now()}`,
      actor: "voice-turn",
      llm: llm(),
    });
    // Same turn retried after a crash (fresh requestId, fresh LLM toolCall id —
    // identity comes from the operation, not the attempt).
    const second = await runAgentTurn({
      businessId: business.id,
      callId: call.id,
      eventId,
      userMessage: "لطفا پیگیری کنید",
      requestId: `agent-retry-${Date.now()}`,
      actor: "voice-turn",
      llm: llm(),
    });

    expect(first.toolCalls).toEqual([{ tool: "send_notification", status: "SUCCESS" }]);
    expect(second.toolCalls).toEqual([{ tool: "send_notification", status: "SUCCESS" }]);
    expect(await notificationCount(business.id)).toBe(1);

    // Exactly one TOOL outcome row backs both runs.
    const tools = await db
      .select()
      .from(callMessages)
      .where(and(eq(callMessages.callId, call.id), eq(callMessages.role, "TOOL")));
    expect(tools).toHaveLength(1);
    expect(tools[0].eventId).toContain(eventId);
  });

  itDb("CRASH-SAFETY: outcome-store failure rolls the side effect back (single transaction)", async () => {
    const business = await createBusiness();
    const call = await seedCall(business.id, "atomic");
    // A 300-char execution id passes the pre-checks and the handler (whose
    // writes never embed it) but violates the event_id varchar(255) column
    // on the outcome insert — i.e. the handler's writes and the outcome
    // store provably share one fate. Without tx-threading the customer +
    // lead below would survive the throw.
    const oversized = `tool-exec-oversized-${"x".repeat(280)}`;
    expect(oversized.length).toBeGreaterThan(255);
    await expect(
      executeIdempotentToolCall({
        businessId: business.id,
        callId: call.id,
        toolExecId: oversized,
        tool: "create_lead",
        args: { name: "Atomic", phone: "09120000009", intent: "BUY" },
        requestId: `req-atomic-${Date.now()}`,
        actor: "agent-runtime",
      }),
    ).rejects.toThrow();
    expect(await db.select().from(leads).where(eq(leads.businessId, business.id))).toHaveLength(0);
    expect(await db.select().from(customers).where(eq(customers.businessId, business.id))).toHaveLength(0);
    expect(await notificationCount(business.id)).toBe(0);
    const tools = await db
      .select()
      .from(callMessages)
      .where(and(eq(callMessages.callId, call.id), eq(callMessages.role, "TOOL")));
    expect(tools).toHaveLength(0);
  });

  itDb("create_lead replay returns the STORED outcome (not an upsert re-execution)", async () => {
    const business = await createBusiness();
    const call = await seedCall(business.id, "lead");
    const execId = `tool-exec-lead-${Date.now()}`;
    const args = { name: "سارا", phone: "09120000001", intent: "BUY", location: "تهران" };
    const run = (tag: string) =>
      executeIdempotentToolCall({
        businessId: business.id,
        callId: call.id,
        toolExecId: execId,
        tool: "create_lead",
        args: { ...args },
        requestId: `req-lead-${tag}-${Date.now()}`,
        actor: "agent-runtime",
      });
    const first = await run("a");
    const second = await run("b");
    expect(first.duplicate).toBe(false);
    expect(first.result.status).toBe("SUCCESS");
    expect(second.duplicate).toBe(true);
    expect(second.result).toEqual(first.result);
    // A re-executed upsert would report "updated_open"; the stored
    // outcome still says "created" — proof of replay, not re-execution.
    expect((first.result.data as { outcome: string }).outcome).toBe("created");
    expect((second.result.data as { outcome: string }).outcome).toBe("created");
    const rows = await db.select().from(leads).where(eq(leads.businessId, business.id));
    expect(rows).toHaveLength(1);
  });

  itDb("update_lead runs inside the outcome transaction", async () => {
    const business = await createBusiness();
    const call = await seedCall(business.id, "updlead");
    const created = await executeToolCall({
      businessId: business.id,
      callId: call.id,
      tool: "create_lead",
      args: { name: "رضا", phone: "09120000002", intent: "RENT" },
      requestId: `req-seed-${Date.now()}`,
      actor: "test",
    });
    const leadId = (created.data as { leadId: string }).leadId;
    const execId = `tool-exec-updlead-${Date.now()}`;
    const run = (tag: string) =>
      executeIdempotentToolCall({
        businessId: business.id,
        callId: call.id,
        toolExecId: execId,
        tool: "update_lead",
        args: { leadId, status: "CONTACTED", notes: "تماس گرفته شد" },
        requestId: `req-upd-${tag}-${Date.now()}`,
        actor: "agent-runtime",
      });
    const first = await run("a");
    const second = await run("b");
    expect(first).toMatchObject({ duplicate: false, result: { status: "SUCCESS" } });
    expect(second.duplicate).toBe(true);
    expect(second.result).toEqual(first.result);
  });

  itDb("create_appointment retry replays SUCCESS (one row, never a conflict)", async () => {
    const business = await createBusiness();
    const call = await seedCall(business.id, "appt");
    const date = new Date(Date.now() + 6 * 24 * 3600 * 1000).toISOString().slice(0, 10);
    const avail = await checkAvailability({ businessId: business.id, date });
    const slot = avail.slots.find((s) => s.available);
    expect(slot).toBeTruthy();
    const execId = `tool-exec-appt-${Date.now()}`;
    const run = (tag: string) =>
      executeIdempotentToolCall({
        businessId: business.id,
        callId: call.id,
        toolExecId: execId,
        tool: "create_appointment",
        args: { scheduledAt: slot!.start, durationMinutes: 30 },
        requestId: `req-appt-${tag}-${Date.now()}`,
        actor: "agent-runtime",
      });
    const first = await run("a");
    const second = await run("b");
    expect(first.duplicate).toBe(false);
    expect(first.result.status).toBe("SUCCESS");
    // A re-executed booking would hit the overlap check and report
    // UNAVAILABLE; the stored SUCCESS replays instead.
    expect(second.duplicate).toBe(true);
    expect(second.result.status).toBe("SUCCESS");
    const rows = await db.select().from(appointments).where(eq(appointments.businessId, business.id));
    expect(rows).toHaveLength(1);

    // A DISTINCT operation for the same slot still conflicts (overlap
    // protection intact under the new locking).
    const rival = await executeIdempotentToolCall({
      businessId: business.id,
      callId: call.id,
      toolExecId: `tool-exec-appt-rival-${Date.now()}`,
      tool: "create_appointment",
      args: { scheduledAt: slot!.start, durationMinutes: 30 },
      requestId: `req-appt-rival-${Date.now()}`,
      actor: "agent-runtime",
    });
    expect(rival.result.status).toBe("UNAVAILABLE");
  });

  itDb("agent turns without eventId execute directly (non-voice behavior unchanged)", async () => {
    const business = await createBusiness();
    await createAgent(business.id);
    const call = await seedCall(business.id, "noevent");
    const llm = () =>
      new FakeLLM([
        { toolCalls: [{ id: "tc-1", name: "send_notification", arguments: { ...NOTIFY_ARGS } }] },
        { content: "انجام شد" },
      ]);
    await runAgentTurn({
      businessId: business.id,
      callId: call.id,
      userMessage: "پیگیری",
      requestId: `noevent-1-${Date.now()}`,
      llm: llm(),
    });
    await runAgentTurn({
      businessId: business.id,
      callId: call.id,
      userMessage: "پیگیری",
      requestId: `noevent-2-${Date.now()}`,
      llm: llm(),
    });
    // Two explicit user actions → two executions (no identity to collapse on).
    expect(await notificationCount(business.id)).toBe(2);
  });
});
