import { describe, expect, it } from "vitest";
import { normalizeLeadExtraction } from "@/lib/services/leads";
import { AppError } from "@/lib/errors";

describe("normalizeLeadExtraction", () => {
  it("validates and normalizes a full extraction", () => {
    const out = normalizeLeadExtraction({
      name: "علي",
      phone: "+989123456789",
      intent: "BUY",
      location: "سعادت آباد",
      budgetMin: "دو میلیارد تومان",
      budgetMax: "سه میلیارد تومان",
      minArea: "هشتاد متر",
      maxArea: "صد و بیست متر",
      bedrooms: "سه خوابه",
      timeframe: "urgent",
      requestedVisit: true,
      summary: "مشتری دنبال آپارتمان است",
    });
    expect(out).toMatchObject({
      name: "علی",
      phone: "09123456789",
      intent: "BUY",
      location: "سعادت آباد",
      budgetMin: "2000000000",
      budgetMax: "3000000000",
      minArea: "80",
      maxArea: "120",
      bedrooms: 3,
      requestedVisit: true,
    });
  });

  it("converts rial budgets to toman", () => {
    const out = normalizeLeadExtraction({ budgetMax: "۲۰۰ میلیون ریال", intent: "RENT" });
    expect(out.budgetMax).toBe("20000000");
  });

  it("defaults intent and visit flag", () => {
    const out = normalizeLeadExtraction({});
    expect(out.intent).toBe("OTHER");
    expect(out.requestedVisit).toBe(false);
    expect(out.phone).toBeNull();
  });

  it("rejects invalid intent", () => {
    expect(() => normalizeLeadExtraction({ intent: "STEAL" })).toThrow(AppError);
  });

  it("rejects overlong fields", () => {
    expect(() => normalizeLeadExtraction({ name: "x".repeat(300) })).toThrow(AppError);
  });

  it("nulls invalid phones instead of passing them through", () => {
    const out = normalizeLeadExtraction({ phone: "not-a-number" });
    expect(out.phone).toBeNull();
  });
});
