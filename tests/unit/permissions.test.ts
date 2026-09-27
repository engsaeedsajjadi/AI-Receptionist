import { describe, expect, it } from "vitest";
import { hasRole } from "@/lib/permissions";

describe("hasRole", () => {
  it("grants same-level access", () => {
    expect(hasRole("ADMIN", "ADMIN")).toBe(true);
    expect(hasRole("MANAGER", "MANAGER")).toBe(true);
    expect(hasRole("AGENT", "AGENT")).toBe(true);
  });

  it("grants upward access", () => {
    expect(hasRole("ADMIN", "MANAGER")).toBe(true);
    expect(hasRole("ADMIN", "AGENT")).toBe(true);
    expect(hasRole("MANAGER", "AGENT")).toBe(true);
  });

  it("denies downward access", () => {
    expect(hasRole("AGENT", "MANAGER")).toBe(false);
    expect(hasRole("AGENT", "ADMIN")).toBe(false);
    expect(hasRole("MANAGER", "ADMIN")).toBe(false);
  });
});
