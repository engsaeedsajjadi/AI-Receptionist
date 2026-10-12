import { afterAll, beforeAll, describe, expect } from "vitest";
import { eq } from "drizzle-orm";
import { db, closeDb } from "@/db";
import { calls, callMessages } from "@/db/schema";
import { loadAgentMemory, summarizeConversation } from "@/lib/services/memory";
import { createBusiness, createCall, createCustomer } from "../helpers/fixtures";
import { ensureDbReady, hasTestDatabase, itDb, truncateAll } from "../helpers/db";
import type { LLMProvider } from "@/lib/providers/llm";
describe.skipIf(!hasTestDatabase())("agent memory boundaries", () => {
  beforeAll(async () => { await ensureDbReady(); await truncateAll(); });
  afterAll(async () => { await truncateAll(); await closeDb(); });
  itDb("retrieves only linked tenant/customer summaries and rejects foreign calls", async () => {
    const a = await createBusiness(), b = await createBusiness();
    const customer = await createCustomer(a.id), other = await createCustomer(a.id, "09999999999");
    const old = await createCall(a.id), current = await createCall(a.id), unrelated = await createCall(a.id);
    await db.update(calls).set({ customerId: customer.id, summary: "Prefers mornings", endedAt: new Date() }).where(eq(calls.id, old.id));
    await db.update(calls).set({ customerId: customer.id }).where(eq(calls.id, current.id));
    await db.update(calls).set({ customerId: other.id, summary: "Private unrelated details", endedAt: new Date() }).where(eq(calls.id, unrelated.id));
    const memory = await loadAgentMemory(a.id, current.id);
    expect(memory).toContain("Prefers mornings"); expect(memory).not.toContain("Private unrelated");
    await expect(loadAgentMemory(b.id, current.id)).rejects.toMatchObject({ status: 404 });
  });
  itDb("persists a provider-derived rolling summary, preserves metadata and avoids repeat billing", async () => {
    const business = await createBusiness(), call = await createCall(business.id);
    await db.update(calls).set({ metadata: { providerField: "keep" } }).where(eq(calls.id, call.id));
    await db.insert(callMessages).values(Array.from({ length: 30 }, (_, i) => ({ businessId: business.id, callId: call.id, role: "CUSTOMER" as const, content: `Message ${i}` })));
    let invocations = 0;
    const llm: LLMProvider = { name: "test", async complete() { invocations++; return { content: "Caller requested a morning callback.", toolCalls: [], usage: { inputTokens: 30, outputTokens: 10 }, model: "test", latencyMs: 1, finishReason: "stop" }; } };
    const input = { businessId: business.id, callId: call.id, requestId: "memory-test", llm };
    await summarizeConversation(input); await summarizeConversation(input);
    expect(invocations).toBe(1);
    expect(await loadAgentMemory(business.id, call.id)).toContain("morning callback");
    const [saved] = await db.select().from(calls).where(eq(calls.id, call.id));
    expect(saved.metadata.providerField).toBe("keep");
  });
});
