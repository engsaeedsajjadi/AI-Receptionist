import { afterAll, beforeAll, describe, expect } from "vitest";
import { NextRequest } from "next/server";
import { asc, eq } from "drizzle-orm";
import { closeDb, db } from "@/db";
import { callMessages, calls } from "@/db/schema";
import { issueAuthTokens } from "@/lib/auth";
import { intentPromptHint, runAgentTurn } from "@/lib/services/agent";
import { resolveIntent } from "@/lib/services/conversation-intelligence";
import { GET as intentReport } from "@/app/api/v1/analytics/intent/route";
import type { ChatCompletionResult, ChatMessage, LLMProvider } from "@/lib/providers/llm";
import { createAgent, createBusiness, createCall, createUser } from "../helpers/fixtures";
import { ensureDbReady, hasTestDatabase, itDb, truncateAll } from "../helpers/db";

/**
 * The typed intent boundary on the live path.
 *
 * The LLM never decides what the caller asked for: `runAgentTurn` resolves the
 * intent deterministically, steers the model when a side-effecting intent needs
 * confirmation, and records the decision (intent, confidence, reasons — never the
 * utterance and never slot values) on the agent's transcript row. The tenant-level
 * report aggregates those decisions without crossing tenants.
 */

let ipSeq = 0;
function reportRequest(token: string, query = "") {
  return new NextRequest(`http://localhost/api/v1/analytics/intent${query}`, {
    headers: { Authorization: `Bearer ${token}`, "x-real-ip": `10.21.${(ipSeq >> 8) % 250}.${(ipSeq++ % 250) + 1}` },
  });
}

class CapturingLLM implements LLMProvider {
  readonly name = "capturing";
  observed: ChatMessage[][] = [];
  constructor(private readonly reply: string) {}
  async complete(messages: ChatMessage[]): Promise<ChatCompletionResult> {
    this.observed.push(messages);
    return {
      content: this.reply,
      toolCalls: [],
      finishReason: "stop",
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      model: "capturing",
      latencyMs: 1,
    };
  }
}

async function tenantWithAgent(role: "ADMIN" | "AGENT" = "ADMIN") {
  const business = await createBusiness(`Intent ${crypto.randomUUID().slice(0, 8)}`);
  const agent = await createAgent(business.id);
  const { user } = await createUser(business.id, role);
  const token = (await issueAuthTokens({ userId: user.id, businessId: business.id, role })).accessToken;
  return { business, agent, user, token };
}

