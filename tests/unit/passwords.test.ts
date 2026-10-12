import { describe, expect, it } from "vitest";
import { hash } from "bcryptjs";
import { hashPassword, verifyPassword } from "@/lib/passwords";
describe("versioned password hashing", () => {
  it("preserves long Unicode passwords beyond the bcrypt boundary", async () => {
    const prefix = "گذرواژه".repeat(9);
    const stored = await hashPassword(prefix + "1");
    expect(stored).not.toContain(prefix);
    expect(await verifyPassword(prefix + "1", stored)).toBe(true);
    expect(await verifyPassword(prefix + "2", stored)).toBe(false);
    expect(await hashPassword(prefix + "1")).not.toBe(stored);
  });
  it("retains legacy bcrypt sign-in and rejects malformed or unapproved hash parameters", async () => {
    expect(await verifyPassword("Legacy123!", await hash("Legacy123!", 10))).toBe(true);
    expect(await verifyPassword("x", "$scrypt$n=999999999,r=8,p=3$invalid$hash")).toBe(false);
    expect(await verifyPassword("x", "$scrypt$n=32768,r=8,p=3$invalid$hash")).toBe(false);
  });
});
