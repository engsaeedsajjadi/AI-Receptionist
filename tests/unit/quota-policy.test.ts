import { describe, expect, it } from "vitest";
import { AmountsSchema, checkLimit, decimal, planPolicies, storedUnits, units, windowStart } from "@/lib/quota-policy";
describe("quota arithmetic and policy", () => {
  it("uses conservative four-decimal quantities with exact stored arithmetic", () => {
    expect(decimal(units(1.00001))).toBe("1.0001");
    expect(storedUnits("99999999999.9999") + storedUnits("0.0001")).toBe(BigInt("1000000000000000"));
    for (const amount of [-1, NaN, Infinity, 1e12]) expect(() => units(amount)).toThrow();
    expect(AmountsSchema.safeParse({ invented: 1 }).success).toBe(false);
    expect(AmountsSchema.safeParse({}).success).toBe(false);
  });
  it("distinguishes soft warnings, hard ceilings, explicit grace and unlimited", () => {
    const policy = { hard: 10, soft: 6, grace: 2 };
    expect(checkLimit(policy, units(7))).toEqual({ blocked: false, warning: true });
    expect(checkLimit(policy, units(12)).blocked).toBe(false);
    expect(checkLimit(policy, units(12.0001)).blocked).toBe(true);
    expect(checkLimit(undefined, units(1e9)).blocked).toBe(false);
    expect(checkLimit({ hard: 0, soft: null, grace: 0 }, units(1)).blocked).toBe(true);
  });
  it("uses UTC monthly windows and lifetime inventory windows", () => {
    expect(windowStart("llm_input_tokens", new Date("2026-03-01T00:00:00Z")).toISOString()).toBe("2026-03-01T00:00:00.000Z");
    expect(windowStart("storage_bytes", new Date()).getTime()).toBe(0);
    expect(windowStart("tenant_users", new Date()).getTime()).toBe(0);
  });
  it("rejects malformed catalog and silently unknown meter bypasses", () => {
    expect(planPolicies("")).toEqual({});
    expect(() => planPolicies('{"FREE":{"unknown":{"hard":1}}}')).toThrow();
    expect(() => planPolicies('{"FREE":{"calls":{"hard":5,"soft":6}}}')).toThrow();
    expect(planPolicies('{"FREE":{"calls":{"hard":5}}}').FREE?.calls?.grace).toBe(0);
  });
});
