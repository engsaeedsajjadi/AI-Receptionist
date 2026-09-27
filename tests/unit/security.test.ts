import { describe, expect, it } from "vitest";
import { computeHmacHex, safeEqual, verifyHmacHex } from "@/lib/security";

describe("webhook HMAC", () => {
  const secret = "test-secret";
  const payload = JSON.stringify({ business_id: "x", ping: 1 });

  it("signs and verifies", () => {
    const sig = computeHmacHex(secret, payload);
    expect(verifyHmacHex(secret, payload, sig)).toBe(true);
  });

  it("rejects tampered payloads", () => {
    const sig = computeHmacHex(secret, payload);
    expect(verifyHmacHex(secret, `${payload}tampered`, sig)).toBe(false);
  });

  it("rejects wrong secrets", () => {
    const sig = computeHmacHex(secret, payload);
    expect(verifyHmacHex("other-secret", payload, sig)).toBe(false);
  });

  it("rejects malformed signatures", () => {
    expect(verifyHmacHex(secret, payload, "zz")).toBe(false);
    expect(verifyHmacHex(secret, payload, "")).toBe(false);
  });
});

describe("safeEqual", () => {
  it("compares safely", () => {
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("abc", "abd")).toBe(false);
    expect(safeEqual("abc", "abcd")).toBe(false);
  });
});
