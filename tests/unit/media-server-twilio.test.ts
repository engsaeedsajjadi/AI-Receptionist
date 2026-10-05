import { describe, expect, it, vi } from "vitest";
import {
  MediaServer,
  MediaSocketOpen,
  type CallResolution,
  type MediaSocket,
} from "@/lib/voice/media-server";
import type { VoiceTurnInput, VoiceTurnResult } from "@/lib/voice/turn";
import { acceptMediaSessionToken } from "../helpers/media";

const TOKEN = "media-secret";
const RESOLUTION: CallResolution = { businessId: "biz-1", callId: "call-1", agentId: "agent-1" };

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
  envelopes(): Array<Record<string, unknown>> {
    return this.sent.map((raw) => JSON.parse(raw) as Record<string, unknown>);
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
    audio: Buffer.alloc(480, 7),
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
  onHandoffRequest?: (context: { businessId: string; callId: string; digits: string }) => Promise<{ destination?: string | null } | void>;
  ttsPcmSampleRate?: number;
}) {
  const socket = new FakeSocket();
  const server = new MediaServer({
    token: TOKEN,
    turnRunner: opts?.turnRunner ?? (async () => cannedTurn()),
    resolveCall: async () => RESOLUTION,
    vadEnabled: false,
    allowStaticToken: true,
    maxConcurrentSessions: 10,
    ttsPcmSampleRate: opts?.ttsPcmSampleRate,
    onHandoffRequest: opts?.onHandoffRequest,
  });
  const session = server.accept(socket);
  const token = acceptMediaSessionToken(TOKEN, { businessId: "biz-1", callId: "call-1", externalCallId: "CA1" });
  return { socket, session, token };
}

async function sendTwilioStart(socket: FakeSocket, session: ReturnType<typeof setup>["session"], token: string) {
  await session.handleMessage(
    JSON.stringify({
      event: "start",
      streamSid: "MZ1",
      start: {
        streamSid: "MZ1",
        callSid: "CA1",
        customParameters: { token, businessId: "biz-1", callId: "call-1" },
      },
    }),
  );
  expect(session.state).toBe("LISTENING");
}

