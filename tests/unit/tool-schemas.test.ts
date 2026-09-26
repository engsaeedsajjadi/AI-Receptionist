import { describe, expect, it } from "vitest";
import { getToolDefinitions, listTools } from "@/lib/tools/registry";

const REQUIRED_TOOLS = [
  "search_knowledge",
  "get_business_info",
  "search_properties",
  "create_lead",
  "update_lead",
  "check_availability",
  "create_appointment",
  "request_callback",
  "transfer_call",
  "send_notification",
];

describe("tool registry", () => {
  it("exposes all required tools", () => {
    const names = listTools().map((t) => t.name).sort();
    expect(names).toEqual([...REQUIRED_TOOLS].sort());
  });

  it("derives valid JSON schemas for the LLM", () => {
    for (const def of getToolDefinitions()) {
      expect(def.name).toBeTruthy();
      expect(def.description.length).toBeGreaterThan(10);
      expect(def.parameters).toMatchObject({ type: "object" });
    }
  });

  it("validates check_availability input", () => {
    const tool = listTools().find((t) => t.name === "check_availability")!;
    expect(tool.schema.safeParse({ date: "2026-10-01" }).success).toBe(true);
    expect(tool.schema.safeParse({ date: "not-a-date" }).success).toBe(false);
    expect(tool.schema.safeParse({}).success).toBe(false);
  });

  it("validates create_lead input", () => {
    const tool = listTools().find((t) => t.name === "create_lead")!;
    expect(tool.schema.safeParse({ intent: "BUY", phone: "09123456789" }).success).toBe(true);
    expect(tool.schema.safeParse({ intent: "INVALID" }).success).toBe(false);
  });

  it("validates create_appointment input", () => {
    const tool = listTools().find((t) => t.name === "create_appointment")!;
    expect(tool.schema.safeParse({ scheduledAt: "2026-10-01T10:00:00+03:30" }).success).toBe(true);
    expect(tool.schema.safeParse({ scheduledAt: "tomorrow" }).success).toBe(false);
  });

  it("validates transfer_call input", () => {
    const tool = listTools().find((t) => t.name === "transfer_call")!;
    expect(tool.schema.safeParse({}).success).toBe(true);
    expect(tool.schema.safeParse({ reason: "customer asked" }).success).toBe(true);
  });
});
