import { describe, expect, it } from "vitest";
import {
  MediaServer,
  MediaSocketOpen,
  type CallResolution,
  type MediaSocket,
} from "@/lib/voice/media-server";
import type { VoiceTurnInput, VoiceTurnResult } from "@/lib/voice/turn";
import type { CalledNumberRoute } from "@/lib/services/phone-routing";
import type { SessionHooks } from "@/lib/voice/media-server";
import type { SpeakInput, SpeakResult } from "@/lib/voice/speak";
import type { VadConfig } from "@/lib/audio/vad";

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
  maxFrameBytes?: number;
  sessionHooks?: SessionHooks;
  speakRunner?: (input: SpeakInput) => Promise<SpeakResult>;
  silenceTimeoutMs?: number | null;
  maxReprompts?: number;
  vadConfig?: VadConfig;
  markSilenceGiveup?: (businessId: string, callId: string) => Promise<void>;
}) {
  const socket = new FakeSocket();
  const server = new MediaServer({
    token: TOKEN,
    turnRunner: opts?.turnRunner ?? (async () => cannedTurn()),
    resolveCall: opts?.resolveCall ?? (async () => RESOLUTION),
    routeCall: opts?.routeCall,
    sessionHooks: opts?.sessionHooks,
    speakRunner: opts?.speakRunner,
    silenceTimeoutMs: opts?.silenceTimeoutMs,
    maxReprompts: opts?.maxReprompts,
    maxFrameBytes: opts?.maxFrameBytes,
    vadConfig: opts?.vadConfig,
    markSilenceGiveup: opts?.markSilenceGiveup,
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

describe("media partial transcripts", () => {
  it("acks partials without running the agent/tools", async () => {
    let turns = 0;
    const { socket, session, start } = setup({ turnRunner: async () => { turns++; return cannedTurn(); } });
    await start();
    await session.handleMessage(
      JSON.stringify({ type: "text", transcript: "من دنبال یه آپارتمان دو خو", isFinal: false }),
    );
    expect(socket.last()).toMatchObject({ type: "partial-ack" });
    expect(turns).toBe(0);
    // The final still runs exactly once.
    await session.handleMessage(
      JSON.stringify({ type: "text", transcript: "من دنبال یه آپارتمان دو خوابه هستم", eventId: "pf1" }),
    );
    expect(turns).toBe(1);
  });
});

describe("media sequenced audio frames", () => {
  const frame = (seq: number, text: string) =>
    JSON.stringify({ type: "audio", seq, payload: Buffer.from(text).toString("base64") });

  it("reassembles out-of-order frames and drops duplicates", async () => {
    const seen: VoiceTurnInput[] = [];
    const { socket, session, start } = setup({
      turnRunner: async (input) => { seen.push(input); return cannedTurn(); },
    });
    await start();
    await session.handleMessage(frame(0, "AAA"));
    await session.handleMessage(frame(2, "CCC")); // held
    await session.handleMessage(frame(2, "CCC")); // duplicate... held twice? no: re-hold overwrites, still one copy
    await session.handleMessage(frame(1, "BBB")); // drains 1,2
    await session.handleMessage(JSON.stringify({ type: "utterance-end", eventId: "s1" }));
    expect(seen).toHaveLength(1);
    expect(seen[0].audio?.toString()).toBe("AAABBBCCC");
    expect(socket.messages().some((m) => m.type === "agent-audio")).toBe(true);
  });

  it("drops late retransmits after delivery", async () => {
    const seen: VoiceTurnInput[] = [];
    const { socket, session, start } = setup({
      turnRunner: async (input) => { seen.push(input); return cannedTurn(); },
    });
    await start();
    await session.handleMessage(frame(0, "AAA"));
    await session.handleMessage(frame(0, "AAA")); // late duplicate: dropped silently
    await session.handleMessage(JSON.stringify({ type: "utterance-end", eventId: "s2" }));
    expect(seen[0].audio?.toString()).toBe("AAA");
    expect(socket.messages().filter((m) => m.type === "error")).toHaveLength(0);
  });

  it("skips gaps at utterance-end instead of waiting forever", async () => {
    const seen: VoiceTurnInput[] = [];
    const { session, start } = setup({
      turnRunner: async (input) => { seen.push(input); return cannedTurn(); },
    });
    await start();
    await session.handleMessage(frame(0, "AAA"));
    await session.handleMessage(frame(3, "DDD")); // seq 1,2 never arrive
    await session.handleMessage(JSON.stringify({ type: "utterance-end", eventId: "s3" }));
    expect(seen[0].audio?.toString()).toBe("AAADDD");
  });

  it("rejects malformed frames and oversized payloads", async () => {
    const { socket, session, start } = setup({ maxFrameBytes: 8 });
    await start();
    await session.handleMessage(JSON.stringify({ type: "audio", seq: -1, payload: "eA==" }));
    expect(socket.last()).toMatchObject({ type: "error", code: "INVALID_MESSAGE" });
    await session.handleMessage(JSON.stringify({ type: "audio", seq: 0 }));
    expect(socket.last()).toMatchObject({ type: "error", code: "INVALID_MESSAGE" });
    await session.handleMessage(frame(0, "this-payload-is-too-long"));
    expect(socket.last()).toMatchObject({ type: "error", code: "FRAME_TOO_LARGE" });
    await session.handleMessage(Buffer.alloc(16));
    expect(socket.last()).toMatchObject({ type: "error", code: "FRAME_TOO_LARGE" });
    expect(socket.closed).toBeNull(); // all non-fatal
  });
});

describe("media server-vad mode", () => {
  const VAD = { silenceMs: 100, minSpeechMs: 60, maxUtteranceMs: 5000, silenceRms: 400, sampleRate: 16000 };
  const vadStart = { utteranceMode: "server-vad", audio: { encoding: "pcm16", sampleRate: 16000 } };

  it("rejects server-vad without a declared audio format", async () => {
    const { socket, session } = setup();
    await session.handleMessage(JSON.stringify({ type: "start", token: TOKEN, businessId: "biz-1", utteranceMode: "server-vad" }));
    expect(socket.last()).toMatchObject({ type: "error", code: "INVALID_START" });
    expect(socket.closed).not.toBeNull();
  });

  it("segments speech automatically and runs turns", async () => {
    const { pcmUtterance, pcmSilence } = await import("../helpers/audio");
    const seen: VoiceTurnInput[] = [];
    const { socket, session } = setup({
      vadConfig: VAD,
      turnRunner: async (input) => { seen.push(input); return cannedTurn(); },
    });
    await session.handleMessage(
      JSON.stringify({ type: "start", token: TOKEN, businessId: "biz-1", callId: "call-1", ...vadStart }),
    );
    expect(socket.last()).toMatchObject({ type: "started", utteranceMode: "server-vad" });
    await session.handleMessage(pcmUtterance(300));
    await session.handleMessage(pcmSilence(300));
    expect(seen).toHaveLength(1);
    expect(seen[0].eventId).toMatch(/^vad-/);
    expect(seen[0].audioMimeType).toBe("audio/wav");
    const types = socket.messages().map((m) => m.type);
    expect(types).toContain("vad");
    expect(types).toContain("agent-audio");
    expect(session.turnState).toBe("LISTENING");
  });

  it("auto-barges on speech while a turn is in flight (pending utterance kept)", async () => {
    const { pcmUtterance, pcmSilence } = await import("../helpers/audio");
    let resolveTurn!: (r: VoiceTurnResult) => void;
    const seen: string[] = [];
    const { socket, session } = setup({
      vadConfig: VAD,
      turnRunner: (input) => {
        seen.push(input.eventId as string);
        return new Promise<VoiceTurnResult>((res) => (resolveTurn = res));
      },
    });
    await session.handleMessage(
      JSON.stringify({ type: "start", token: TOKEN, businessId: "biz-1", callId: "call-1", ...vadStart }),
    );
    // First utterance starts a turn that stays in flight...
    await session.handleMessage(pcmUtterance(300));
    await session.handleMessage(pcmSilence(200));
    expect(seen).toHaveLength(1);
    // ...then the caller talks over it: auto barge-in + held follow-up...
    await session.handleMessage(pcmUtterance(300));
    await session.handleMessage(pcmSilence(200));
    resolveTurn(cannedTurn());
    await new Promise((r) => setTimeout(r, 50));
    const types = socket.messages().map((m) => m.type);
    expect(types).toContain("barge-in-ack");
    expect(types).toContain("turn-superseded");
    expect(seen).toHaveLength(2); // the interrupting speech became its own turn
  });
});

describe("media failure fallback", () => {
  it("speaks a safe fallback and hides technical detail (TURN_FAILED generic)", async () => {
    const spoken: string[] = [];
    const { socket, session, start } = setup({
      turnRunner: async () => { throw new Error("OpenAI timeout after 60000ms"); },
      speakRunner: async (input) => {
        spoken.push(input.text);
        return { audio: Buffer.from("FALLBACK"), mimeType: "audio/mpeg", audioUrl: null };
      },
    });
    await start();
    await session.handleMessage(JSON.stringify({ type: "text", transcript: "سلام", eventId: "f1" }));
    expect(spoken).toHaveLength(1);
    expect(spoken[0]).not.toContain("OpenAI");
    const audio = socket.messages().find((m) => m.type === "agent-audio");
    expect(audio).toMatchObject({ fallback: true, eventId: "f1" });
    const err = socket.messages().find((m) => m.type === "error" && m.code === "TURN_FAILED");
    expect(err?.message).toBe("turn_failed");
    expect(JSON.stringify(socket.messages())).not.toContain("OpenAI");
    expect(session.turnState).toBe("LISTENING"); // recoverable
    expect(socket.closed).toBeNull();
  });
});

describe("media silence handling", () => {
  const cannedSpeak = async () => ({ audio: Buffer.from("NUDGE"), mimeType: "audio/mpeg", audioUrl: null });

  it("nudges on silence, then gives up with a marker and hangs up", async () => {
    let giveups = 0;
    const { socket, session, start } = setup({
      speakRunner: cannedSpeak,
      silenceTimeoutMs: 20,
      maxReprompts: 1,
      markSilenceGiveup: async () => { giveups++; },
    });
    await start();
    await new Promise((r) => setTimeout(r, 80)); // first timeout -> nudge
    expect(socket.messages().some((m) => m.type === "agent-audio" && m.reprompt === true)).toBe(true);
    await new Promise((r) => setTimeout(r, 80)); // second timeout -> final + giveup
    const types = socket.messages().map((m) => m.type);
    expect(types).toContain("silence-giveup");
    expect(giveups).toBe(1);
    expect(socket.closed).toMatchObject({ code: 1000 });
    expect(session.turnState).toBe("ENDED");
  });

  it("caller speech cancels the reprompt (no talking over the caller)", async () => {
    let releaseSpeak!: () => void;
    const gate = new Promise<void>((res) => (releaseSpeak = res));
    const { socket, start, session } = setup({
      speakRunner: async () => {
        await gate;
        return { audio: Buffer.from("NUDGE"), mimeType: "audio/mpeg", audioUrl: null };
      },
      silenceTimeoutMs: 20,
      maxReprompts: 5,
    });
    await start();
    await new Promise((r) => setTimeout(r, 50)); // reprompt #1 starts, gated mid-synthesis
    await session.handleMessage(JSON.stringify({ type: "text", transcript: "هستم!", eventId: "c1" }));
    releaseSpeak();
    await new Promise((r) => setTimeout(r, 50));
    // The in-flight nudge (#1) was suppressed; the turn's own audio went out.
    const audios = socket.messages().filter((m) => m.type === "agent-audio");
    expect(audios.some((a) => a.eventId === "c1" && !("reprompt" in a))).toBe(true);
    expect(audios.some((a) => a.eventId === `silence-${session.sessionId}-1`)).toBe(false);
  });
});

describe("media server capacity", () => {
  it("rejects new sessions over the cap with 503 SERVER_FULL", async () => {
    const server = new MediaServer({ token: TOKEN, maxSessions: 1 });
    const s1 = server.accept(new FakeSocket());
    expect(s1.turnState).toBe("IDLE");
    let err: unknown = null;
    try {
      server.accept(new FakeSocket());
    } catch (e) {
      err = e;
    }
    expect(err).toMatchObject({ status: 503, code: "SERVER_FULL" });
    server.release(s1);
    const s2 = server.accept(new FakeSocket());
    expect(s2.turnState).toBe("IDLE");
  });

  it("reports a state snapshot for health checks", async () => {
    const server = new MediaServer({ token: TOKEN, resolveCall: async () => RESOLUTION });
    const s1 = server.accept(new FakeSocket());
    server.accept(new FakeSocket());
    await s1.handleMessage(JSON.stringify({ type: "start", token: TOKEN, businessId: "biz-1", callId: "call-1" }));
    const snap = server.snapshot();
    expect(snap.sessions).toBe(2);
    expect(snap.states).toEqual({ LISTENING: 1, IDLE: 1 });
  });
});
