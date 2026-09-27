import { afterEach, describe, expect, it } from "vitest";
import { AppError, toErrorPayload } from "@/lib/errors";
import { estimateCost, getPricing } from "@/lib/pricing";

describe("pricing", () => {
  it("estimates known usage types", () => {
    const cost = estimateCost("llm_input_tokens", 1000);
    expect(cost).toBeGreaterThan(0);
    expect(estimateCost("calls", 5)).toBe(0);
  });

  it("returns null for unknown types or invalid quantities", () => {
    expect(estimateCost("nope", 10)).toBeNull();
    expect(estimateCost("calls", NaN)).toBeNull();
    expect(estimateCost("calls", -1)).toBeNull();
  });

  it("default rates match published OpenAI prices (verified Sep 2026)", () => {
    // gpt-4o-mini $0.15/$0.60 per 1M, whisper $0.006/min, tts-1 $15/1M chars,
    // text-embedding-3-small $0.02/1M. These are ESTIMATES (see pricing.ts);
    // PRICING_JSON overrides them at runtime without code changes.
    expect(estimateCost("llm_input_tokens", 1_000_000)).toBeCloseTo(0.15, 10);
    expect(estimateCost("llm_output_tokens", 1_000_000)).toBeCloseTo(0.6, 10);
    expect(estimateCost("stt_minutes", 1)).toBeCloseTo(0.006, 10);
    expect(estimateCost("tts_characters", 1_000_000)).toBeCloseTo(15, 10);
    expect(estimateCost("embedding_tokens", 1_000_000)).toBeCloseTo(0.02, 10);
  });
});

describe("pricing overrides (PRICING_JSON)", () => {
  const saved = process.env.PRICING_JSON;
  afterEach(() => {
    if (saved === undefined) delete process.env.PRICING_JSON;
    else process.env.PRICING_JSON = saved;
  });

  it("overrides known rates without touching the table", () => {
    process.env.PRICING_JSON = JSON.stringify({ llm_input_tokens: { perUnit: 0.000001 } });
    expect(getPricing().llm_input_tokens.perUnit).toBe(0.000001);
    expect(estimateCost("llm_input_tokens", 1000)).toBeCloseTo(0.001, 10);
    // Untouched rates keep defaults.
    expect(getPricing().llm_output_tokens.perUnit).toBe(0.0000006);
  });

  it("ignores unknown keys, non-numeric rates, and invalid JSON", () => {
    process.env.PRICING_JSON = JSON.stringify({ nope: { perUnit: 99 }, calls: { perUnit: "free" } });
    expect(estimateCost("calls", 5)).toBe(0);
    expect(getPricing().nope).toBeUndefined();
    process.env.PRICING_JSON = "{not json";
    expect(estimateCost("llm_input_tokens", 1_000_000)).toBeCloseTo(0.15, 10);
  });
});

describe("error payload", () => {
  it("maps AppError to the standard envelope", () => {
    const { status, body } = toErrorPayload(new AppError(404, "LEAD_NOT_FOUND", "Lead not found"), "rid-1");
    expect(status).toBe(404);
    expect(body).toEqual({
      success: false,
      error: { code: "LEAD_NOT_FOUND", message: "Lead not found", requestId: "rid-1" },
    });
  });

  it("adds Retry-After for rate limits", () => {
    const { status, headers } = toErrorPayload(
      new AppError(429, "RATE_LIMITED", "Too many requests", { retryAfterSeconds: 42 }),
      "rid-2",
    );
    expect(status).toBe(429);
    expect(headers).toEqual({ "Retry-After": "42" });
  });

  it("hides internals for unexpected errors", () => {
    const { status, body } = toErrorPayload(new Error("db exploded: secret"), "rid-3");
    expect(status).toBe(500);
    expect(body.error.code).toBe("INTERNAL_ERROR");
  });
});
