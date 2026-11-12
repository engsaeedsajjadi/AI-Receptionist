import { afterAll, beforeAll, beforeEach, describe, expect } from "vitest";
import { eq } from "drizzle-orm";
import { closeDb, db } from "@/db";
import { appointments, businesses } from "@/db/schema";
import { describeCurrentTime } from "@/lib/guardrails";
import type { ChatCompletionResult, ChatMessage, LLMProvider } from "@/lib/providers/llm";
import { ensureDbReady, hasTestDatabase, itDb, truncateAll } from "../helpers/db";
import { createAgent, createBusiness } from "../helpers/fixtures";

/**
 * «فردا ساعت ۱۰» end to end.
 *
 * The model has no clock of its own. The scripted model below does only what a
 * real one can do: read the date and UTC offset the system prompt states, add
 * one day and ask for 10:00. The test then checks the stored appointment is
 * 10:00 on the business's next local day — in Tehran and in a tenant with a
 * different time zone — which fails if the prompt omits or misstates the clock.
 */
type Step = { content?: string; toolCalls?: ChatCompletionResult["toolCalls"] };

class ClockReadingLLM implements LLMProvider {
  readonly name = "fake-clock-reader";
  seen: ChatMessage[][] = [];
  requested: string | null = null;
  private turn = 0;

  async complete(messages: ChatMessage[]): Promise<ChatCompletionResult> {
    this.seen.push(messages);
    const step: Step = this.turn++ === 0 ? this.bookTomorrowAtTen(messages) : { content: "وقت شما برای فردا ساعت ۱۰ ثبت شد." };
    return {
      content: step.content ?? null, toolCalls: step.toolCalls ?? [], finishReason: "stop",
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 }, model: "fake", latencyMs: 1,
    };
  }

  private bookTomorrowAtTen(messages: ChatMessage[]): Step {
    const system = messages.find((m) => m.role === "system")?.content ?? "";
    // The example timestamp in the prompt carries today's local date and offset.
    const stated = /(\d{4})-(\d{2})-(\d{2})T\d{2}:\d{2}:\d{2}([+-]\d{2}:\d{2})/.exec(system);
    if (!stated) return { content: "تاریخ امروز را نمی‌دانم." };
    const [, y, m, d, offset] = stated;
    const next = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d) + 1));
    const date = next.toISOString().slice(0, 10);
    this.requested = `${date}T10:00:00${offset}`;
    return {
      toolCalls: [{
        id: "call-1", name: "create_appointment",
        arguments: { scheduledAt: this.requested, durationMinutes: 30 },
      }],
    };
  }
}

async function tenant(timezone: string) {
  const business = await createBusiness();
  const days = Object.fromEntries(
    Array.from({ length: 7 }, (_, day) => [String(day), { enabled: true, start: "00:00", end: "23:59" }]),
  );
  await db.update(businesses)
    .set({ timezone, settings: { scheduling: { timezone, days } }, updatedAt: new Date() })
    .where(eq(businesses.id, business.id));
  const agent = await createAgent(business.id);
  return { business, agent };
}

/** Local calendar date and hour of an instant in a time zone. */
function localParts(instant: Date, timeZone: string) {
  const t = describeCurrentTime(instant, timeZone);
  return { date: t.date, time: t.time };
}

function addDays(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

describe.skipIf(!hasTestDatabase())("assistant resolves relative Persian dates in the business time zone", () => {
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

  for (const timezone of ["Asia/Tehran", "America/Los_Angeles"]) {
    itDb(`books «فردا ساعت ۱۰» at 10:00 on the next local day (${timezone})`, async () => {
      const { business, agent } = await tenant(timezone);
      const llm = new ClockReadingLLM();
      const before = new Date();
      const { runAgentTurn } = await import("@/lib/services/agent");

      const result = await runAgentTurn({
        businessId: business.id, agentId: agent.id, userMessage: "برای فردا ساعت ۱۰ وقت بازدید می‌خواهم",
        requestId: `rel-date-${timezone}-${Date.now()}`, actor: "test", llm,
      });

      // The model was told the business's local "today" and offset.
      const today = describeCurrentTime(before, timezone);
      const system = llm.seen[0].find((m) => m.role === "system")!.content;
      expect(system).toContain(today.date);
      expect(system).toContain(`UTC${today.offset}`);
      expect(llm.requested).toBe(`${addDays(today.date, 1)}T10:00:00${today.offset}`);

      // The tool accepted it and the stored instant is 10:00 local, tomorrow.
      expect(result.toolCalls).toEqual([expect.objectContaining({ tool: "create_appointment", status: "SUCCESS" })]);
      const rows = await db.select().from(appointments).where(eq(appointments.businessId, business.id));
      expect(rows).toHaveLength(1);
      const stored = rows[0].scheduledAt as Date;
      expect(stored.toISOString()).toBe(new Date(llm.requested!).toISOString());
      expect(localParts(stored, timezone)).toEqual({ date: addDays(today.date, 1), time: "10:00" });
      expect(result.reply).toContain("ثبت شد");
    });
  }

  itDb("two tenants in different time zones get different instants for the same words", async () => {
    const tehran = await tenant("Asia/Tehran");
    const la = await tenant("America/Los_Angeles");
    const { runAgentTurn } = await import("@/lib/services/agent");

    for (const t of [tehran, la]) {
      await runAgentTurn({
        businessId: t.business.id, agentId: t.agent.id, userMessage: "فردا ساعت ۱۰ وقت می‌خواهم",
        requestId: `rel-date-pair-${t.business.id}`, actor: "test", llm: new ClockReadingLLM(),
      });
    }
    const [a] = await db.select().from(appointments).where(eq(appointments.businessId, tehran.business.id));
    const [b] = await db.select().from(appointments).where(eq(appointments.businessId, la.business.id));
    const atTehran = a.scheduledAt as Date;
    const atLosAngeles = b.scheduledAt as Date;
    expect(localParts(atTehran, "Asia/Tehran").time).toBe("10:00");
    expect(localParts(atLosAngeles, "America/Los_Angeles").time).toBe("10:00");
    expect(atTehran.getTime()).not.toBe(atLosAngeles.getTime());
  });
});
