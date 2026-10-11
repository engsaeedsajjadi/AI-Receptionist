import { beforeEach, describe, expect, it, vi } from "vitest";
import { MediaServer, MediaSocketOpen, type CallResolution, type MediaSocket } from "@/lib/voice/media-server";
import type { VoiceTurnInput, VoiceTurnResult } from "@/lib/voice/turn";
import { acceptMediaSessionToken } from "../helpers/media";

const TOKEN = "media-secret";
const RESOLUTION: CallResolution = { businessId: "biz-1", callId: "call-1", agentId: "agent-1" };

class FakeSocket implements MediaSocket {
  readyState = MediaSocketOpen;
  sent: string[] = [];
  closed: { code?: number; reason?: string } | null = null;
  send(data: string | Buffer): void {
    this.sent.push(data.toString());
  }
  close(code?: number, reason?: string): void {
    this.closed = { code, reason };
  }
  envelopes(): Array<Record<string, unknown>> {
    return this.sent.map((raw) => JSON.parse(raw) as Record<string, unknown>);
  }
  types(): string[] {
    return this.envelopes().map((envelope) => String(envelope.type ?? envelope.event));
  }
  last(): Record<string, unknown> {
    return this.envelopes().at(-1) ?? {};
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
    audio: Buffer.alloc(320, 3),
    audioMimeType: "audio/pcm",
    audioUrl: null,
    audioStored: false,
    agentId: "agent-1",
    toolCalls: [],
    usage: { sttMinutes: 0.01, ttsCharacters: 10, llmInputTokens: 5, llmOutputTokens: 5 },
    latencyMs: { total: 100, stt: 10, agent: 50, tts: 30, store: 10 },
    ...overrides,
  };
}

function setup(opts?: {
  turnRunner?: (input: VoiceTurnInput) => Promise<VoiceTurnResult>;
  resolveCall?: (businessId: string, callId?: string, externalCallId?: string) => Promise<CallResolution | null>;
  idleTimeoutMs?: number;
  maxConcurrentSessions?: number;
  maxBufferBytes?: number;
  maxFrameBytes?: number;
  onSessionClosed?: () => void;
  allowStaticToken?: boolean;
  onHandoffRequest?: (context: { businessId: string; callId: string; digits: string }) => Promise<{ destination?: string | null } | void>;
  vadEnabled?: boolean;
}) {
  const socket = new FakeSocket();
  const server = new MediaServer({
    token: TOKEN,
    turnRunner: opts?.turnRunner ?? (async () => cannedTurn()),
    resolveCall: opts?.resolveCall ?? (async () => RESOLUTION),
    vadEnabled: opts?.vadEnabled ?? false,
    allowStaticToken: opts?.allowStaticToken ?? true,
    maxConcurrentSessions: opts?.maxConcurrentSessions ?? 10,
    idleTimeoutMs: opts?.idleTimeoutMs,
    maxBufferBytes: opts?.maxBufferBytes,
    maxFrameBytes: opts?.maxFrameBytes,
    onSessionClosed: opts?.onSessionClosed,
    onHandoffRequest: opts?.onHandoffRequest,
  });
  const session = server.accept(socket);
  const token = acceptMediaSessionToken(TOKEN, { businessId: "biz-1", callId: "call-1", externalCallId: "CA1" });
  return { socket, server, session, token };
}

async function start(session: ReturnType<typeof setup>["session"], token: string, overrides: Record<string, unknown> = {}) {
  await session.handleMessage(
    JSON.stringify({ type: "start", token, businessId: "biz-1", callId: "call-1", externalCallId: "CA1", ...overrides }),
  );
}

beforeEach(() => {
  vi.useRealTimers();
});

