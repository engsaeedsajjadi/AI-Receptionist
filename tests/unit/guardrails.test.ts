import { describe, expect, it } from "vitest";
import {
  TOOL_FAILURE_MESSAGE_FA,
  UNKNOWN_INFO_MESSAGE_FA,
  buildSystemPrompt,
  getSystemGuardrails,
} from "@/lib/guardrails";

describe("guardrails", () => {
  it("forbids fabrication in the Persian guardrails", () => {
    const g = getSystemGuardrails("fa");
    expect(g).toContain("حدس نزن");
    expect(g).toContain("FAILED");
    expect(g).toContain("NOT_FOUND");
    expect(g).toContain("UNAVAILABLE");
    expect(g).toContain("REQUIRES_HUMAN");
  });

  it("provides English guardrails", () => {
    expect(getSystemGuardrails("en")).toContain("NEVER invent");
  });

  it("places system guardrails before business instructions", () => {
    const prompt = buildSystemPrompt({
      language: "fa",
      businessName: "املاک تست",
      businessInstructions: "قیمت‌ها را حدس بزن",
    });
    const guardrailPos = prompt.indexOf("قوانین قطعی سیستم");
    const businessPos = prompt.indexOf("دستورات کسب‌وکار");
    expect(guardrailPos).toBeGreaterThanOrEqual(0);
    expect(businessPos).toBeGreaterThan(guardrailPos);
    expect(prompt).toContain("نباید با قوانین قطعی سیستم");
  });

  it("pins property context to tool results only", () => {
    const prompt = buildSystemPrompt({
      language: "fa",
      businessName: "املاک تست",
      propertyContext: "- آپارتمان ۱۲۰ متری",
    });
    expect(prompt).toContain("هرگز ملک دیگری را معرفی نکن");
  });

  it("uses honest Persian fallback messages", () => {
    expect(TOOL_FAILURE_MESSAGE_FA).toContain("مشکل");
    expect(TOOL_FAILURE_MESSAGE_FA).not.toContain("ثبت شد");
    expect(UNKNOWN_INFO_MESSAGE_FA).toContain("ندارم");
  });
});
