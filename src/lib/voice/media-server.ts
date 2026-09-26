import { timingSafeEqual } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { calls } from "@/db/schema";
import { logInfo, logWarn } from "@/lib/logger";
import { runVoiceTurn, type VoiceTurnInput, type VoiceTurnResult } from "@/lib/voice/turn";

/**
 * Media-sidecar protocol (JSON text frames + binary audio frames).
 *
 * Gateway → server:
 *   { type: "start", token, businessId, callId?, externalCallId?, agentId?,
 *     language?, voice?, audioMimeType? }
 *   <binary>                              audio chunk (appended to the utterance buffer)
 *   { type: "utterance-end", eventId }    run a turn on the buffered audio
 *   { type: "text", transcript, eventId } text-topology turn (gateway-side STT)
 *   { type: "barge-in" }                  caller interrupted: supersede the in-flight turn
 *   { type: "ping" }                      → { type: "pong" }
 *   { type: "stop" }                      clean shutdown of the session
 *
 * Server → gateway:
 *   { type: "started", sessionId }
 *   { type: "agent-audio", eventId, mimeType, audio(base64)|null, audioUrl,
 *     transcript, reply }
 *   { type: "turn-complete", eventId, latencyMs, usage }
 *   { type: "turn-superseded", eventId }
 *   { type: "error", code, message }
 *   { type: "pong" }
 *
 * Large replies (>2 MB audio) send metadata + audioUrl only; the gateway
 * fetches the audio over HTTPS. Utterances are processed strictly one at a
 * time per session; a second utterance while one is in flight is rejected
 * (the gateway serializes VAD segments).
 */

/** Minimal socket surface so the core is testable without a real WebSocket. */
export interface MediaSocket {
  send(data: string | Buffer): void;
  close(code?: number, reason?: string): void;
  readonly readyState: number;
}

export const MediaSocketOpen = 1;

export type CallResolution = { businessId: string; callId: string; agentId: string | null };

export type MediaServerOptions = {
  /** Shared secret gateways must present in `start`. Empty = refuse everything. */
  token: string;
  turnRunner?: (input: VoiceTurnInput) => Promise<VoiceTurnResult>;
  resolveCall?: (
    businessId: string,
    callId?: string,
    externalCallId?: string,
  ) => Promise<CallResolution | null>;
  idleTimeoutMs?: number;
  maxBufferBytes?: number;
};

type StartMessage = {
  type: "start";
  token?: string;
  businessId?: string;
  callId?: string;
  externalCallId?: string;
  agentId?: string;
  language?: string;
  voice?: string;
  audioMimeType?: string;
};

const DEFAULT_IDLE_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_MAX_BUFFER_BYTES = 10 * 1024 * 1024;
const INLINE_AUDIO_BYTES = 2 * 1024 * 1024;

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length || ab.length === 0) return false;
  try {
    return timingSafeEqual(ab, bb);
  } catch {
    return false;
  }
}

export async function resolveCallFromDb(
  businessId: string,
  callId?: string,
  externalCallId?: string,
): Promise<CallResolution | null> {
  if (callId) {
    const [row] = await db
      .select({ id: calls.id, businessId: calls.businessId, agentId: calls.agentId })
      .from(calls)
      .where(and(eq(calls.id, callId), eq(calls.businessId, businessId)))
      .limit(1);
    if (row) return { businessId: row.businessId, callId: row.id, agentId: row.agentId };
    return null;
  }
  if (externalCallId) {
    const [row] = await db
      .select({ id: calls.id, businessId: calls.businessId, agentId: calls.agentId })
      .from(calls)
      .where(and(eq(calls.businessId, businessId), eq(calls.externalCallId, externalCallId)))
      .limit(1);
    if (row) return { businessId: row.businessId, callId: row.id, agentId: row.agentId };
    return null;
  }
  return null;
}

let sessionSeq = 0;

