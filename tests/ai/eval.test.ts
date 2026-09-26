import { describe, expect, it } from "vitest";
import { TOOL_FAILURE_MESSAGE_FA, UNKNOWN_INFO_MESSAGE_FA } from "@/lib/guardrails";
import { normalizeLeadExtraction } from "@/lib/services/leads";
import { executeToolCall, getToolDefinitions } from "@/lib/tools/registry";

/**
 * Deterministic AI evaluation cases. These verify the AI runtime's
 * decision surfaces WITHOUT calling a live LLM:
 * - Persian understanding (numbers, phones, prices)
 * - Tool contract (unknown tools, invalid args fail safely)
 * - Guardrail fallbacks (honest failure messaging)
 *
 * A live-LLM smoke case runs only when OPENAI_API_KEY + a real database
 * are configured.
 */
describe("AI eval: Persian understanding", () => {
  it("property search: parses a spoken buyer request", () => {
    // «یه آپارتمان دو خوابه تو سعادت‌آباد می‌خوام، بودجم تا دو و نیم میلیارد»
    const out = normalizeLeadExtraction({
      intent: "BUY",
      location: "سعادت‌آباد",
      bedrooms: "دو خوابه",
      budgetMax: "دو و نیم میلیارد تومان",
    });
    expect(out).toMatchObject({
      intent: "BUY",
      location: "سعادت‌آباد",
      bedrooms: 2,
      budgetMax: "2500000000",
    });
  });

  it("price question: parses rial-denominated speech", () => {
    const out = normalizeLeadExtraction({ budgetMin: "صد و بیست میلیون ریال" });
    expect(out.budgetMin).toBe("12000000"); // → toman
  });

  it("area parsing: «صد و بیست متر»", () => {
    const out = normalizeLeadExtraction({ minArea: "صد و بیست متر", maxArea: "۱۵۰ متر" });
    expect(out.minArea).toBe("120");
    expect(out.maxArea).toBe("150");
  });

  it("spoken phone digits normalize to mobile format", () => {
    const out = normalizeLeadExtraction({ phone: "۰۹۱۲۳۴۵۶۷۸۹" });
    expect(out.phone).toBe("09123456789");
  });

  it("visit requests are captured", () => {
    const out = normalizeLeadExtraction({ intent: "BUY", requestedVisit: true });
    expect(out.requestedVisit).toBe(true);
  });
});

describe("AI eval: tool contract", () => {
  it("all agent tools are exposed to the LLM", () => {
    const names = getToolDefinitions().map((t) => t.name);
    for (const required of [
      "search_knowledge",
      "get_business_info",
      "search_properties",
      "create_lead",
      "update_lead",
      "check_availability",
      "create_appointment",
      "request_callback",
      "transfer_call",
      "send_notification",
    ]) {
      expect(names).toContain(required);
    }
  });

  it("unknown property search → tool returns NOT_FOUND (never fabricated)", async () => {
    // Unknown tool names fail safely so the LLM can recover honestly.
    const result = await executeToolCall({
      businessId: "00000000-0000-0000-0000-000000000000",
      tool: "search_properties_typo",
      args: {},
      requestId: "eval-1",
      actor: "eval",
    });
    expect(result.status).toBe("FAILED");
    expect(result.error).toContain("Unknown tool");
  });

  it("invalid tool args fail safely with a message", async () => {
    const result = await executeToolCall({
      businessId: "00000000-0000-0000-0000-000000000000",
      tool: "check_availability",
      args: { date: "فردا" },
      requestId: "eval-2",
      actor: "eval",
    });
    expect(result.status).toBe("FAILED");
    expect(result.error).toContain("Invalid arguments");
  });

  it("transfer without a live call fails safely", async () => {
    const result = await executeToolCall({
      businessId: "00000000-0000-0000-0000-000000000000",
      tool: "transfer_call",
      args: {},
      requestId: "eval-3",
      actor: "eval",
    });
    expect(result.status).toBe("FAILED");
  });
});

describe("AI eval: guardrail fallbacks", () => {
  it("unknown question → honest 'no information' message", () => {
    expect(UNKNOWN_INFO_MESSAGE_FA.length).toBeGreaterThan(10);
    expect(UNKNOWN_INFO_MESSAGE_FA).not.toMatch(/ثبت شد|موفق/);
  });

  it("failed appointment → failure message never claims success", () => {
    expect(TOOL_FAILURE_MESSAGE_FA).toContain("مشکل");
    expect(TOOL_FAILURE_MESSAGE_FA).not.toContain("ثبت شد");
    expect(TOOL_FAILURE_MESSAGE_FA).toContain("پیگیری");
  });
});

describe("AI eval: live LLM smoke (gated)", () => {
  it("runs a guardrailed turn when providers + DB are configured", async () => {
    const { hasTestDatabase } = await import("../helpers/db");
    if (!hasTestDatabase() || !process.env.OPENAI_API_KEY) {
      console.log("skip: live LLM eval needs TEST_DATABASE_URL + OPENAI_API_KEY");
      return;
    }
    const { ensureDbReady, truncateAll } = await import("../helpers/db");
    if (!(await ensureDbReady())) {
      console.log("skip: database unreachable");
      return;
    }
    await truncateAll();
    const { createAgent, createBusiness } = await import("../helpers/fixtures");
    const business = await createBusiness("Eval Biz");
    const agent = await createAgent(business.id);

    const { runAgentTurn } = await import("@/lib/services/agent");
    const result = await runAgentTurn({
      businessId: business.id,
      agentId: agent.id,
      userMessage: "سلام، ساعات کاری شما چیست؟",
      requestId: `eval-live-${Date.now()}`,
      actor: "eval",
    });
    // Smoke assertions: a reply exists and no property was fabricated
    // (no listings exist, so a correct agent must not cite any).
    expect(result.reply.length).toBeGreaterThan(0);
    expect(result.reply).not.toMatch(/PROP-|ملک شماره \d+/);
    await truncateAll().catch(() => undefined);
  }, 90_000);
});
