import { describe, expect, it } from "vitest";
import { nextPageQuery } from "@/components/dashboard/ui";

/**
 * The dashboard table switches from the offset window to the stable cursor once
 * the server reports a total, and always falls back to offsets when the cursor is
 * unknown or the requested page is the last one.
 */
describe("dashboard list window selection", () => {
  it("uses the offset window for the first page and when no cursor is known", () => {
    expect(nextPageQuery({ targetPage: 1, limit: 20 }).toString()).toBe("limit=20&page=1");
    expect(nextPageQuery({ targetPage: 3, limit: 20, cursor: null, total: 500 }).toString()).toBe("limit=20&page=3");
  });

  it("uses the cursor for forward pages when the total is beyond them", () => {
    const query = nextPageQuery({ targetPage: 2, limit: 20, cursor: "abc", total: 500 });
    expect(query.get("cursor")).toBe("abc");
    expect(query.get("page")).toBeNull();
    expect(query.get("limit")).toBe("20");
  });

  it("falls back to offsets on the last page so totals stay exact", () => {
    const last = nextPageQuery({ targetPage: 3, limit: 20, cursor: "abc", total: 45 });
    expect(last.get("cursor")).toBeNull();
    expect(last.get("page")).toBe("3");
  });

  it("carries search and filter parameters into every window", () => {
    const query = nextPageQuery({ targetPage: 2, limit: 20, cursor: "abc", total: 500, search: { q: "تهران", status: "NEW", empty: "" } });
    expect(query.get("cursor")).toBe("abc");
    expect(query.get("q")).toBe("تهران");
    expect(query.get("status")).toBe("NEW");
    expect(query.has("empty")).toBe(false);
  });
});