export class MediaSession {
  readonly sessionId: string;
  private started = false;
  private closed = false;
  private resolution: CallResolution | null = null;
  private agentOverride?: string;
  private language?: string;
  private voice?: string;
  private audioMimeType?: string;
  private buffer: Buffer[] = [];
  private bufferedBytes = 0;
  private turnInFlight = false;
  private turnSeq = 0;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly socket: MediaSocket,
    private readonly opts: Required<Pick<MediaServerOptions, "token" | "turnRunner" | "resolveCall">> &
      Pick<MediaServerOptions, "idleTimeoutMs" | "maxBufferBytes">,
  ) {
    sessionSeq += 1;
    this.sessionId = `media-${Date.now()}-${sessionSeq}`;
  }

  /** Entry point for every inbound frame. Never throws. */
  async handleMessage(data: string | Buffer): Promise<void> {
    if (this.closed) return;
    this.refreshIdleTimer();
    try {
      if (typeof data !== "string" && Buffer.isBuffer(data)) {
        this.appendAudio(data);
        return;
      }
      const text = typeof data === "string" ? data : Buffer.from(data as Uint8Array).toString("utf8");
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(text) as Record<string, unknown>;
      } catch {
        this.sendError("INVALID_JSON", "Message is not valid JSON");
        return;
      }
      await this.dispatch(msg);
    } catch (err) {
      this.sendError("INTERNAL_ERROR", err instanceof Error ? err.message : "session_error");
    }
  }

  handleClose(): void {
    this.closed = true;
    this.clearIdleTimer();
  }

  private send(obj: Record<string, unknown>): void {
    if (this.closed || this.socket.readyState !== MediaSocketOpen) return;
    this.socket.send(JSON.stringify(obj));
  }

  private sendError(code: string, message: string, fatal = false): void {
    this.send({ type: "error", code, message });
    if (fatal) this.close(4400 + (code === "UNAUTHORIZED" ? 1 : 0), code);
  }

  private close(code: number, reason: string): void {
    if (this.closed) return;
    this.closed = true;
    this.clearIdleTimer();
    try {
      this.socket.close(code, reason);
    } catch {
      // ignore close errors
    }
  }

  private refreshIdleTimer(): void {
    this.clearIdleTimer();
    const ms = this.opts.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.idleTimer = setTimeout(() => {
      this.sendError("IDLE_TIMEOUT", "Session idle too long", true);
    }, ms);
    if (typeof this.idleTimer === "object" && "unref" in this.idleTimer) {
      (this.idleTimer as unknown as { unref: () => void }).unref();
    }
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  private async dispatch(msg: Record<string, unknown>): Promise<void> {
    const type = msg.type;
    if (type === "start") {
      await this.handleStart(msg as unknown as StartMessage);
      return;
    }
    if (!this.started || !this.resolution) {
      this.sendError("NOT_STARTED", "First message must be a valid start frame");
      return;
    }
    switch (type) {
      case "utterance-end":
        await this.handleUtteranceEnd(msg);
        break;
      case "text":
        await this.handleText(msg);
        break;
      case "barge-in":
        // Invalidate any in-flight turn: its audio is discarded on completion.
        this.turnSeq += 1;
        this.send({ type: "barge-in-ack", turnSeq: this.turnSeq });
        break;
      case "ping":
        this.send({ type: "pong" });
        break;
      case "stop":
        this.send({ type: "stopped", sessionId: this.sessionId });
        this.close(1000, "stop");
        break;
      default:
        this.sendError("UNKNOWN_MESSAGE", `Unknown message type: ${String(type)}`);
    }
  }

  private async handleStart(msg: StartMessage): Promise<void> {
    if (this.started) {
      this.sendError("ALREADY_STARTED", "Session already started");
      return;
    }
    if (!this.opts.token || !safeEqual(msg.token ?? "", this.opts.token)) {
      this.sendError("UNAUTHORIZED", "Invalid media token", true);
      return;
    }
    if (!msg.businessId) {
      this.sendError("INVALID_START", "start requires businessId", true);
      return;
    }
    const resolution = await this.opts.resolveCall(msg.businessId, msg.callId, msg.externalCallId);
    if (!resolution) {
      this.sendError("CALL_NOT_FOUND", "Call not found for this business", true);
      return;
    }
    this.resolution = resolution;
    this.agentOverride = msg.agentId;
    this.language = msg.language;
    this.voice = msg.voice;
    this.audioMimeType = msg.audioMimeType;
    this.started = true;
    logInfo("Media session started", {
      businessId: resolution.businessId,
      callId: resolution.callId,
      operation: "voice.media.start",
      status: "ok",
    });
    this.send({ type: "started", sessionId: this.sessionId });
  }

  private appendAudio(chunk: Buffer): void {
    if (!this.started) {
      this.sendError("NOT_STARTED", "First message must be a valid start frame");
      return;
    }
    const cap = this.opts.maxBufferBytes ?? DEFAULT_MAX_BUFFER_BYTES;
    if (this.bufferedBytes + chunk.length > cap) {
      this.buffer = [];
      this.bufferedBytes = 0;
      this.sendError("BUFFER_OVERFLOW", `Utterance exceeds ${cap} bytes; buffer cleared`);
      return;
    }
    this.buffer.push(chunk);
    this.bufferedBytes += chunk.length;
  }

  private takeAudio(): Buffer {
    const audio = Buffer.concat(this.buffer);
    this.buffer = [];
    this.bufferedBytes = 0;
    return audio;
  }

  private async handleUtteranceEnd(msg: Record<string, unknown>): Promise<void> {
    const eventId = msg.eventId;
    if (typeof eventId !== "string" || !eventId) {
      this.sendError("INVALID_MESSAGE", "utterance-end requires eventId");
      return;
    }
    const audio = this.takeAudio();
    if (audio.length === 0) {
      this.sendError("EMPTY_UTTERANCE", "No audio buffered for this utterance");
      return;
    }
    await this.runTurn({ audio, audioMimeType: this.audioMimeType, eventId });
  }

  private async handleText(msg: Record<string, unknown>): Promise<void> {
    const transcript = msg.transcript;
    const eventId = msg.eventId;
    if (typeof transcript !== "string" || !transcript.trim()) {
      this.sendError("INVALID_MESSAGE", "text requires a non-empty transcript");
      return;
    }
    if (typeof eventId !== "string" || !eventId) {
      this.sendError("INVALID_MESSAGE", "text requires eventId");
      return;
    }
    await this.runTurn({ transcript: transcript.slice(0, 20000), eventId });
  }

  private async runTurn(input: { audio?: Buffer; audioMimeType?: string; transcript?: string; eventId: string }): Promise<void> {
    if (this.turnInFlight) {
      this.sendError("TURN_IN_PROGRESS", "Finish the current utterance before starting another");
      return;
    }
    const resolution = this.resolution as CallResolution;
    this.turnInFlight = true;
    const seq = this.turnSeq;
    const requestId = `${this.sessionId}-t${seq}-${Date.now()}`;
    try {
      const result = await this.opts.turnRunner({
        businessId: resolution.businessId,
        agentId: this.agentOverride ?? resolution.agentId ?? undefined,
        callId: resolution.callId,
        audio: input.audio,
        audioMimeType: input.audioMimeType,
        transcript: input.transcript,
        eventId: input.eventId,
        language: this.language,
        voice: this.voice,
        requestId,
        actor: "media-server",
      });
      if (seq !== this.turnSeq || this.closed) {
        // Caller barged in (or disconnected) while we worked: discard audio.
        if (!this.closed) this.send({ type: "turn-superseded", eventId: input.eventId });
        return;
      }
      if (result.duplicate) {
        this.send({ type: "turn-complete", eventId: input.eventId, duplicate: true });
        return;
      }
      if (!result.heard) {
        this.send({ type: "turn-complete", eventId: input.eventId, heard: false });
        return;
      }
      const inline = result.audio && result.audio.length <= INLINE_AUDIO_BYTES ? result.audio.toString("base64") : null;
      this.send({
        type: "agent-audio",
        eventId: input.eventId,
        mimeType: result.audioMimeType,
        audio: inline,
        audioUrl: result.audioUrl,
        transcript: result.transcript,
        reply: result.reply,
      });
      this.send({ type: "turn-complete", eventId: input.eventId, latencyMs: result.latencyMs, usage: result.usage });
    } catch (err) {
      logWarn("Media turn failed", {
        businessId: resolution.businessId,
        callId: resolution.callId,
        operation: "voice.media.turn",
        status: "error",
        error: err instanceof Error ? err.message : String(err),
      });
      this.send({
        type: "error",
        code: "TURN_FAILED",
        message: err instanceof Error ? err.message : "turn_failed",
        eventId: input.eventId,
      });
    } finally {
      this.turnInFlight = false;
    }
  }
}

export class MediaServer {
  private readonly opts: Required<Pick<MediaServerOptions, "token" | "turnRunner" | "resolveCall">> &
    Pick<MediaServerOptions, "idleTimeoutMs" | "maxBufferBytes">;

  constructor(opts: MediaServerOptions) {
    this.opts = {
      token: opts.token,
      turnRunner: opts.turnRunner ?? runVoiceTurn,
      resolveCall: opts.resolveCall ?? resolveCallFromDb,
      idleTimeoutMs: opts.idleTimeoutMs,
      maxBufferBytes: opts.maxBufferBytes,
    };
  }

  /** Attach a new transport socket; returns its session handler. */
  accept(socket: MediaSocket): MediaSession {
    return new MediaSession(socket, this.opts);
  }
}