describe.skipIf(!hasTestDatabase())("typed intent pipeline (live path)", () => {
  beforeAll(async () => {
    await ensureDbReady();
    await truncateAll();
  });
  afterAll(async () => {
    await truncateAll();
    await closeDb();
  });

  itDb("resolves the caller's intent deterministically and steers the model for unclear side effects", async () => {
    const { business, agent } = await tenantWithAgent();
    const call = await createCall(business.id);

    // A one-word cancellation is a side-effecting intent that is not actionable:
    // the model must be told to confirm before cancelling anything.
    const llm = new CapturingLLM("حتماً، لطفاً بگویید کدام قرار را لغو کنیم؟");
    const turn = await runAgentTurn({
      businessId: business.id,
      callId: call.id,
      agentId: agent.id,
      userMessage: "لغو",
      requestId: crypto.randomUUID(),
      llm,
    });
    expect(turn.intent.intent).toBe("CANCEL");
    // Local resolution scores a single keyword 0.6 — below the 0.75 action bar for
    // a side-effecting intent — so nothing may be cancelled without confirmation.
    expect(turn.intent.actionable).toBe(false);
    const system = llm.observed[0][0].content ?? "";
    expect(system).toContain("پیش از هر رزرو، انتقال تماس یا لغو");
    expect(system).toContain("CANCEL");

    // The same utterance always resolves the same way (deterministic boundary),
    // and a clear, non-side-effecting question carries no confirmation hint.
    expect(resolveIntent({ utterance: "لغو" }).intent).toBe(resolveIntent({ utterance: "لغو" }).intent);
    const clear = await runAgentTurn({
      businessId: business.id,
      callId: call.id,
      agentId: agent.id,
      userMessage: "قیمت آپارتمان‌های تهران چند است؟",
      requestId: crypto.randomUUID(),
      llm: new CapturingLLM("برای اطلاع از قیمت‌ها، بودجه شما چقدر است؟"),
    });
    expect(["PRICING", "BUY"]).toContain(clear.intent.intent);
    expect(clear.intent.actionable).toBe(true);
    expect(intentPromptHint(clear.intent, "fa")).toBeNull();
    // An unknown utterance carries no hint (the guardrail asks a question instead).
    expect(intentPromptHint(resolveIntent({ utterance: "هوممم" }), "fa")).toBeNull();
    expect(intentPromptHint({ intent: "HUMAN_HANDOFF", confidence: 0.6, slots: {}, actionable: false, needsClarification: true, reason: "test" }, "en")).toContain("confirm");
  });

  itDb("records the intent on the agent turn without storing the utterance or slot values", async () => {
    const { business, agent } = await tenantWithAgent();
    const call = await createCall(business.id);
    const utterance = "سلام، من ۰۹۱۲۳۴۵۶۷۸۹ هستم و می‌خواهم بازدید بگیرم";

    await runAgentTurn({
      businessId: business.id,
      callId: call.id,
      agentId: agent.id,
      userMessage: utterance,
      requestId: crypto.randomUUID(),
      llm: new CapturingLLM("حتماً، چه زمانی برای بازدید مناسب است؟"),
    });

    const rows = await db.select().from(callMessages).where(eq(callMessages.callId, call.id)).orderBy(asc(callMessages.timestamp));
    const customerRow = rows.find((row) => row.role === "CUSTOMER");
    const agentRow = rows.find((row) => row.role === "AGENT");
    // The transcript keeps the caller's words (Persian digits normalised to ASCII).
    expect(customerRow?.content).toContain("09123456789");
    const metadata = (agentRow?.metadata as { intent?: Record<string, unknown> }).intent;
    expect(metadata?.intent).toBe("VIEWING");
    expect(metadata?.actionable).toBe(false);
    expect(metadata?.slotKeys).toContain("phone");
    // Privacy: the phone number never appears in the intent metadata.
    expect(JSON.stringify(agentRow?.metadata)).not.toContain("09123456789");
    expect(JSON.stringify(agentRow?.metadata)).not.toContain("۰۹۱۲۳۴۵۶۷۸۹");
  });

  itDb("reports intent quality for this tenant only, and requires agents:read", async () => {
    const a = await tenantWithAgent();
    const b = await tenantWithAgent();
    for (const [tenant, utterances] of [
      [a, ["لغو", "شکایت دارم از سرویس", "قیمت چند است؟"]],
      [b, ["می‌خواهم بازدید بگیرم"]],
    ] as const) {
      const call = await createCall(tenant.business.id);
      for (const utterance of utterances) {
        await runAgentTurn({
          businessId: tenant.business.id,
          callId: call.id,
          agentId: tenant.agent.id,
          userMessage: utterance,
          requestId: crypto.randomUUID(),
          llm: new CapturingLLM("بله، ادامه دهید."),
        });
      }
    }

    const res = await intentReport(reportRequest(a.token));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      turns: number; calls: number; byIntent: Array<{ intent: string; count: number }>; unknownRate: number | null; clarificationRate: number | null; unactionableByIntent: Array<{ intent: string; count: number }>; window: { days: number };
    };
    expect(body.turns).toBe(3);
    expect(body.calls).toBe(1);
    expect(body.window.days).toBe(30);
    const intents = body.byIntent.map((entry) => entry.intent);
    expect(intents).toContain("CANCEL");
    expect(intents).toContain("COMPLAINT");
    // Tenant B's session is never part of tenant A's report.
    expect(intents).not.toContain("VIEWING");
    // Cancelling and complaining on a single keyword is not actionable — exactly
    // what this report exists to surface.
    expect(body.unactionableByIntent.map((entry) => entry.intent)).toEqual(expect.arrayContaining(["CANCEL", "COMPLAINT"]));
    expect(body.unactionableByIntent.map((entry) => entry.intent)).not.toContain("PRICING");

    // Tenant B sees its own turn and none of tenant A's.
    const bRes = (await (await intentReport(reportRequest(b.token))).json()) as { turns: number; byIntent: Array<{ intent: string }> };
    expect(bRes.byIntent.map((entry) => entry.intent)).toContain("VIEWING");
    expect(bRes.byIntent.map((entry) => entry.intent)).not.toContain("CANCEL");

    // Unauthenticated and cross-tenant-scoped requests are refused.
    expect((await intentReport(new NextRequest("http://localhost/api/v1/analytics/intent"))).status).toBe(401);
    const crossTenant = new NextRequest("http://localhost/api/v1/analytics/intent", {
      headers: { Authorization: `Bearer ${a.token}`, "x-tenant-id": b.business.id, "x-real-ip": "10.21.9.9" },
    });
    expect((await intentReport(crossTenant)).status).toBe(403);

    // A tenant with no turns gets an honest empty report.
    const c = await tenantWithAgent();
    const empty = (await (await intentReport(reportRequest(c.token))).json()) as { turns: number; unknownRate: number | null };
    expect(empty.turns).toBe(0);
    expect(empty.unknownRate).toBeNull();

    // Windows are honoured (nothing is older than a one-day window here).
    const windowed = (await (await intentReport(reportRequest(c.token, "?days=1"))).json()) as { window: { days: number } };
    expect(windowed.window.days).toBe(1);
  });
});
