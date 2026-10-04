import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { parseJson } from "@/lib/api";
describe("bounded JSON requests", () => {
  it("preserves Unicode and rejects malformed JSON", async () => {
    const make = (body: string) => new NextRequest("http://localhost/api", { method: "POST", body });
    expect(await parseJson(make('{"text":"سلام"}'))).toEqual({ text: "سلام" });
    await expect(parseJson(make("{"))).rejects.toMatchObject({ status: 400, code: "INVALID_JSON" });
    await expect(parseJson(make(JSON.stringify({ text: "x".repeat(2 * 1024 * 1024) })))).rejects.toMatchObject({ status: 413, code: "PAYLOAD_TOO_LARGE" });
  });
});
