import { describe, expect, it } from "vitest";
import { addCalendarMonth, billingCatalog, effectivePlan } from "@/lib/billing-catalog";
const catalog = { issuer: "Example Test Company", paymentInstructions: "Contact accounting for payment details", plans: [{ plan: "STARTER", amountMinor: 1234, currency: "USD" }] };
describe("billing calendar and configured catalog", () => {
  it("requires configured positive integer pricing and disallows duplicate plans", () => {
    expect(billingCatalog("")).toBeNull();
    expect(billingCatalog(JSON.stringify(catalog))?.plans[0].amountMinor).toBe(1234);
    for (const amountMinor of [0, -1, 2.5, 2_000_000_001]) expect(() => billingCatalog(JSON.stringify({ ...catalog, plans: [{ ...catalog.plans[0], amountMinor }] }))).toThrow();
    expect(() => billingCatalog(JSON.stringify({ ...catalog, plans: [...catalog.plans, ...catalog.plans] }))).toThrow();
    expect(() => billingCatalog("not json")).toThrow();
    expect(() => billingCatalog(JSON.stringify({ ...catalog, issuer: "" }))).toThrow();
  });
  it("clamps month ends in UTC and preserves time and the input date", () => {
    const date = new Date("2024-01-31T12:30:45.000Z");
    expect(addCalendarMonth(date).toISOString()).toBe("2024-02-29T12:30:45.000Z");
    expect(date.toISOString()).toBe("2024-01-31T12:30:45.000Z");
    expect(addCalendarMonth(new Date("2025-01-31Z")).toISOString()).toBe("2025-02-28T00:00:00.000Z");
    expect(addCalendarMonth(new Date("2025-12-15Z")).toISOString()).toBe("2026-01-15T00:00:00.000Z");
  });
  it("expires at the exact period boundary without relying on cron", () => {
    const now = new Date("2025-05-01Z");
    expect(effectivePlan(undefined, now)).toBe("FREE");
    expect(effectivePlan({ plan: "STARTER", periodEnd: now }, now)).toBe("FREE");
    expect(effectivePlan({ plan: "STARTER", periodEnd: new Date(now.getTime() + 1) }, now)).toBe("STARTER");
    expect(effectivePlan({ plan: "STARTER", periodEnd: null }, now)).toBe("FREE");
  });
});
