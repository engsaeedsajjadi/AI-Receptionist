import { afterAll, beforeAll, describe, expect } from "vitest";
import { and, eq } from "drizzle-orm";
import { closeDb, db } from "@/db";
import { appointments } from "@/db/schema";
import type { ChatCompletionResult, ChatMessage, LLMProvider } from "@/lib/providers/llm";
import { ensureDbReady, hasTestDatabase, itDb, truncateAll } from "../helpers/db";
import { createAgent, createBusiness, createProperty } from "../helpers/fixtures";

const runIntegration = hasTestDatabase();
let reqSeq = 0;
const nextReq = (tag: string) => `honesty-${tag}-${Date.now()}-${reqSeq++}`;

/**
 * Fake LLM that follows a script AND records every prompt it received, so
 * tests can prove the agent relayed tool failures into the LLM context
 * verbatim instead of swallowing or rewriting them.
 */
class CapturingLLM implements LLMProvider {
  readonly name = "fake-capture";
  seen: ChatMessage[][] = [];
  private n = 0;
  constructor(private script: Array<{ content?: string; toolCalls?: ChatCompletionResult["toolCalls"] }>) {}
  async complete(messages: ChatMessage[]): Promise<ChatCompletionResult> {
    this.seen.push(messages);
    const step = this.script[Math.min(this.n++, this.script.length - 1)];
    return {
      content: step.content ?? null,
      toolCalls: step.toolCalls ?? [],
      finishReason: "stop",
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      model: "fake-capture",
      latencyMs: 1,
    };
  }
}

function toolMessages(seen: ChatMessage[]): Array<{ status: string; error?: string; data?: unknown }> {
  return seen
    .flat()
    .filter((m) => m.role === "tool")
    .map((m) => JSON.parse(m.content ?? "{}"));
}

