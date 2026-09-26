import { describe, expect, it } from "vitest";
import { deriveToolExecId, stableStringify } from "@/lib/tools/registry";

describe("tool execution identity (P0-3)", () => {
  it("stableStringify is key-order insensitive and skips undefined", () => {
    expect(stableStringify({ b: 2, a: 1 })).toBe(stableStringify({ a: 1, b: 2 }));
    expect(stableStringify({ a: 1, b: undefined })).toBe(stableStringify({ a: 1 }));
    expect(stableStringify({ n: { y: [3, 2], x: 1 } })).toBe('{"n":{"x":1,"y":[3,2]}}');
    // Arrays keep order (semantically significant).
    expect(stableStringify([1, 2])).not.toBe(stableStringify([2, 1]));
  });

  it("derives the same exec id for the same operation regardless of arg order", () => {
    const a = deriveToolExecId("evt-1", "send_notification", { title: "T", message: "M" });
    const b = deriveToolExecId("evt-1", "send_notification", { message: "M", title: "T" });
    expect(a).toBe(b);
    expect(a.length).toBeLessThanOrEqual(255);
  });

  it("derives distinct exec ids for distinct operations", () => {
    const base = deriveToolExecId("evt-1", "send_notification", { title: "T", message: "M" });
    expect(deriveToolExecId("evt-2", "send_notification", { title: "T", message: "M" })).not.toBe(base);
    expect(deriveToolExecId("evt-1", "create_lead", { title: "T", message: "M" })).not.toBe(base);
    expect(deriveToolExecId("evt-1", "send_notification", { title: "T", message: "OTHER" })).not.toBe(base);
  });

  it("caps exec ids at the 255-char event_id column limit", () => {
    const long = `evt-${"x".repeat(300)}`;
    expect(deriveToolExecId(long, "send_notification", { title: "T", message: "M" }).length).toBe(255);
  });
});