describe("media session protocol rejections", () => {
  it("rejects every malformed start frame before any audio is accepted", async () => {
    const { session, socket, token } = setup();

    await session.handleMessage(JSON.stringify({ type: "start", token, callId: "call-1" }));
    expect(socket.last()).toMatchObject({ code: "INVALID_START" });

    const second = setup();
    await start(second.session, second.token);
    await start(second.session, second.token);
    expect(second.socket.last()).toMatchObject({ code: "ALREADY_STARTED" });

    const codec = setup();
    await start(codec.session, codec.token, { codec: "mp3" });
    expect(codec.socket.last()).toMatchObject({ code: "INVALID_START" });

    for (const sampleRate of [4000, 96000, 8000.5]) {
      const rates = setup();
      await start(rates.session, rates.token, { sampleRate });
      expect(rates.socket.last()).toMatchObject({ code: "INVALID_START" });
    }

    const valid = setup();
    await start(valid.session, valid.token, { sampleRate: 16000, codec: "pcm_s16le" });
    expect(valid.session.state).toBe("LISTENING");
    expect(valid.socket.last()).toMatchObject({ type: "started", codec: "pcm_s16le", sampleRate: 16000 });
  });

  it("refuses an unknown call and a token minted for another call", async () => {
    const unknown = setup({ resolveCall: async () => null });
    await start(unknown.session, unknown.token);
    expect(unknown.socket.last()).toMatchObject({ code: "CALL_NOT_FOUND" });
    expect(unknown.socket.closed).not.toBeNull();

    const foreign = setup({ allowStaticToken: false });
    const otherToken = acceptMediaSessionToken(TOKEN, { businessId: "biz-1", callId: "call-other" });
    await start(foreign.session, otherToken);
    expect(foreign.socket.last()).toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("requires a started session, valid JSON and known frame types", async () => {
    const { session, socket, token } = setup();
    await session.handleMessage(Buffer.from("audio-before-start"));
    expect(socket.last()).toMatchObject({ code: "NOT_STARTED" });
    await session.handleMessage("not-json");
    expect(socket.last()).toMatchObject({ code: "INVALID_JSON" });
    await session.handleMessage(JSON.stringify({ type: "unknown-type" }));
    expect(socket.last()).toMatchObject({ code: "NOT_STARTED" });
    await start(session, token);
    await session.handleMessage(JSON.stringify({ type: "unknown-type" }));
    expect(socket.last()).toMatchObject({ code: "UNKNOWN_MESSAGE" });
    await session.handleMessage(JSON.stringify({}));
    expect(socket.last()).toMatchObject({ code: "UNKNOWN_MESSAGE" });
  });

  it("validates utterance sequence numbers, event ids and buffered audio", async () => {
    const { session, socket, token } = setup();
    await start(session, token);
    await session.handleMessage(JSON.stringify({ type: "utterance-end", eventId: "e1", seq: -1 }));
    expect(socket.last()).toMatchObject({ code: "INVALID_MESSAGE" });
    await session.handleMessage(JSON.stringify({ type: "utterance-end", eventId: "e1", seq: 1.5 }));
    expect(socket.last()).toMatchObject({ code: "INVALID_MESSAGE" });
    await session.handleMessage(JSON.stringify({ type: "utterance-end", seq: 1 }));
    expect(socket.last()).toMatchObject({ code: "INVALID_MESSAGE" });
    await session.handleMessage(JSON.stringify({ type: "utterance-end", eventId: "e1", seq: 5 }));
    expect(socket.last()).toMatchObject({ code: "EMPTY_UTTERANCE" });
    // A stale sequence number is acknowledged as an out-of-order duplicate.
    await session.handleMessage(JSON.stringify({ type: "utterance-end", eventId: "e2", seq: 5 }));
    expect(socket.last()).toMatchObject({ type: "turn-complete", duplicate: true, reason: "out_of_order" });

    const text = setup();
    await start(text.session, text.token);
    await text.session.handleMessage(JSON.stringify({ type: "text", transcript: "   ", eventId: "e1" }));
    expect(text.socket.last()).toMatchObject({ code: "INVALID_MESSAGE" });
    await text.session.handleMessage(JSON.stringify({ type: "text", transcript: "سلام" }));
    expect(text.socket.last()).toMatchObject({ code: "INVALID_MESSAGE" });
    await text.session.handleMessage(JSON.stringify({ type: "text", transcript: "سلام", eventId: "e1" }));
    expect(text.socket.types()).toContain("agent-audio");
  });

  it("caps frames and the utterance buffer, clearing audio instead of truncating silently", async () => {
    const frames = setup({ maxFrameBytes: 64, maxBufferBytes: 128 });
    await start(frames.session, frames.token);
    await frames.session.handleMessage(Buffer.alloc(65));
    expect(frames.socket.last()).toMatchObject({ code: "FRAME_TOO_LARGE" });

    const buffer = setup({ maxFrameBytes: 1024, maxBufferBytes: 100 });
    await start(buffer.session, buffer.token);
    await buffer.session.handleMessage(Buffer.alloc(60));
    await buffer.session.handleMessage(Buffer.alloc(60));
    expect(buffer.socket.last()).toMatchObject({ code: "BUFFER_OVERFLOW" });
    // The cleared buffer means the next utterance has no audio.
    await buffer.session.handleMessage(JSON.stringify({ type: "utterance-end", eventId: "e1" }));
    expect(buffer.socket.last()).toMatchObject({ code: "EMPTY_UTTERANCE" });
  });

  it("answers ping and stops the session once", async () => {
    const { session, socket, token } = setup();
    await start(session, token);
    await session.handleMessage(JSON.stringify({ type: "ping" }));
    expect(socket.last()).toMatchObject({ type: "pong" });
    await session.handleMessage(JSON.stringify({ type: "stop" }));
    expect(socket.types()).toContain("stopped");
    expect(socket.closed).toMatchObject({ code: 1000, reason: "stop" });
    const sentBefore = socket.sent.length;
    await session.handleMessage(JSON.stringify({ type: "ping" }));
    expect(socket.sent.length).toBe(sentBefore); // a closed session is inert
  });
});

describe("media session turn lifecycle", () => {
  it("reports a failed turn honestly and stays usable afterwards", async () => {
    let attempt = 0;
    const { session, socket, token } = setup({
      turnRunner: async () => {
        attempt += 1;
        if (attempt === 1) throw new Error("provider exploded");
        return cannedTurn();
      },
    });
    await start(session, token);
    await session.handleMessage(JSON.stringify({ type: "text", transcript: "سلام", eventId: "e1" }));
    const failure = socket.envelopes().find((envelope) => envelope.code === "TURN_FAILED");
    expect(failure).toMatchObject({ message: "provider exploded" });
    expect(session.state).toBe("LISTENING");
    await session.handleMessage(JSON.stringify({ type: "text", transcript: "دوباره", eventId: "e2" }));
    expect(socket.types()).toContain("agent-audio");
  });

  it("queues an utterance that arrives while a turn is in flight and runs it next", async () => {
    const seen: string[] = [];
    let release: () => void = () => undefined;
    const { session, socket, token } = setup({
      turnRunner: async (input) => {
        seen.push(String(input.eventId));
        if (seen.length === 1) await new Promise<void>((resolve) => (release = resolve));
        return cannedTurn();
      },
    });
    await start(session, token);
    const first = session.handleMessage(JSON.stringify({ type: "text", transcript: "اول", eventId: "e1" }));
    await new Promise((resolve) => setImmediate(resolve));
    // Second utterance arrives as audio + utterance-end while the first is running.
    await session.handleMessage(Buffer.alloc(160, 9));
    await session.handleMessage(JSON.stringify({ type: "utterance-end", eventId: "e2", seq: 1 }));
    expect(socket.types()).toContain("barge-in-ack");
    release();
    await first;
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    expect(seen).toEqual(["e1", "e2"]);
  });

  it("supersedes a turn that finishes after barge-in without emitting audio", async () => {
    let release: () => void = () => undefined;
    const { session, socket, token } = setup({
      turnRunner: async () => {
        await new Promise<void>((resolve) => (release = resolve));
        return cannedTurn();
      },
    });
    await start(session, token);
    const pending = session.handleMessage(JSON.stringify({ type: "text", transcript: "سلام", eventId: "e1" }));
    await new Promise((resolve) => setImmediate(resolve));
    await session.handleMessage(JSON.stringify({ type: "barge-in" }));
    release();
    await pending;
    expect(socket.types()).toContain("turn-superseded");
    expect(socket.envelopes().filter((envelope) => envelope.type === "agent-audio")).toHaveLength(0);
    expect(session.state).toBe("LISTENING");
  });

  it("runs a turn from raw audio when server-side VAD detects an utterance", async () => {
    const { session, socket, token } = setup({ vadEnabled: true, maxBufferBytes: 4 * 1024 * 1024 });
    await start(session, token, { sampleRate: 8000, codec: "pcm_s16le" });
    const loud = Buffer.alloc(320);
    for (let index = 0; index + 1 < loud.length; index += 2) loud.writeInt16LE(index % 4 === 0 ? 20000 : -20000, index);
    for (let index = 0; index < 40; index++) await session.handleMessage(loud);
    for (let index = 0; index < 60; index++) await session.handleMessage(Buffer.alloc(320));
    expect(socket.types()).toContain("agent-audio");
  });
});

describe("media server lifecycle and capacity", () => {
  it("refuses new sessions at capacity without disturbing the active ones", async () => {
    let closed = 0;
    const server = new MediaServer({
      token: TOKEN,
      turnRunner: async () => cannedTurn(),
      resolveCall: async () => RESOLUTION,
      allowStaticToken: true,
      maxConcurrentSessions: 1,
      onSessionClosed: () => {
        closed += 1;
      },
    });
    const first = new FakeSocket();
    server.accept(first);
    expect(server.activeSessions).toBe(1);
    const rejected = new FakeSocket();
    server.accept(rejected);
    expect(rejected.closed).toMatchObject({ code: 4429, reason: "capacity" });
    expect(String(rejected.sent[0])).toContain("CAPACITY_EXCEEDED");
    expect(server.activeSessions).toBe(1); // the squeezed session is not counted

    const session = server.accept(new FakeSocket());
    await session.handleMessage(JSON.stringify({ type: "start", token: TOKEN, businessId: "biz-1", callId: "call-1" }));
    // Closing twice must notify exactly once.
    await session.handleMessage(JSON.stringify({ type: "stop" }));
    session.handleClose();
    expect(closed).toBeGreaterThanOrEqual(1);
    expect(server.activeSessions).toBeLessThanOrEqual(1);
  });

  it("closes an idle session with an explicit timeout code", async () => {
    vi.useFakeTimers();
    try {
      const { session, socket, token } = setup({ idleTimeoutMs: 25 });
      await start(session, token);
      await vi.advanceTimersByTimeAsync(40);
      const timeout = socket.envelopes().find((envelope) => envelope.code === "IDLE_TIMEOUT");
      expect(timeout).toBeTruthy();
      expect(socket.closed).not.toBeNull();
      session.handleClose();
      await vi.advanceTimersByTimeAsync(40);
      expect(socket.envelopes().filter((envelope) => envelope.code === "IDLE_TIMEOUT")).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("Twilio bridge edge cases", () => {
  async function startTwilio() {
    const ctx = setup();
    await ctx.session.handleMessage(
      JSON.stringify({
        event: "start",
        streamSid: "MZ1",
        start: { streamSid: "MZ1", callSid: "CA1", customParameters: { token: ctx.token, businessId: "biz-1", callId: "call-1" } },
      }),
    );
    return ctx;
  }

  it("ignores events the bridge does not translate and never emits app frames", async () => {
    const { session, socket } = await startTwilio();
    const before = socket.sent.length;
    for (const envelope of [{ event: "connected" }, { event: "mark", mark: { name: "x" } }, { event: "media", media: {} }, {}, "string-envelope", null]) {
      await session.handleMessage(JSON.stringify(envelope));
    }
    expect(socket.sent.length).toBe(before);
  });

  it("keeps DTMF diagnostics local, accumulates digits and asks for a human on 0", async () => {
    const calls: string[] = [];
    const ctx = await startTwilio();
    const withHandoff = setup({
      onHandoffRequest: async ({ digits }) => {
        calls.push(digits);
        return { destination: "+989120000000" };
      },
    });
    await withHandoff.session.handleMessage(
      JSON.stringify({
        event: "start",
        streamSid: "MZ2",
        start: { streamSid: "MZ2", callSid: "CA1", customParameters: { token: withHandoff.token, businessId: "biz-1", callId: "call-1" } },
      }),
    );
    await withHandoff.session.handleMessage(JSON.stringify({ event: "dtmf", dtmf: { digit: "1" } }));
    await withHandoff.session.handleMessage(JSON.stringify({ event: "dtmf", dtmf: { digit: "0" } }));
    await new Promise((resolve) => setImmediate(resolve));
    expect(calls).toEqual(["10"]);
    // An invalid digit never reaches the handoff path.
    await withHandoff.session.handleMessage(JSON.stringify({ event: "dtmf", dtmf: { digit: "Z" } }));
    await new Promise((resolve) => setImmediate(resolve));
    expect(calls).toEqual(["10"]);
    // DTMF before any resolution is dropped without throwing.
    await ctx.session.handleMessage(JSON.stringify({ event: "dtmf", dtmf: { digit: "0" } }));
  });

  it("reports a failing handoff request without killing the call", async () => {
    const ctx = setup({ onHandoffRequest: async () => { throw new Error("transfer backend down"); } });
    await ctx.session.handleMessage(
      JSON.stringify({
        event: "start",
        streamSid: "MZ3",
        start: { streamSid: "MZ3", callSid: "CA1", customParameters: { token: ctx.token, businessId: "biz-1", callId: "call-1" } },
      }),
    );
    await ctx.session.handleMessage(JSON.stringify({ event: "dtmf", dtmf: { digit: "0" } }));
    await new Promise((resolve) => setImmediate(resolve));
    expect(ctx.session.state).toBe("LISTENING");
  });

  it("never sends audio it cannot transcode and logs the reason instead", async () => {
    const ctx = setup({
      turnRunner: async () => cannedTurn({ audio: Buffer.alloc(0), audioMimeType: "audio/mpeg", audioUrl: "https://cdn.example/audio.mp3" }),
    });
    await ctx.session.handleMessage(
      JSON.stringify({
        event: "start",
        streamSid: "MZ4",
        start: { streamSid: "MZ4", callSid: "CA1", customParameters: { token: ctx.token, businessId: "biz-1", callId: "call-1" } },
      }),
    );
    await ctx.session.handleMessage(JSON.stringify({ event: "media", media: { payload: Buffer.alloc(160, 1).toString("base64") } }));
    await ctx.session.handleMessage(JSON.stringify({ event: "stop" }));
    // Only Twilio protocol frames are allowed on the wire.
    for (const envelope of ctx.socket.envelopes()) {
      if (envelope.event !== undefined) expect(["media", "mark", "clear"]).toContain(envelope.event);
    }
    expect(ctx.socket.closed).toMatchObject({ reason: "twilio-stop" });
  });
});