describe.skipIf(!runIntegration)("tool honesty: failures surface, never invented (real database)", () => {
  let businessId: string;

  beforeAll(async () => {
    if (!(await ensureDbReady())) return;
    await truncateAll();
    businessId = (await createBusiness("Honesty Biz")).id;
    await createAgent(businessId);
    // One real row proves the NOT_FOUND cases below ran a genuine lookup.
    await createProperty(businessId, { code: "HONEST-001" });
  });

  afterAll(async () => {
    if (runIntegration) {
      await truncateAll().catch(() => undefined);
      await closeDb();
    }
  });

  itDb("(a) property search with no matching rows → NOT_FOUND, no invented listing", async () => {
    const { executeToolCall } = await import("@/lib/tools/registry");
    const result = await executeToolCall({
      businessId,
      tool: "search_properties",
      args: { city: "zxqv-no-such-city" },
      requestId: nextReq("search-empty"),
      actor: "test",
    });
    expect(result.status).toBe("NOT_FOUND");
    expect(result.error).toMatch(/no matching properties/i);
    expect(result.data).toBeUndefined(); // no invented payload
  });

  itDb("(b) booking conflict → UNAVAILABLE, never a fake confirmation", async () => {
    const { executeToolCall } = await import("@/lib/tools/registry");
    const { checkAvailability } = await import("@/lib/services/appointments");
    const date = new Date(Date.now() + 4 * 24 * 3600 * 1000).toISOString().slice(0, 10);
    const avail = await checkAvailability({ businessId, date });
    const slot = avail.slots.find((s) => s.available);
    expect(slot).toBeTruthy();

    const first = await executeToolCall({
      businessId,
      tool: "create_appointment",
      args: { scheduledAt: slot!.start, durationMinutes: 30 },
      requestId: nextReq("book-first"),
      actor: "test",
    });
    expect(first.status).toBe("SUCCESS");

    const clash = await executeToolCall({
      businessId,
      tool: "create_appointment",
      args: { scheduledAt: slot!.start, durationMinutes: 30 },
      requestId: nextReq("book-clash"),
      actor: "test",
    });
    expect(clash.status).toBe("UNAVAILABLE");
    expect(clash.error).toBeTruthy();
    expect(clash.data).toBeUndefined(); // no fake appointmentId
  });

  itDb("(c) unknown property code → NOT_FOUND, no placeholder details", async () => {
    const { executeToolCall } = await import("@/lib/tools/registry");
    const result = await executeToolCall({
      businessId,
      tool: "search_properties",
      args: { code: "NOPE-999" },
      requestId: nextReq("code-unknown"),
      actor: "test",
    });
    expect(result.status).toBe("NOT_FOUND");
    expect(result.data).toBeUndefined();
    // And the existing code still resolves (lookup is real, not hardcoded empty).
    const hit = await executeToolCall({
      businessId,
      tool: "search_properties",
      args: { code: "HONEST-001" },
      requestId: nextReq("code-hit"),
      actor: "test",
    });
    expect(hit.status).toBe("SUCCESS");
  });

  itDb("agent relays a NOT_FOUND tool failure into LLM context verbatim", async () => {
    const { runAgentTurn } = await import("@/lib/services/agent");
    const llm = new CapturingLLM([
      {
        toolCalls: [
          { id: "tc-1", name: "search_properties", arguments: { city: "zxqv-no-such-city" } },
        ],
      },
      { content: "متأسفم، ملکی با این مشخصات پیدا نکردم." },
    ]);
    const result = await runAgentTurn({
      businessId,
      userMessage: "آپارتمان در شهری که وجود ندارد می‌خواهم",
      requestId: nextReq("agent-relay"),
      llm,
    });
    expect(result.toolCalls).toEqual([{ tool: "search_properties", status: "NOT_FOUND" }]);
    expect(llm.seen.length).toBe(2);
    const toolMsgs = toolMessages(llm.seen[1]);
    expect(toolMsgs).toHaveLength(1);
    expect(toolMsgs[0].status).toBe("NOT_FOUND");
    expect(toolMsgs[0].error).toMatch(/no matching properties/i);
    expect(toolMsgs[0].data).toBeUndefined();
    // Loop mechanics: the scripted second-turn text becomes the reply.
    expect(result.reply).toBe("متأسفم، ملکی با این مشخصات پیدا نکردم.");
  });

  itDb("agent conflict path: UNAVAILABLE recorded, LLM sees it, DB unchanged", async () => {
    const { runAgentTurn } = await import("@/lib/services/agent");
    const { checkAvailability, createAppointment } = await import("@/lib/services/appointments");
    const date = new Date(Date.now() + 6 * 24 * 3600 * 1000).toISOString().slice(0, 10);
    const avail = await checkAvailability({ businessId, date });
    const slot = avail.slots.find((s) => s.available);
    expect(slot).toBeTruthy();
    await createAppointment(businessId, { scheduledAt: slot!.start, durationMinutes: 30 });

    const before = await db
      .select({ id: appointments.id })
      .from(appointments)
      .where(and(eq(appointments.businessId, businessId), eq(appointments.scheduledAt, new Date(slot!.start))));

    const llm = new CapturingLLM([
      {
        toolCalls: [
          { id: "tc-2", name: "create_appointment", arguments: { scheduledAt: slot!.start, durationMinutes: 30 } },
        ],
      },
      { content: "متأسفم، این ساعت قبلاً رزرو شده است." },
    ]);
    const result = await runAgentTurn({
      businessId,
      userMessage: "همان ساعت را برایم رزرو کن",
      requestId: nextReq("agent-conflict"),
      llm,
    });

    expect(result.toolCalls).toEqual([{ tool: "create_appointment", status: "UNAVAILABLE" }]);
    const toolMsgs = toolMessages(llm.seen[1]);
    expect(toolMsgs).toHaveLength(1);
    expect(toolMsgs[0].status).toBe("UNAVAILABLE");
    expect(toolMsgs[0].error).toBeTruthy();
    // No second row: the failure was honest, not a silent double-book.
    const after = await db
      .select({ id: appointments.id })
      .from(appointments)
      .where(and(eq(appointments.businessId, businessId), eq(appointments.scheduledAt, new Date(slot!.start))));
    expect(after.map((a) => a.id).sort()).toEqual(before.map((a) => a.id).sort());
  });
});