describe("Twilio Media Streams bridge", () => {
  it("accepts a Twilio start envelope and keeps app diagnostics off the wire", async () => {
    const { socket, session, token } = setup();
    await session.handleMessage(
      JSON.stringify({
        event: "start",
        streamSid: "MZ1",
        start: { streamSid: "MZ1", callSid: "CA1", customParameters: { token, businessId: "biz-1", callId: "call-1" } },
      }),
    );
    expect(session.state).toBe("LISTENING");
    // Only Twilio's own envelope vocabulary is transmitted in bridge mode.
    expect(socket.sent.every((raw) => raw.startsWith("{"))).toBe(true);
    for (const frame of socket.envelopes()) {
      expect(["media", "mark", "clear"]).toContain(String(frame.event));
    }
  });

  it("rejects a Twilio start frame whose token is not valid for the call", async () => {
    const { socket, session } = setup();
    await session.handleMessage(
      JSON.stringify({
        event: "start",
        streamSid: "MZ1",
        start: { streamSid: "MZ1", callSid: "CA1", customParameters: { token: "forged", businessId: "biz-1", callId: "call-1" } },
      }),
    );
    expect(socket.closed?.code).toBe(4401);
    expect(session.state).not.toBe("LISTENING");
  });

  it("bridges provider TTS PCM into 20 ms μ-law media frames plus a mark", async () => {
    const { socket, session, token } = setup({ ttsPcmSampleRate: 24_000 });
    await sendTwilioStart(socket, session, token);
    await session.handleMessage(JSON.stringify({ event: "media", media: { payload: Buffer.alloc(160, 0x7f).toString("base64") } }));
    await session.handleMessage(JSON.stringify({ type: "utterance-end", eventId: "u1" }));
    const media = socket.envelopes().filter((frame) => frame.event === "media");
    // 480 PCM bytes at 24 kHz → 80 μ-law bytes at 8 kHz → exactly one 20 ms frame.
    expect(media.length).toBe(1);
    const first = media[0] as { streamSid: string; media: { payload: string } };
    expect(first.streamSid).toBe("MZ1");
    expect(Buffer.from(first.media.payload, "base64").length).toBe(80);
    expect(socket.envelopes().some((frame) => frame.event === "mark")).toBe(true);
  });

  it("splits long agent audio into multiple telephony frames", async () => {
    const { socket, session, token } = setup({
      // 24 kHz PCM: 7.6 KB ≈ 3.8 KB μ-law → many 160-byte frames.
      turnRunner: async () => cannedTurn({ audio: Buffer.alloc(7680, 9), audioMimeType: "audio/pcm" }),
    });
    await sendTwilioStart(socket, session, token);
    await session.handleMessage(JSON.stringify({ event: "media", media: { payload: Buffer.alloc(160, 1).toString("base64") } }));
    await session.handleMessage(JSON.stringify({ type: "utterance-end", eventId: "u2" }));
    const media = socket.envelopes().filter((frame) => frame.event === "media");
    expect(media.length).toBeGreaterThan(1);
    for (const frame of media) {
      const envelope = frame as { media: { payload: string } };
      expect(Buffer.from(envelope.media.payload, "base64").length).toBeLessThanOrEqual(160);
    }
  });

  it("clears playback on barge-in and asks for a human on DTMF 0", async () => {
    const handoffs: Array<{ callId: string; digits: string }> = [];
    const { socket, session, token } = setup({
      onHandoffRequest: async ({ callId, digits }) => {
        handoffs.push({ callId, digits });
        return { destination: "+989121111111" };
      },
    });
    await sendTwilioStart(socket, session, token);
    await session.handleMessage(JSON.stringify({ event: "dtmf", dtmf: { digit: "1" } }));
    await session.handleMessage(JSON.stringify({ event: "dtmf", dtmf: { digit: "0" } }));
    expect(handoffs).toEqual([{ callId: "call-1", digits: "10" }]);
    await session.handleMessage(JSON.stringify({ type: "barge-in" }));
    expect(socket.envelopes().some((frame) => frame.event === "clear")).toBe(true);
  });

  it("does not fake playback when TTS returns a container format", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { socket, session, token } = setup({
      turnRunner: async () => cannedTurn({ audio: Buffer.from("ID3"), audioMimeType: "audio/mpeg" }),
    });
    await sendTwilioStart(socket, session, token);
    await session.handleMessage(JSON.stringify({ event: "media", media: { payload: Buffer.alloc(160, 1).toString("base64") } }));
    await session.handleMessage(JSON.stringify({ type: "utterance-end", eventId: "u3" }));
    expect(socket.envelopes().some((frame) => frame.event === "media")).toBe(false);
    warn.mockRestore();
  });

  it("runs a turn from Twilio audio alone when server-side VAD is enabled", async () => {
    const socket = new FakeSocket();
    const server = new MediaServer({
      token: TOKEN,
      turnRunner: async () => cannedTurn(),
      resolveCall: async () => RESOLUTION,
      allowStaticToken: true,
      vadEnabled: true,
      vadSpeechThreshold: 0.001,
      vadSilenceMs: 100,
      vadMinSpeechMs: 20,
    });
    const session = server.accept(socket);
    const token = acceptMediaSessionToken(TOKEN, { businessId: "biz-1", callId: "call-1", externalCallId: "CA1" });
    await session.handleMessage(
      JSON.stringify({
        event: "start",
        streamSid: "MZ9",
        start: { streamSid: "MZ9", callSid: "CA1", customParameters: { token, businessId: "biz-1", callId: "call-1" } },
      }),
    );
    // Loud μ-law frames followed by silence: our own VAD must close the turn.
    for (let i = 0; i < 8; i++) {
      await session.handleMessage(JSON.stringify({ event: "media", media: { payload: Buffer.alloc(160, 0x00).toString("base64") } }));
    }
    for (let i = 0; i < 20; i++) {
      await session.handleMessage(JSON.stringify({ event: "media", media: { payload: Buffer.alloc(160, 0xff).toString("base64") } }));
    }
    const media = socket.envelopes().filter((frame) => frame.event === "media");
    expect(media.length).toBeGreaterThan(0);
  });

  it("closes the session when Twilio reports the stream stopped", async () => {
    const { socket, session, token } = setup();
    await sendTwilioStart(socket, session, token);
    await session.handleMessage(JSON.stringify({ event: "stop" }));
    expect(socket.closed).not.toBeNull();
  });

  it("ignores unknown Twilio events without crashing the session", async () => {
    const { socket, session, token } = setup();
    await sendTwilioStart(socket, session, token);
    await session.handleMessage(JSON.stringify({ event: "mark", mark: { name: "x" } }));
    await session.handleMessage(JSON.stringify({ event: "connected" }));
    expect(session.state).toBe("LISTENING");
    expect(socket.closed).toBeNull();
  });
});
