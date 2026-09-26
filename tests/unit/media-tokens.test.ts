import { describe, expect, it } from "vitest";
import { InvalidMediaToken, issueMediaToken, verifyMediaToken } from "@/lib/voice/media-tokens";

const SECRET = "test-media-signing-secret";
const BASE = { businessId: "biz-1", callId: "call-1", externalCallId: "ext-9", ttlSeconds: 900, secret: SECRET };

describe("per-call media tokens", () => {
  it("round-trips call/tenant binding through issue → verify", () => {
    const before = Date.now();
    const token = issueMediaToken(BASE);
    expect(token.startsWith("v1.")).toBe(true);
    const claims = verifyMediaToken(token, SECRET);
    expect(claims).toMatchObject({
      businessId: "biz-1",
      callId: "call-1",
      externalCallId: "ext-9",
    });
    expect(claims.exp).toBeGreaterThanOrEqual(before + 900_000);
    expect(claims.exp).toBeLessThanOrEqual(Date.now() + 900_000);
    expect(claims.nonce).toMatch(/^[0-9a-f]{32}$/);
  });

  it("mints unique tokens per issue (nonce)", () => {
    expect(issueMediaToken(BASE)).not.toBe(issueMediaToken(BASE));
  });

  it("rejects tampered payloads and signatures", () => {
    const token = issueMediaToken(BASE);
    const [v, body, sig] = token.split(".");
    const flip = (s: string) => (s.endsWith("A") ? `${s.slice(0, -1)}B` : `${s.slice(0, -1)}A`);
    for (const bad of [`${v}.${flip(body)}.${sig}`, `${v}.${body}.${flip(sig)}`]) {
      try {
        verifyMediaToken(bad, SECRET);
        expect.unreachable("tampered token must not verify");
      } catch (err) {
        expect(err).toBeInstanceOf(InvalidMediaToken);
        expect((err as InvalidMediaToken).reason).toBe("BAD_SIGNATURE");
      }
    }
  });

  it("rejects tokens signed with a different secret", () => {
    const token = issueMediaToken({ ...BASE, secret: "another-secret" });
    try {
      verifyMediaToken(token, SECRET);
      expect.unreachable("wrong-secret token must not verify");
    } catch (err) {
      expect((err as InvalidMediaToken).reason).toBe("BAD_SIGNATURE");
    }
  });

  it("rejects expired tokens", () => {
    const token = issueMediaToken({ ...BASE, ttlSeconds: 60, nowMs: 1_000_000 });
    try {
      verifyMediaToken(token, SECRET, 1_000_000 + 61_000);
      expect.unreachable("expired token must not verify");
    } catch (err) {
      expect((err as InvalidMediaToken).reason).toBe("EXPIRED");
    }
    // Just before expiry still verifies.
    expect(verifyMediaToken(token, SECRET, 1_000_000 + 59_000).callId).toBe("call-1");
  });

  it("rejects malformed tokens", () => {
    for (const bad of ["", "v1.only-two", "v0.e30.abc", "not-a-token", "v1..", "v1.!!!.abc"]) {
      try {
        verifyMediaToken(bad, SECRET);
        expect.unreachable(`malformed token must not verify: ${bad}`);
      } catch (err) {
        expect(err).toBeInstanceOf(InvalidMediaToken);
        expect(["MALFORMED", "BAD_SIGNATURE"]).toContain((err as InvalidMediaToken).reason);
      }
    }
  });

  it("refuses to issue without a secret or TTL", () => {
    expect(() => issueMediaToken({ ...BASE, secret: "" })).toThrow();
    expect(() => issueMediaToken({ ...BASE, ttlSeconds: 0 })).toThrow();
  });
});
