import { describe, expect, it } from "vitest";
import {
  MediaServer,
  MediaSocketOpen,
  type CallResolution,
  type MediaSocket,
} from "@/lib/voice/media-server";
import type { VoiceTurnInput, VoiceTurnResult } from "@/lib/voice/turn";
import type { CalledNumberRoute } from "@/lib/services/phone-routing";

const TOKEN = "media-secret";

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

function cannedTurn(overrides?: Partial<VoiceTurnResult>): VoiceTurnResult {
  return {
    duplicate: false,
    heard: true,
    transcript: "سلام",
    sttLanguage: "fa",
    sttDurationSeconds: 1,
    reply: "درود بر شما",
    spokenText: "درود بر شما",
    audio: Buffer.from("FAKEAUDIO"),
    audioMimeType: "audio/mpeg",
    audioUrl: "https://cdn.example/reply.mp3",
    audioStored: true,
    agentId: "agent-1",
    toolCalls: [],
    usage: { sttMinutes: 0.01, ttsCharacters: 10, llmInputTokens: 5, llmOutputTokens: 5 },
    latencyMs: { total: 100, stt: 10, agent: 50, tts: 30, store: 10 },
    ...overrides,
  };
}

const RESOLUTION: CallResolution = { businessId: "biz-1", callId: "call-1", agentId: "agent-1" };

function setup(opts?: {
  turnRunner?: (input: VoiceTurnInput) => Promise<VoiceTurnResult>;
  resolveCall?: (businessId: string, callId?: string, externalCallId?: string) => Promise<CallResolution | null>;
  routeCall?: (calledNumber: string) => Promise<CalledNumberRoute>;
  idleTimeoutMs?: number;
  maxBufferBytes?: number;
}) {
  const socket = new FakeSocket();
  const server = new MediaServer({
    token: TOKEN,
    turnRunner: opts?.turnRunner ?? (async () => cannedTurn()),
    resolveCall: opts?.resolveCall ?? (async () => RESOLUTION),
    routeCall: opts?.routeCall,
    idleTimeoutMs: opts?.idleTimeoutMs,
    maxBufferBytes: opts?.maxBufferBytes,
  });
  const session = server.accept(socket);
  const start = (extra?: Record<string, unknown>) =>
    session.handleMessage(JSON.stringify({ type: "start", token: TOKEN, businessId: "biz-1", callId: "call-1", ...extra }));
  return { socket, session, start };
}

