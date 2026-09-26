import { NextRequest } from "next/server";
import { it, describe, expect } from "vitest";
import { computeHmacHex } from "@/lib/security";

const SECRET = "test-webhook-secret";

function webhookRequest(body: unknown, headers: Record<string, string>): NextRequest {
  return new NextRequest(new Request("http://localhost/api/v1/webhooks/voice/call-started", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  }));
}

describe("webhook security", () => {
  it("accepts a correctly signed payload", async () => {
    const { verifyWebhookRequest } = await import("@/lib/security");
    const body = { business_id: "b", external_call_id: "c" };
    const raw = JSON.stringify(body);
    const req = webhookRequest(body, {
      "x-webhook-signature": computeHmacHex(SECRET, raw),
      "x-idempotency-key": `k-${Date.now()}-1`,
    });
    const result = await verifyWebhookRequest(req, { secret: SECRET, scope: "test" });
    expect(result.duplicate).toBe(false);
    expect(result.payload).toMatchObject(body);
  });

  it("flags redeliveries as duplicates (idempotency)", async () => {
    const { verifyWebhookRequest } = await import("@/lib/security");
    const body = { n: 1 };
    const raw = JSON.stringify(body);
    const key = `k-${Date.now()}-2`;
    const sig = computeHmacHex(SECRET, raw);
    const first = await verifyWebhookRequest(
      webhookRequest(body, { "x-webhook-signature": sig, "x-idempotency-key": key }),
      { secret: SECRET, scope: "test" },
    );
    const second = await verifyWebhookRequest(
      webhookRequest(body, { "x-webhook-signature": sig, "x-idempotency-key": key }),
      { secret: SECRET, scope: "test" },
    );
    expect(first.duplicate).toBe(false);
    expect(second.duplicate).toBe(true);
  });

  it("rejects invalid signatures", async () => {
    const { verifyWebhookRequest } = await import("@/lib/security");
    const req = webhookRequest({ a: 1 }, { "x-webhook-signature": "bad", "x-idempotency-key": "k-x" });
    await expect(verifyWebhookRequest(req, { secret: SECRET, scope: "test" })).rejects.toMatchObject({
      code: "INVALID_SIGNATURE",
    });
  });

  it("rejects missing headers", async () => {
    const { verifyWebhookRequest } = await import("@/lib/security");
    const req = webhookRequest({ a: 1 }, {});
    await expect(verifyWebhookRequest(req, { secret: SECRET, scope: "test" })).rejects.toMatchObject({
      status: 401,
    });
  });

  it("rejects stale timestamps (replay protection)", async () => {
    const { verifyWebhookRequest } = await import("@/lib/security");
    const body = { a: 1 };
    const raw = JSON.stringify(body);
    const oldTs = Math.floor(Date.now() / 1000) - 3600;
    const sig = computeHmacHex(SECRET, `${oldTs}.${raw}`);
    const req = webhookRequest(body, {
      "x-webhook-signature": `t=${oldTs},v1=${sig}`,
      "x-idempotency-key": `k-${Date.now()}-3`,
    });
    await expect(verifyWebhookRequest(req, { secret: SECRET, scope: "test" })).rejects.toMatchObject({
      code: "STALE_TIMESTAMP",
    });
  });

  it("accepts fresh composite signatures", async () => {
    const { verifyWebhookRequest } = await import("@/lib/security");
    const body = { a: 1 };
    const raw = JSON.stringify(body);
    const ts = Math.floor(Date.now() / 1000);
    const sig = computeHmacHex(SECRET, `${ts}.${raw}`);
    const req = webhookRequest(body, {
      "x-webhook-signature": `t=${ts},v1=${sig}`,
      "x-idempotency-key": `k-${Date.now()}-4`,
    });
    const result = await verifyWebhookRequest(req, { secret: SECRET, scope: "test" });
    expect(result.duplicate).toBe(false);
  });

  it("rejects oversized payloads", async () => {
    const { verifyWebhookRequest } = await import("@/lib/security");
    const big = { blob: "x".repeat(2 * 1024 * 1024) };
    const raw = JSON.stringify(big);
    const req = webhookRequest(big, {
      "x-webhook-signature": computeHmacHex(SECRET, raw),
      "x-idempotency-key": "k-big",
    });
    await expect(verifyWebhookRequest(req, { secret: SECRET, scope: "test" })).rejects.toMatchObject({
      code: "PAYLOAD_TOO_LARGE",
    });
  });
});
