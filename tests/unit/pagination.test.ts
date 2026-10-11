import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { cursorPage, decodeCursor, encodeCursor, keysetCondition, parseListWindow } from "@/lib/pagination";

const ID_A = "11111111-1111-4111-8111-111111111111";
const ID_B = "22222222-2222-4222-8222-222222222222";

function request(query: string) {
  return new NextRequest(`http://localhost/api/v1/leads${query}`);
}

describe("cursor pagination", () => {
  it("round-trips a cursor and rejects anything malformed", () => {
    const createdAt = new Date("2026-01-02T03:04:05.678Z");
    const cursor = encodeCursor({ createdAt, id: ID_A });
    expect(cursor).not.toContain("=");

    const decoded = decodeCursor(cursor);
    expect(decoded.id).toBe(ID_A);
    expect(decoded.createdAt.toISOString()).toBe(createdAt.toISOString());

    for (const bad of ["", "not-base64!!", Buffer.from("{}").toString("base64url"), Buffer.from(JSON.stringify({ t: "nope", id: ID_A })).toString("base64url"), Buffer.from(JSON.stringify({ t: createdAt.toISOString(), id: "not-a-uuid" })).toString("base64url")]) {
      expect(() => decodeCursor(bad)).toThrowError(/Invalid cursor/);
    }
  });

  it("parses limit, cursor and the legacy page window without trusting either", () => {
    expect(parseListWindow(request("")).limit).toBe(20);
    expect(parseListWindow(request("?limit=3")).limit).toBe(3);
    // Bounds: 0/negative/absurd limits clamp instead of throwing or unbounded scans.
    expect(parseListWindow(request("?limit=0")).limit).toBe(20);
    expect(parseListWindow(request("?limit=-5")).limit).toBe(20);
    expect(parseListWindow(request("?limit=100000")).limit).toBe(100);
    expect(parseListWindow(request("?limit=abc")).limit).toBe(20);

    const page = parseListWindow(request("?page=3&limit=10"));
    expect(page).toMatchObject({ page: 3, offset: 20, cursor: null });
    expect(parseListWindow(request("?page=0")).page).toBe(1);

    const window = parseListWindow(request(`?cursor=${encodeCursor({ createdAt: new Date(), id: ID_B })}`));
    expect(window.cursor?.id).toBe(ID_B);
    expect(() => parseListWindow(request("?cursor=garbage"))).toThrowError(/Invalid cursor/);
  });

  it("builds a strictly-decreasing keyset condition", () => {
    const condition = keysetCondition(
      { createdAt: "created_at", id: "id" },
      { createdAt: new Date("2026-01-01T00:00:00.000Z"), id: ID_A },
    );
    const query = JSON.stringify(condition);
    expect(query).toContain("created_at");
    // Tie rows on created_at are broken by id, so a page boundary inside a
    // same-timestamp batch cannot loop or skip.
    expect(query).toContain("id");
  });

  it("reports hasMore/nextCursor from an extra row or an exact total", () => {
    const rows = [
      { id: ID_A, createdAt: new Date("2026-01-03T00:00:00.000Z") },
      { id: ID_B, createdAt: new Date("2026-01-02T00:00:00.000Z") },
      { id: "33333333-3333-4333-8333-333333333333", createdAt: new Date("2026-01-01T00:00:00.000Z") },
    ];

    const cursorMode = cursorPage({ rows, limit: 2, extra: true, total: 10 });
    expect(cursorMode.data).toHaveLength(2);
    expect(cursorMode.hasMore).toBe(true);
    expect(decodeCursor(cursorMode.nextCursor as string).id).toBe(ID_B);

    const lastPage = cursorPage({ rows: rows.slice(0, 1), limit: 2, extra: true, total: 3 });
    expect(lastPage.hasMore).toBe(false);
    expect(lastPage.nextCursor).toBeNull();

    const offsetMode = cursorPage({ rows: rows.slice(0, 2), limit: 2, page: 1, total: 3 });
    expect(offsetMode.hasMore).toBe(true);
    expect(offsetMode.pagination).toMatchObject({ page: 1, limit: 2, total: 3, totalPages: 2 });
    expect(cursorPage({ rows: rows.slice(0, 2), limit: 2, page: 2, total: 3 }).hasMore).toBe(false);
  });
});