describe("media server protocol", () => {
  it("rejects unauthenticated start frames", async () => {
    const { socket, session } = setup();
    await session.handleMessage(JSON.stringify({ type: "start", token: "wrong", businessId: "biz-1" }));
    expect(socket.last()).toMatchObject({ type: "error", code: "UNAUTHORIZED" });
    expect(socket.closed).toMatchObject({ code: 4401 });
  });

  it("rejects start for unknown calls", async () => {
    const { socket, session } = setup({ resolveCall: async () => null });
    await session.handleMessage(JSON.stringify({ type: "start", token: TOKEN, businessId: "biz-1", callId: "nope" }));
    expect(socket.last()).toMatchObject({ type: "error", code: "CALL_NOT_FOUND" });
    expect(socket.closed).not.toBeNull();
  });

  it("requires start before anything else", async () => {
    const { socket, session } = setup();
    await session.handleMessage(JSON.stringify({ type: "ping" }));
    expect(socket.last()).toMatchObject({ type: "error", code: "NOT_STARTED" });
    await session.handleMessage(Buffer.from("audio"));
    expect(socket.last()).toMatchObject({ type: "error", code: "NOT_STARTED" });
  });

  it("runs an audio utterance end-to-end", async () => {
    const seen: VoiceTurnInput[] = [];
    const { socket, session, start } = setup({
      turnRunner: async (input) => {
        seen.push(input);
        return cannedTurn();
      },
    });
    await start();
    expect(socket.last()).toMatchObject({ type: "started" });
    await session.handleMessage(Buffer.from("chunk-1-"));
    await session.handleMessage(Buffer.from("chunk-2"));
    await session.handleMessage(JSON.stringify({ type: "utterance-end", eventId: "e1" }));

    expect(seen).toHaveLength(1);
    expect(seen[0].audio?.toString()).toBe("chunk-1-chunk-2");
    expect(seen[0]).toMatchObject({ businessId: "biz-1", callId: "call-1", eventId: "e1", actor: "media-server" });

    const types = socket.messages().map((m) => m.type);
    expect(types).toContain("agent-audio");
    expect(types).toContain("turn-complete");
    const audio = socket.messages().find((m) => m.type === "agent-audio") as Record<string, unknown>;
    expect(audio).toMatchObject({ eventId: "e1", mimeType: "audio/mpeg", reply: "درود بر شما" });
    expect(Buffer.from(audio.audio as string, "base64").toString()).toBe("FAKEAUDIO");
  });

  it("supports the text topology (gateway-side STT)", async () => {
    const seen: VoiceTurnInput[] = [];
    const { socket, session, start } = setup({
      turnRunner: async (input) => {
        seen.push(input);
        return cannedTurn();
      },
    });
    await start();
    await session.handleMessage(JSON.stringify({ type: "text", transcript: "ساعت کاری؟", eventId: "e2" }));
    expect(seen).toHaveLength(1);
    expect(seen[0].transcript).toBe("ساعت کاری؟");
    expect(seen[0].audio).toBeUndefined();
    expect(socket.messages().some((m) => m.type === "agent-audio")).toBe(true);
  });

  it("forwards duplicates and no-speech honestly", async () => {
    const { socket, session, start } = setup({
      turnRunner: async () => cannedTurn({ duplicate: true, audio: null }),
    });
    await start();
    await session.handleMessage(JSON.stringify({ type: "text", transcript: "x", eventId: "e3" }));
    expect(socket.last()).toMatchObject({ type: "turn-complete", eventId: "e3", duplicate: true });
    expect(socket.messages().some((m) => m.type === "agent-audio")).toBe(false);
  });

  it("barge-in supersedes the in-flight turn", async () => {
    let resolveTurn!: (r: VoiceTurnResult) => void;
    const { socket, session, start } = setup({
      turnRunner: () => new Promise<VoiceTurnResult>((res) => (resolveTurn = res)),
    });
    await start();
    const pending = session.handleMessage(JSON.stringify({ type: "text", transcript: "سلام", eventId: "e4" }));
    await session.handleMessage(JSON.stringify({ type: "barge-in" }));
    resolveTurn(cannedTurn());
    await pending;

    const types = socket.messages().map((m) => m.type);
    expect(types).toContain("barge-in-ack");
    expect(types).toContain("turn-superseded");
    expect(types).not.toContain("agent-audio");
  });

  it("rejects a second utterance while one is in flight", async () => {
    let resolveTurn!: (r: VoiceTurnResult) => void;
    const { socket, session, start } = setup({
      turnRunner: () => new Promise<VoiceTurnResult>((res) => (resolveTurn = res)),
    });
    await start();
    const pending = session.handleMessage(JSON.stringify({ type: "text", transcript: "اول", eventId: "e5" }));
    await session.handleMessage(JSON.stringify({ type: "text", transcript: "دوم", eventId: "e6" }));
    expect(socket.last()).toMatchObject({ type: "error", code: "TURN_IN_PROGRESS" });
    expect(socket.closed).toBeNull(); // connection stays open
    resolveTurn(cannedTurn());
    await pending;
  });

  it("caps the utterance buffer", async () => {
    const { socket, session, start } = setup({ maxBufferBytes: 8 });
    await start();
    await session.handleMessage(Buffer.from("12345678"));
    await session.handleMessage(Buffer.from("overflow"));
    expect(socket.last()).toMatchObject({ type: "error", code: "BUFFER_OVERFLOW" });
    await session.handleMessage(JSON.stringify({ type: "utterance-end", eventId: "e7" }));
    expect(socket.last()).toMatchObject({ type: "error", code: "EMPTY_UTTERANCE" });
  });

  it("handles ping/stop/unknown gracefully", async () => {
    const { socket, session, start } = setup();
    await start();
    await session.handleMessage(JSON.stringify({ type: "ping" }));
    expect(socket.last()).toMatchObject({ type: "pong" });
    await session.handleMessage(JSON.stringify({ type: "nope" }));
    expect(socket.last()).toMatchObject({ type: "error", code: "UNKNOWN_MESSAGE" });
    expect(socket.closed).toBeNull();
    await session.handleMessage(JSON.stringify({ type: "stop" }));
    expect(socket.last()).toMatchObject({ type: "stopped" });
    expect(socket.closed).toMatchObject({ code: 1000 });
  });
});

describe("media session tenant routing", () => {
  const routed = (businessId: string): CalledNumberRoute => ({
    ok: true,
    businessId,
    matchedNumber: "02122334455",
    via: "voice_number",
  });

  it("starts with calledNumber only (routes the tenant)", async () => {
    const seen: string[] = [];
    const { socket, session } = setup({
      routeCall: async () => routed("biz-9"),
      resolveCall: async (businessId) => {
        seen.push(businessId);
        return { businessId, callId: "call-9", agentId: null };
      },
    });
    await session.handleMessage(
      JSON.stringify({ type: "start", token: TOKEN, calledNumber: "+98 21 2233 4455", callId: "call-9" }),
    );
    expect(socket.last()).toMatchObject({ type: "started" });
    expect(seen).toEqual(["biz-9"]);
  });

  it("rejects businessId that disagrees with the route", async () => {
    const { socket, session } = setup({ routeCall: async () => routed("biz-9") });
    await session.handleMessage(
      JSON.stringify({ type: "start", token: TOKEN, businessId: "biz-EVIL", calledNumber: "02122334455" }),
    );
    expect(socket.last()).toMatchObject({ type: "error", code: "TENANT_MISMATCH" });
    expect(socket.closed).not.toBeNull();
  });

  it("rejects unroutable numbers fail-closed", async () => {
    const { socket, session } = setup({
      routeCall: async () => ({ ok: false, reason: "UNROUTABLE_NUMBER", normalized: "02100000000" }),
    });
    await session.handleMessage(
      JSON.stringify({ type: "start", token: TOKEN, calledNumber: "02100000000" }),
    );
    expect(socket.last()).toMatchObject({ type: "error", code: "UNROUTABLE_NUMBER" });
    expect(socket.closed).not.toBeNull();
  });

  it("requires businessId or calledNumber", async () => {
    const { socket, session } = setup();
    await session.handleMessage(JSON.stringify({ type: "start", token: TOKEN, callId: "c" }));
    expect(socket.last()).toMatchObject({ type: "error", code: "INVALID_START" });
    expect(socket.closed).not.toBeNull();
  });
});
