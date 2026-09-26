import { describe, expect, it } from "vitest";
import { AppError, toErrorPayload } from "@/lib/errors";
import { estimateCost } from "@/lib/pricing";

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
