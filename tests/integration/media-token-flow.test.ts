import { NextRequest } from "next/server";
import { afterAll, beforeAll, describe, expect, vi } from "vitest";
import { closeDb } from "@/db";
import { computeHmacHex } from "@/lib/security";
import { resetEnvCache } from "@/lib/env";
import { POST as callStarted } from "@/app/api/v1/webhooks/voice/call-started/route";
import {
  MediaServer,
  MediaSocketOpen,
  resolveCallFromDb,
  type MediaSocket,
} from "@/lib/voice/media-server";
import { verifyMediaToken } from "@/lib/voice/media-tokens";
import { ensureDbReady, hasTestDatabase, itDb, truncateAll } from "../helpers/db";
import { uniqueTestIp } from "../helpers/http";
import { createBusiness } from "../helpers/fixtures";

// In tests VOICE_WEBHOOK_SECRET is unset → env.webhookSecret falls back here.
const WEBHOOK_SECRET = "dev-webhook-secret";
const MEDIA_SECRET = "p0-1-media-signing-secret";
const MEDIA_URL = "wss://media.example.test";
let keySeq = 0;

function post(body: unknown, path: string): NextRequest {
  const raw = JSON.stringify(body);
  return new NextRequest(
    new Request(`http://localhost${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-webhook-signature": computeHmacHex(WEBHOOK_SECRET, raw),
        "x-idempotency-key": `media-token-${Date.now()}-${keySeq++}`,
        "x-real-ip": uniqueTestIp(),
      },
      body: raw,
    }),
  );
}

class FakeSocket implements MediaSocket {
  readonly readyState = MediaSocketOpen;
  sent: string[] = [];
  closed: { code?: number; reason?: string } | null = null;
  send(data: string | Buffer): void {
    this.sent.push(data.toString());
  }
  close(code?: number, reason?: string): void {
    this.closed = { code, reason };
  }
  last(): Record<string, unknown> {
    return JSON.parse(this.sent.at(-1) as string) as Record<string, unknown>;
  }
}

type CapturedCall = { url: string; body: Record<string, unknown> };

describe("P0-1 media token propagation (call-started → gateway → media start)", () => {
  const runIntegration = hasTestDatabase();
  const savedEnv = { ...process.env };
  const gatewayCalls: CapturedCall[] = [];

  beforeAll(async () => {
    if (!(await ensureDbReady())) return;
    await truncateAll();
    process.env.VOICE_PROVIDER = "generic";
    process.env.VOICE_API_BASE_URL = "https://gateway.example.test";
    process.env.VOICE_API_KEY = "test-gateway-key";
    process.env.VOICE_AUTO_ANSWER = "true";
    process.env.VOICE_MEDIA_PUBLIC_URL = MEDIA_URL;
    process.env.VOICE_MEDIA_TOKEN = MEDIA_SECRET;
    resetEnvCache();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: unknown, init?: { body?: unknown }) => {
        gatewayCalls.push({
          url: String(url),
          body: (init?.body ? JSON.parse(String(init.body)) : {}) as Record<string, unknown>,
        });
        return { ok: true, status: 200, text: async () => "{}" };
      }),
    );
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    for (const key of Object.keys(process.env)) {
      if (!(key in savedEnv)) delete process.env[key];
    }
    Object.assign(process.env, savedEnv);
    resetEnvCache();
    if (runIntegration) {
      await truncateAll().catch(() => undefined);
      await closeDb();
    }
  });

  itDb("issues a per-call token at call-started and the media sidecar accepts it", async () => {
    const business = await createBusiness();
    const externalCallId = `p0-1-${Date.now()}`;

    const res = await callStarted(
      post(
        { business_id: business.id, external_call_id: externalCallId, phone_number: "09123456789" },
        "/api/v1/webhooks/voice/call-started",
      ),
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      ok: boolean;
      callId: string;
      duplicate: boolean;
      media: { attempted: boolean; answered: boolean; streaming: boolean; reason?: string };
    };
    expect(json.ok).toBe(true);
    expect(json.media).toMatchObject({ attempted: true, answered: true, streaming: true });

    const streamStart = gatewayCalls.find((c) => c.url.endsWith("/stream/start"));
    expect(streamStart, "gateway must receive stream/start").toBeDefined();
    expect(streamStart?.body.websocketUrl).toBe(MEDIA_URL);
    const mediaToken = streamStart?.body.mediaToken;
    expect(typeof mediaToken).toBe("string");
    expect(String(mediaToken).startsWith("v1.")).toBe(true);

    // The webhook response must never carry the bearer token.
    expect(JSON.stringify(json)).not.toContain(String(mediaToken).slice(0, 24));

    // The token binds exactly this tenant + call row.
    const claims = verifyMediaToken(String(mediaToken), MEDIA_SECRET);
    expect(claims).toMatchObject({ businessId: business.id, callId: json.callId, externalCallId });

    // The media sidecar accepts the token with NO asserted ids (binding comes
    // from the token) and resolves the real call row from the database.
    const socket = new FakeSocket();
    const server = new MediaServer({
      token: MEDIA_SECRET,
      resolveCall: resolveCallFromDb,
      sessionHooks: { save: async () => undefined, remove: async () => undefined },
    });
    const session = server.accept(socket);
    await session.handleMessage(JSON.stringify({ type: "start", token: mediaToken }));
    expect(socket.last()).toMatchObject({ type: "started" });

    // Same token, different asserted call → loud mismatch, never coercion.
    const socket2 = new FakeSocket();
    const session2 = server.accept(socket2);
    await session2.handleMessage(
      JSON.stringify({ type: "start", token: mediaToken, callId: "00000000-0000-0000-0000-000000000000" }),
    );
    expect(socket2.last()).toMatchObject({ type: "error", code: "CALL_MISMATCH" });
  });

  itDb("reports honestly when the media signing secret is missing", async () => {
    process.env.VOICE_MEDIA_TOKEN = "";
    resetEnvCache();
    try {
      const business = await createBusiness();
      const res = await callStarted(
        post(
          {
            business_id: business.id,
            external_call_id: `p0-1-nokey-${Date.now()}`,
            phone_number: "09123456789",
          },
          "/api/v1/webhooks/voice/call-started",
        ),
      );
      expect(res.status).toBe(200);
      const json = (await res.json()) as { media: { streaming: boolean; reason?: string } };
      // Fail closed: answered but no stream the sidecar would accept.
      expect(json.media).toMatchObject({ streaming: false, reason: "media_token_not_configured" });
    } finally {
      process.env.VOICE_MEDIA_TOKEN = MEDIA_SECRET;
      resetEnvCache();
    }
  });
});
