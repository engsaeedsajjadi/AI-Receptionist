import { afterAll, beforeAll, beforeEach, describe, expect } from "vitest";
import { eq } from "drizzle-orm";
import { closeDb, db } from "@/db";
import { callMessages, calls } from "@/db/schema";
import type { ChatCompletionResult, ChatMessage, LLMProvider } from "@/lib/providers/llm";
import { runAgentTurn } from "@/lib/services/agent";
import { ensureDbReady, hasTestDatabase, itDb, truncateAll } from "../helpers/db";
import { createAgent, createBusiness } from "../helpers/fixtures";

/** Deterministic LLM that captures the exact messages it was given. */
class CapturingLLM implements LLMProvider {
  readonly name = "capturing-fake";
  seen: ChatMessage[] = [];
  async complete(messages: ChatMessage[]): Promise<ChatCompletionResult> {
    this.seen = messages;
    return {
      content: "noted",
      toolCalls: [],
      finishReason: "stop",
      usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 },
      model: "capturing-fake",
      latencyMs: 1,
    };
  }
}

describe.skipIf(!hasTestDatabase())("agent history decontamination (real database)", () => {
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

  async function setup(name: string) {
    const business = await createBusiness(`${name} ${Date.now()}`);
    const agent = await createAgent(business.id);
    const [call] = await db
      .insert(calls)
      .values({ businessId: business.id, externalCallId: `hist-${Date.now()}`, phoneNumber: "09123456789" })
      .returning();
    return { business, agent, call };
  }

  async function seedMessages(callId: string, rows: { role: "CUSTOMER" | "AGENT" | "SYSTEM" | "TOOL"; content: string }[]) {
    // Explicit increasing timestamps: ordering must be deterministic.
    const base = Date.now();
    for (const [i, row] of rows.entries()) {
      await db.insert(callMessages).values({
        callId,
        role: row.role,
        content: row.content,
        timestamp: new Date(base + i),
      });
    }
  }

  itDb("TOOL/SYSTEM rows never reach the LLM (only CUSTOMER/AGENT do)", async () => {
    const { business, agent, call } = await setup("History Biz");
    await seedMessages(call.id, [
      { role: "CUSTOMER", content: "I need a two bedroom apartment" },
      { role: "TOOL", content: JSON.stringify({ tool: "search_properties", status: "SUCCESS", data: [1, 2, 3] }) },
      { role: "SYSTEM", content: "operational marker: transfer requested" },
      { role: "AGENT", content: "previous agent reply about budget" },
    ]);

    const llm = new CapturingLLM();
    await runAgentTurn({
      businessId: business.id,
      agentId: agent.id,
      callId: call.id,
      userMessage: "my budget is high",
      requestId: `hist-${Date.now()}`,
      llm,
    });

    const nonSystem = llm.seen.filter((m) => m.role !== "system");
    expect(nonSystem).toEqual([
      { role: "user", content: "I need a two bedroom apartment" },
      { role: "assistant", content: "previous agent reply about budget" },
      { role: "user", content: "my budget is high" },
    ]);
    const joined = llm.seen.map((m) => m.content ?? "").join("\n");
    expect(joined).not.toContain("search_properties");
    expect(joined).not.toContain("transfer requested");

    // Persistence is untouched: the audit trail keeps every role.
    const stored = await db.select().from(callMessages).where(eq(callMessages.callId, call.id));
    expect(stored.map((r) => r.role).sort()).toEqual(["AGENT", "AGENT", "CUSTOMER", "CUSTOMER", "SYSTEM", "TOOL"]);
  });

  itDb("tool-heavy calls do not evict real conversation from the history window", async () => {
    const { business, agent, call } = await setup("History Window Biz");
    const filler = Array.from({ length: 29 }, (_, i) => ({
      role: "TOOL" as const,
      content: JSON.stringify({ tool: `tool_${i}`, status: "SUCCESS" }),
    }));
    await seedMessages(call.id, [
      ...filler,
      { role: "CUSTOMER", content: "window customer message" },
      { role: "AGENT", content: "window agent message" },
    ]);

    const llm = new CapturingLLM();
    await runAgentTurn({
      businessId: business.id,
      agentId: agent.id,
      callId: call.id,
      userMessage: "window current message",
      requestId: `histw-${Date.now()}`,
      llm,
    });

    // Before the fix the 30-message cap admitted 28 fake-user TOOL blobs and
    // the conversation drowned; now only conversation flows through.
    const nonSystem = llm.seen.filter((m) => m.role !== "system");
    expect(nonSystem).toEqual([
      { role: "user", content: "window customer message" },
      { role: "assistant", content: "window agent message" },
      { role: "user", content: "window current message" },
    ]);
  });
});
