import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetEnvCache } from "@/lib/env";

const ENV_KEYS = ["N8N_ENABLED", "N8N_URL", "N8N_WEBHOOK_SECRET", "N8N_MAX_RETRIES"] as const;
let saved: Record<string, string | undefined>;

function stubFetch(script: Array<{ ok: boolean; status: number; body?: string } | Error>) {
  const seen: Array<{ url: string; headers: Record<string, string>; body: string }> = [];
  let calls = 0;
  const fetchImpl = vi.fn(async (url: string, init: { headers: Record<string, string>; body: string }) => {
    seen.push({ url, headers: init.headers, body: init.body });
    const next = script[Math.min(calls++, script.length - 1)];
    if (next instanceof Error) throw next;
    return { ok: next.ok, status: next.status, text: async () => next.body ?? "" };
  });
  return { fetchImpl: fetchImpl as unknown as typeof fetch, seen, calls: () => calls };
}

describe("emitAutomationEvent delivery", () => {
  beforeEach(() => {
    saved = {};
    for (const k of ENV_KEYS) saved[k] = process.env[k];
    process.env.N8N_ENABLED = "true";
    process.env.N8N_URL = "https://n8n.example.test";
    process.env.N8N_WEBHOOK_SECRET = "test-automation-token";
    process.env.N8N_MAX_RETRIES = "2";
    resetEnvCache();
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    resetEnvCache();
    vi.restoreAllMocks();
  });

  it("skips without calling fetch when disabled", async () => {
    process.env.N8N_ENABLED = "false";
    resetEnvCache();
    const { emitAutomationEvent } = await import("@/lib/services/n8n");
    const { fetchImpl, calls } = stubFetch([{ ok: true, status: 200 }]);
    const result = await emitAutomationEvent("new-lead", { id: "l1" }, { fetchImpl });
    expect(result).toMatchObject({ ok: true, skipped: true, attempts: 0 });
    expect(calls()).toBe(0);
  });

  it("retries a persistent 500 and reports attempts", async () => {
    const { emitAutomationEvent } = await import("@/lib/services/n8n");
    const { fetchImpl, calls, seen } = stubFetch([{ ok: false, status: 500, body: "boom" }]);
    const result = await emitAutomationEvent(
      "new-lead",
      { id: "l1" },
      { fetchImpl, baseDelayMs: 1 },
    );
    expect(result).toMatchObject({ ok: false, attempts: 3, error: "n8n_http_500" });
    expect(calls()).toBe(3);
    // Every attempt posts the same envelope + stable idempotency key.
    const keys = new Set(seen.map((s) => s.headers["x-idempotency-key"]));
    expect(keys.size).toBe(1);
    for (const s of seen) {
      expect(s.url).toBe("https://n8n.example.test/webhook/ai-receptionist/new-lead");
      expect(s.headers["x-automation-token"]).toBe("test-automation-token");
      expect(s.headers).not.toHaveProperty("x-webhook-signature");
      expect(JSON.parse(s.body).idempotency_key).toBe([...keys][0]);
    }
  });

  it("does not retry a 400 rejection", async () => {
    const { emitAutomationEvent } = await import("@/lib/services/n8n");
    const { fetchImpl, calls } = stubFetch([{ ok: false, status: 400, body: "bad" }]);
    const result = await emitAutomationEvent("new-lead", { id: "l1" }, { fetchImpl, baseDelayMs: 1 });
    expect(result).toMatchObject({ ok: false, attempts: 1, error: "n8n_http_400" });
    expect(calls()).toBe(1);
  });

  it("recovers when a retry succeeds", async () => {
    const { emitAutomationEvent } = await import("@/lib/services/n8n");
    const { fetchImpl } = stubFetch([
      { ok: false, status: 503 },
      { ok: true, status: 200 },
    ]);
    const result = await emitAutomationEvent("new-lead", { id: "l1" }, { fetchImpl, baseDelayMs: 1 });
    expect(result).toMatchObject({ ok: true, attempts: 2 });
  });

  it("retries thrown network errors", async () => {
    const { emitAutomationEvent } = await import("@/lib/services/n8n");
    const { fetchImpl, calls } = stubFetch([new Error("socket hang up")]);
    const result = await emitAutomationEvent(
      "new-lead",
      { id: "l1" },
      { fetchImpl, baseDelayMs: 1, maxRetries: 1 },
    );
    expect(result).toMatchObject({ ok: false, attempts: 2 });
    expect(calls()).toBe(2);
    expect(result.error).toContain("socket hang up");
  });

  it("honors an explicit idempotency key", async () => {
    const { emitAutomationEvent } = await import("@/lib/services/n8n");
    const { fetchImpl, seen } = stubFetch([{ ok: true, status: 200 }]);
    await emitAutomationEvent(
      "call-completed",
      { id: "c1" },
      { fetchImpl, idempotencyKey: "call-completed:c1" },
    );
    expect(seen[0].headers["x-idempotency-key"]).toBe("call-completed:c1");
    expect(JSON.parse(seen[0].body).idempotency_key).toBe("call-completed:c1");
  });
});
