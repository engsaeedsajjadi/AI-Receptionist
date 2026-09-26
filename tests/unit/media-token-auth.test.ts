import { describe, expect, it } from "vitest";
import {
  MediaServer,
  MediaSocketOpen,
  type CallResolution,
  type MediaSocket,
} from "@/lib/voice/media-server";
import { issueMediaToken } from "@/lib/voice/media-tokens";
import type { CalledNumberRoute } from "@/lib/services/phone-routing";

const SECRET = "media-secret";
const STATIC = "media-secret";

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
  messages(): Array<Record<string, unknown>> {
    return this.sent.map((s) => JSON.parse(s) as Record<string, unknown>);
  }
  last(): Record<string, unknown> {
    return this.messages().at(-1) as Record<string, unknown>;
  }
}

function setup(opts?: {
  resolveCall?: (businessId: string, callId?: string, externalCallId?: string) => Promise<CallResolution | null>;
  routeCall?: (calledNumber: string) => Promise<CalledNumberRoute>;
}) {
  const socket = new FakeSocket();
  const server = new MediaServer({
    token: SECRET,
    turnRunner: async () => {
      throw new Error("turnRunner must not run in auth tests");
    },
    resolveCall:
      opts?.resolveCall ??
      (async (businessId, callId) => ({ businessId, callId: callId ?? "resolved", agentId: null })),
    routeCall: opts?.routeCall,
    sessionHooks: { save: async () => undefined, remove: async () => undefined },
  });
  const session = server.accept(socket);
  return { socket, session };
}

function mint(overrides?: { businessId?: string; callId?: string; externalCallId?: string | null; ttlSeconds?: number; secret?: string; nowMs?: number }) {
  return issueMediaToken({
    businessId: overrides?.businessId ?? "biz-1",
    callId: overrides?.callId ?? "call-1",
    externalCallId: overrides?.externalCallId ?? "ext-1",
    ttlSeconds: overrides?.ttlSeconds ?? 900,
    secret: overrides?.secret ?? SECRET,
    nowMs: overrides?.nowMs,
  });
}

describe("media start with per-call tokens", () => {
  it("starts a bare frame: tenant+call come from the token, not the gateway", async () => {
    const seen: Array<{ businessId: string; callId?: string; externalCallId?: string }> = [];
    const { socket, session } = setup({
      resolveCall: async (businessId, callId, externalCallId) => {
        seen.push({ businessId, callId, externalCallId });
        return { businessId, callId: callId ?? "?", agentId: null };
      },
    });
    const token = mint();
    await session.handleMessage(JSON.stringify({ type: "start", token }));
    expect(socket.last()).toMatchObject({ type: "started" });
    expect(seen).toEqual([{ businessId: "biz-1", callId: "call-1", externalCallId: "ext-1" }]);
  });

  it("accepts a token alongside agreeing businessId/callId", async () => {
    const { socket, session } = setup();
    await session.handleMessage(
      JSON.stringify({ type: "start", token: mint(), businessId: "biz-1", callId: "call-1" }),
    );
    expect(socket.last()).toMatchObject({ type: "started" });
  });

  it("fails loudly (CALL_MISMATCH) when the gateway asserts another callId", async () => {
    const { socket, session } = setup();
    const token = mint({ callId: "call-1" });
    await session.handleMessage(JSON.stringify({ type: "start", token, callId: "call-2" }));
    expect(socket.last()).toMatchObject({ type: "error", code: "CALL_MISMATCH" });
    expect(socket.closed).not.toBeNull();
  });

  it("fails loudly (TENANT_MISMATCH) when the gateway asserts another businessId", async () => {
    const { socket, session } = setup();
    await session.handleMessage(JSON.stringify({ type: "start", token: mint(), businessId: "biz-2" }));
    expect(socket.last()).toMatchObject({ type: "error", code: "TENANT_MISMATCH" });
    expect(socket.closed).not.toBeNull();
  });

  it("fails loudly (TENANT_MISMATCH) when called-number routes to another tenant", async () => {
    const { socket, session } = setup({
      routeCall: async () => ({ ok: true, businessId: "biz-2", matchedNumber: "+982112345678", via: "phone" }),
    });
    await session.handleMessage(JSON.stringify({ type: "start", token: mint(), calledNumber: "+982112345678" }));
    expect(socket.last()).toMatchObject({ type: "error", code: "TENANT_MISMATCH" });
    expect(socket.closed).not.toBeNull();
  });

  it("rejects expired per-call tokens", async () => {
    const { socket, session } = setup();
    const token = mint({ ttlSeconds: 60, nowMs: 1_000_000 });
    await session.handleMessage(JSON.stringify({ type: "start", token }));
    expect(socket.last()).toMatchObject({ type: "error", code: "UNAUTHORIZED" });
    expect(String(socket.last().message)).toContain("EXPIRED");
    expect(socket.closed).toMatchObject({ code: 4401 });
  });

  it("rejects tampered per-call tokens", async () => {
    const { socket, session } = setup();
    const token = `${mint()}tampered`;
    await session.handleMessage(JSON.stringify({ type: "start", token }));
    expect(socket.last()).toMatchObject({ type: "error", code: "UNAUTHORIZED" });
    expect(socket.closed).toMatchObject({ code: 4401 });
  });

  it("still accepts the legacy static token (gateway upgrade window)", async () => {
    const seen: Array<{ businessId: string; callId?: string }> = [];
    const { socket, session } = setup({
      resolveCall: async (businessId, callId) => {
        seen.push({ businessId, callId });
        return { businessId, callId: callId ?? "?", agentId: null };
      },
    });
    await session.handleMessage(
      JSON.stringify({ type: "start", token: STATIC, businessId: "biz-9", callId: "call-9" }),
    );
    expect(socket.last()).toMatchObject({ type: "started" });
    expect(seen).toEqual([{ businessId: "biz-9", callId: "call-9" }]);
  });

  it("rejects wrong static tokens", async () => {
    const { socket, session } = setup();
    await session.handleMessage(JSON.stringify({ type: "start", token: "wrong", businessId: "biz-1" }));
    expect(socket.last()).toMatchObject({ type: "error", code: "UNAUTHORIZED" });
    expect(socket.closed).toMatchObject({ code: 4401 });
  });

  it("never echoes the presented token in error frames", async () => {
    const { socket, session } = setup();
    const token = mint();
    await session.handleMessage(JSON.stringify({ type: "start", token: `${token}tampered` }));
    for (const frame of socket.sent) {
      expect(frame).not.toContain(token.slice(0, 24));
    }
  });
});
