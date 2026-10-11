import { afterEach, describe, expect, it, vi } from "vitest";
import { decodeBase32, encodeBase32, totp, matchingTotpStep, encryptMfa, decryptMfa, newRecoveryCodes } from "@/lib/mfa";
afterEach(() => vi.unstubAllEnvs());
describe("MFA", () => {
  const secret = encodeBase32(Buffer.from("12345678901234567890"));
  it.each([[59, "94287082"], [1111111109, "07081804"], [1111111111, "14050471"], [1234567890, "89005924"], [2000000000, "69279037"], [20000000000, "65353130"]])("matches RFC 6238 SHA1 vector at %i", (time, expected) => {
    expect(totp(secret, Number(time), 8)).toBe(expected);
  });
  it("rejects reuse, invalid codes and expired time windows", () => {
    const code = totp(secret, 120);
    expect(matchingTotpStep(secret, code, -1, 120)).toBe(4);
    expect(matchingTotpStep(secret, code, 4, 120)).toBeNull();
    expect(matchingTotpStep(secret, code, -1, 600)).toBeNull();
    expect(matchingTotpStep(secret, "abcdef", -1, 120)).toBeNull();
  });
  it("round-trips base32 and rejects illegal characters", () => {
    expect(decodeBase32(secret).toString()).toBe("12345678901234567890");
    expect(() => decodeBase32("!invalid")).toThrow();
  });
  it("binds encrypted secrets to the user and rejects tampering", () => {
    vi.stubEnv("IDENTITY_ENCRYPTION_KEY", "ab".repeat(32));
    const encrypted = encryptMfa(secret, "one");
    expect(decryptMfa(encrypted, "one")).toBe(secret);
    expect(() => decryptMfa(encrypted, "two")).toThrow();
    const [iv, tag, data] = encrypted.split(".");
    // Tamper with a real byte of the ciphertext (a base64url character swap can
    // be a no-op when it lands in padding bits, so decode → flip → re-encode).
    const raw = Buffer.from(data, "base64url");
    raw[0] = raw[0] ^ 0xff;
    const tampered = raw.toString("base64url");
    expect(tampered).not.toBe(data);
    expect(() => decryptMfa(`${iv}.${tag}.${tampered}`, "one")).toThrow();
    // A different IV/tag combination must also be rejected.
    expect(() => decryptMfa(`AAAA.${tag}.${data}`, "one")).toThrow();
    expect(new Set(newRecoveryCodes()).size).toBe(10);
  });
});
