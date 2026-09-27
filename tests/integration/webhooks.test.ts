import { NextRequest } from "next/server";
import { it, describe, expect } from "vitest";
import { claimWebhookIdempotency, computeHmacHex, verifyWebhookRequest } from "@/lib/security";

const SECRET = "test-webhook-secret";

function webhookRequest(body: unknown, headers: Record<string, string>): NextRequest {
  return new NextRequest(
    new Request("http://localhost/api/v1/webhooks/voice/call-started", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
    }),
  );
}

function signed(body: unknown, key: string, extra?: Record<string, string>): NextRequest {
  const raw = JSON.stringify(body);
  return webhookRequest(body, {
    "x-webhook-signature": computeHmacHex(SECRET, raw),
    "x-idempotency-key": key,
    ...extra,
  });
}

describe("webhook security", () => {
  it("accepts a correctly signed payload", async () => {
    const body = { business_id: "b", external_call_id: "c" };
    const result = await verifyWebhookRequest(signed(body, `k-${Date.now()}-1`), {
      secret: SECRET,
      scope: "test",
    });
    expect(result.payload).toMatchObject(body);
    expect(result.idempotencyKey).toContain("k-");
  });

  it("verification alone never burns the idempotency key", async () => {
    const body = { n: 1 };
    const key = `k-${Date.now()}-verify-noclaim`;
    // Verify twice with the same key: both succeed (no claim inside verify).
    await verifyWebhookRequest(signed(body, key), { secret: SECRET, scope: "test" });
    await verifyWebhookRequest(signed(body, key), { secret: SECRET, scope: "test" });
    // First claim wins, second reports duplicate.
    expect(await claimWebhookIdempotency("test", key)).toBe(true);
    expect(await claimWebhookIdempotency("test", key)).toBe(false);
  });

  it("claims are scoped (same key, different scope)", async () => {
    const key = `k-${Date.now()}-scoped`;
    expect(await claimWebhookIdempotency("test:scope-a", key)).toBe(true);
    expect(await claimWebhookIdempotency("test:scope-b", key)).toBe(true);
    expect(await claimWebhookIdempotency("test:scope-a", key)).toBe(false);
  });

  it("rejects invalid signatures", async () => {
    const req = webhookRequest({ a: 1 }, { "x-webhook-signature": "bad", "x-idempotency-key": "k-x" });
    await expect(verifyWebhookRequest(req, { secret: SECRET, scope: "test" })).rejects.toMatchObject({
      code: "INVALID_SIGNATURE",
    });
  });

  it("rejects missing headers", async () => {
    const req = webhookRequest({ a: 1 }, {});
    await expect(verifyWebhookRequest(req, { secret: SECRET, scope: "test" })).rejects.toMatchObject({
      status: 401,
    });
  });

  it("rejects stale timestamps (replay protection)", async () => {
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
    const body = { a: 1 };
    const raw = JSON.stringify(body);
    const ts = Math.floor(Date.now() / 1000);
    const sig = computeHmacHex(SECRET, `${ts}.${raw}`);
    const req = webhookRequest(body, {
      "x-webhook-signature": `t=${ts},v1=${sig}`,
      "x-idempotency-key": `k-${Date.now()}-4`,
    });
    const result = await verifyWebhookRequest(req, { secret: SECRET, scope: "test" });
    expect(result.payload).toMatchObject(body);
  });

  it("rejects oversized payloads", async () => {
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
