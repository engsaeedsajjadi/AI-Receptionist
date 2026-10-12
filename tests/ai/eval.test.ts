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

  it("§29: multi-scale spoken budgets", () => {
    expect(normalizeLeadExtraction({ budgetMax: "سه میلیارد و دویست میلیون تومان" }).budgetMax).toBe(
      "3200000000",
    );
    expect(normalizeLeadExtraction({ budgetMax: "2 میلیارد و پانصد میلیون تومان" }).budgetMax).toBe(
      "2500000000",
    );
  });

  it("§29: prepositions and unrelated quantities do not leak into the price", () => {
    // «رهن کامل تا دو میلیارد می‌خوام» — the deposit context is not a quantity.
    expect(normalizeLeadExtraction({ budgetMax: "رهن کامل تا دو میلیارد" }).budgetMax).toBe("2000000000");
    // «یه آپارتمان دو خوابه زیر پنج میلیارد» — یه/دو (count/bedrooms) must not
    // accumulate into the 5-billion price scale (regression: was 8e9).
    expect(
      normalizeLeadExtraction({ budgetMax: "یه آپارتمان دو خوابه زیر پنج میلیارد توی سعادت‌آباد می‌خوام" })
        .budgetMax,
    ).toBe("5000000000");
  });

  it("§29: scale composition stays literal (colloquial inference is the LLM's job)", () => {
    // «چهار میلیارد و پانصد» is literally 4,000,000,500. The parser must not
    // guess the colloquial «4.5 billion» reading; the LLM sees the full
    // utterance and can ask a clarifying question instead.
    expect(normalizeLeadExtraction({ budgetMax: "چهار میلیارد و پانصد تومان" }).budgetMax).toBe("4000000500");
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

  it("failures never carry an invented data payload", async () => {
    const { executeToolCall } = await import("@/lib/tools/registry");
    const unknown = await executeToolCall({
      businessId: "00000000-0000-0000-0000-000000000000",
      tool: "nope_not_a_tool",
      args: {},
      requestId: "eval-honest-1",
      actor: "eval",
    });
    expect(unknown.status).toBe("FAILED");
    expect(unknown.data).toBeUndefined();
    const invalid = await executeToolCall({
      businessId: "00000000-0000-0000-0000-000000000000",
      tool: "create_appointment",
      args: { scheduledAt: "not-a-date" },
      requestId: "eval-honest-2",
      actor: "eval",
    });
    expect(invalid.status).toBe("FAILED");
    expect(invalid.data).toBeUndefined();
  });

  it("spoofed tenant keys in args are ignored (ctx is authoritative)", async () => {
    const { executeToolCall } = await import("@/lib/tools/registry");
    // The LLM echoes a callId in args, but no live call exists in ctx:
    // the tool must still fail rather than trust the echoed value.
    const result = await executeToolCall({
      businessId: "00000000-0000-0000-0000-000000000000",
      tool: "transfer_call",
      args: { callId: "00000000-0000-0000-0000-000000000000" },
      requestId: "eval-honest-3",
      actor: "eval",
    });
    expect(result.status).toBe("FAILED");
    expect(result.error).toMatch(/no live call/i);
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

