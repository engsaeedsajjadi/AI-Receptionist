import { timingSafeEqual } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { calls } from "@/db/schema";
import { logInfo, logWarn } from "@/lib/logger";
import { runVoiceTurn, type VoiceTurnInput, type VoiceTurnResult } from "@/lib/voice/turn";
import {
  EnergyVAD,
  mulawFrames,
  pcmToTelephonyMulaw,
  type AudioCodec,
} from "@/lib/voice/audio";
import { twilioMediaFrameToAudio } from "@/lib/providers/telephony/twilio";
import { VoiceStateMachine, type VoiceSessionState } from "@/lib/voice/state";
import { verifyMediaSessionToken } from "@/lib/voice/media-auth";

/**
 * Media-sidecar protocol (JSON text frames + binary audio frames).
 *
 * Gateway → server:
 *   { type: "start", token, businessId, callId?, externalCallId?, agentId?,
 *     language?, voice?, audioMimeType?, codec?, sampleRate? }
 *   <binary>                              audio chunk (appended to the utterance buffer)
 *   { type: "utterance-end", eventId, seq? } run a turn on the buffered audio
 *   { type: "text", transcript, eventId } text-topology turn (gateway-side STT)
 *   { type: "barge-in" }                  caller interrupted: supersede/stop the current turn
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
 * fetches the audio over HTTPS. Binary audio is bounded, and production
 * media sessions may auto-detect utterance boundaries with energy VAD.
 * If a new speech segment arrives while a turn is running, the current
 * result is superseded and the new segment is queued for processing.
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
  maxFrameBytes?: number;
  vadEnabled?: boolean;
  vadSpeechThreshold?: number;
  vadSilenceMs?: number;
  vadMinSpeechMs?: number;
  vadMaxUtteranceMs?: number;
  defaultCodec?: AudioCodec;
  defaultSampleRate?: number;
  /** Test/dev compatibility only; production must use signed per-call tokens. */
  allowStaticToken?: boolean;
  maxConcurrentSessions?: number;
  onSessionClosed?: () => void;
  /** TTS sample rate for raw PCM output (Twilio bridging resamples to 8 kHz). */
  ttsPcmSampleRate?: number;
  /** Called when a caller asks for a human (DTMF 0 or an explicit handoff frame). */
  onHandoffRequest?: (context: { businessId: string; callId: string; digits: string }) => Promise<{ destination?: string | null } | void>;
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
  codec?: AudioCodec;
  sampleRate?: number;
};

/** Envelope event names owned by the Twilio Media Streams protocol. */
const TWILIO_EVENTS = new Set(["connected", "start", "media", "dtmf", "mark", "stop"]);

const DEFAULT_IDLE_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_MAX_BUFFER_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_FRAME_BYTES = 64 * 1024;
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
  private codec: AudioCodec = "mulaw";
  private sampleRate = 8000;
  private readonly stateMachine = new VoiceStateMachine();
  private vad: EnergyVAD;
  private lastAudioSeq: number | null = null;
  private pendingTurn: { audio: Buffer; eventId: string } | null = null;
  private buffer: Buffer[] = [];
  private bufferedBytes = 0;
  private turnInFlight = false;
  private turnSeq = 0;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  /** Twilio Media Streams bridge state (null for the app-native protocol). */
  private twilioStream: { streamSid: string } | null = null;
  private dtmfDigits = "";

  constructor(
    private readonly socket: MediaSocket,
    private readonly opts: Required<Pick<MediaServerOptions, "token" | "turnRunner" | "resolveCall">> &
      Pick<MediaServerOptions,
        "idleTimeoutMs" | "maxBufferBytes" | "maxFrameBytes" | "vadEnabled" |
        "vadSpeechThreshold" | "vadSilenceMs" | "vadMinSpeechMs" | "vadMaxUtteranceMs" |
        "defaultCodec" | "defaultSampleRate" | "allowStaticToken" | "maxConcurrentSessions" | "onSessionClosed" |
        "ttsPcmSampleRate" | "onHandoffRequest"
      >,
  ) {
    sessionSeq += 1;
    this.sessionId = `media-${Date.now()}-${sessionSeq}`;
    this.codec = opts.defaultCodec ?? "mulaw";
    this.sampleRate = opts.defaultSampleRate ?? 8000;
    this.vad = new EnergyVAD({
      enabled: opts.vadEnabled ?? true,
      codec: this.codec,
      sampleRate: this.sampleRate,
      speechThreshold: opts.vadSpeechThreshold ?? 0.015,
      silenceMs: opts.vadSilenceMs ?? 700,
      minSpeechMs: opts.vadMinSpeechMs ?? 180,
      maxUtteranceMs: opts.vadMaxUtteranceMs ?? 12_000,
    });
  }


  get state(): VoiceSessionState {
    return this.stateMachine.state;
  }
  /** Entry point for every inbound frame. Never throws. */
  async handleMessage(data: string | Buffer): Promise<void> {
    if (this.closed) return;
    this.refreshIdleTimer();
    try {
      if (typeof data !== "string" && Buffer.isBuffer(data)) {
        await this.appendAudio(data);
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
      // Twilio Media Streams use `event`; app-native control frames use `type`.
      // Route by protocol so both can share the session (a bridge receives
      // Twilio envelopes for audio and `utterance-end` from our own VAD).
      if (msg.type === undefined && typeof msg.event === "string" && TWILIO_EVENTS.has(msg.event)) {
        await this.handleTwilioEnvelope(msg);
        return;
      }
      await this.dispatch(msg);
    } catch (err) {
      this.sendError("INTERNAL_ERROR", err instanceof Error ? err.message : "session_error");
    }
  }

  /**
   * Bridge a Twilio Media Streams envelope into the internal session protocol.
   * PSTN audio (8 kHz μ-law) arrives base64-encoded inside `media` events.
   */
  private async handleTwilioEnvelope(envelope: Record<string, unknown>): Promise<void> {
    const frame = twilioMediaFrameToAudio(envelope);
    if (!frame) return;
    switch (frame.type) {
      case "start": {
        const payload = frame.payload;
        this.twilioStream = { streamSid: payload.streamSid ?? "" };
        await this.handleStart({
          type: "start",
          token: payload.token,
          businessId: payload.businessId,
          callId: payload.callId || undefined,
          externalCallId: payload.externalCallId || undefined,
          language: payload.language,
          codec: "mulaw",
          sampleRate: 8000,
        });
        break;
      }
      case "audio":
        await this.appendAudio(frame.audio);
        break;
      case "dtmf":
        await this.handleDtmf(frame.digits);
        break;
      case "stop":
        this.close(1000, "twilio-stop");
        break;
    }
  }

  /**
   * Caller pressed a key. `0` is the platform-wide "talk to a human" digit:
   * the session records it and asks the app for a transfer destination, then
   * reports the handoff over the bridge (Twilio dials it).
   */
  private async handleDtmf(digits: string): Promise<void> {
    this.dtmfDigits = `${this.dtmfDigits}${digits}`.slice(-32);
    this.send({ type: "dtmf", digits: this.dtmfDigits });
    if (!digits.includes("0")) return;
    const resolution = this.resolution;
    if (!resolution) return;
    try {
      const result = await this.opts.onHandoffRequest?.({
        businessId: resolution.businessId,
        callId: resolution.callId,
        digits: this.dtmfDigits,
      });
      logInfo("Caller requested a human via DTMF", {
        businessId: resolution.businessId,
        callId: resolution.callId,
        operation: "voice.media.dtmf",
        status: result?.destination ? "handoff" : "no_destination",
      });
    } catch (err) {
      logWarn("Handoff request failed", {
        businessId: resolution.businessId,
        callId: resolution.callId,
        operation: "voice.media.dtmf",
        status: "error",
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  handleClose(): void {
    if (this.closed) return;
    this.closed = true;
    this.clearIdleTimer();
    this.opts.onSessionClosed?.();
  }

  private send(obj: Record<string, unknown>): void {
    if (this.closed || this.socket.readyState !== MediaSocketOpen) return;
    if (this.twilioStream) {
      this.sendTwilio(obj);
      return;
    }
    this.socket.send(JSON.stringify(obj));
  }

  /**
   * Twilio Media Streams accept only `media` (base64 μ-law), `mark` and `clear`.
   * Agent audio in raw PCM is resampled to 8 kHz and G.711-encoded; nothing else
   * is transmitted (diagnostics stay in our own logs to avoid protocol misuse).
   */
  private sendTwilio(obj: Record<string, unknown>): void {
    const streamSid = this.twilioStream?.streamSid ?? "";
    if (obj.type === "barge-in-ack" || obj.type === "turn-superseded") {
      // Interrupting playback: drop queued audio instead of letting the caller
      // hear the rest of the previous answer.
      this.socket.send(JSON.stringify({ event: "clear", streamSid }));
      logInfo("Twilio media cleared on barge-in", {
        businessId: this.resolution?.businessId,
        callId: this.resolution?.callId,
        operation: "voice.media.clear",
        status: "ok",
      });
      return;
    }
    if (obj.type !== "agent-audio") return;
    const inline = obj.audio;
    const mimeType = typeof obj.mimeType === "string" ? obj.mimeType : "";
    if (typeof inline !== "string" || inline.length === 0) {
      if (obj.audioUrl) {
        logWarn("Twilio bridge cannot fetch provider audio URLs; configure TTS format pcm", {
          businessId: this.resolution?.businessId,
          callId: this.resolution?.callId,
          operation: "voice.media.egress",
          status: "unsupported_url",
        });
      }
      return;
    }
    const raw = Buffer.from(inline, "base64");
    let mulaw: Buffer;
    if (mimeType === "audio/pcm") {
      mulaw = pcmToTelephonyMulaw(raw, this.opts.ttsPcmSampleRate ?? 24_000, 8_000);
    } else if (mimeType === "audio/x-mulaw" || mimeType === "audio/basic") {
      mulaw = raw;
    } else {
      logWarn("Twilio bridge received non-PCM audio; set TTS format to pcm for streaming", {
        businessId: this.resolution?.businessId,
        callId: this.resolution?.callId,
        operation: "voice.media.egress",
        status: "unsupported_format",
      });
      return;
    }
    for (const frame of mulawFrames(mulaw)) {
      this.socket.send(JSON.stringify({ event: "media", streamSid, media: { payload: frame.toString("base64") } }));
    }
    this.socket.send(JSON.stringify({ event: "mark", streamSid, mark: { name: `turn-${this.turnSeq}` } }));
  }

  private sendError(code: string, message: string, fatal = false): void {
    if (this.twilioStream) {
      // Twilio's wire protocol has no error channel; record it locally so
      // operators can see why a bridge session failed.
      logWarn("Media bridge error", {
        businessId: this.resolution?.businessId,
        callId: this.resolution?.callId,
        operation: "voice.media.error",
        status: code,
        error: message,
      });
    }
    this.send({ type: "error", code, message });
    if (fatal) this.close(4400 + (code === "UNAUTHORIZED" ? 1 : 0), code);
  }

  private close(code: number, reason: string): void {
    if (this.closed) return;
    this.closed = true;
    this.clearIdleTimer();
    this.opts.onSessionClosed?.();
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
        this.interruptActiveTurn();
        break;
      case "ping":
        this.send({ type: "pong" });
        break;
      case "stop":
        if (this.stateMachine.state !== "ENDING" && this.stateMachine.state !== "ENDED") {
          try { this.stateMachine.transition("ENDING"); } catch { /* ignore */ }
        }
        this.send({ type: "stopped", sessionId: this.sessionId, state: this.stateMachine.state });
        if (this.stateMachine.state === "ENDING") { try { this.stateMachine.transition("ENDED"); } catch { /* ignore */ } }
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
    if (!msg.businessId) {
      this.sendError("INVALID_START", "start requires businessId", true);
      return;
    }
    if (msg.codec && !["mulaw", "pcm_s16le", "unknown"].includes(msg.codec)) {
      this.sendError("INVALID_START", "Unsupported audio codec", true);
      return;
    }
    if (msg.sampleRate !== undefined && (!Number.isInteger(msg.sampleRate) || msg.sampleRate < 8000 || msg.sampleRate > 48000)) {
      this.sendError("INVALID_START", "sampleRate must be an integer between 8000 and 48000", true);
      return;
    }
    const token = msg.token ?? "";
    const claims = verifyMediaSessionToken(token, this.opts.token, {
      businessId: msg.businessId,
      callId: msg.callId,
      externalCallId: msg.externalCallId,
    });
    const staticTokenAllowed = Boolean(this.opts.allowStaticToken && safeEqual(token, this.opts.token));
    if (!claims && !staticTokenAllowed) {
      this.sendError("UNAUTHORIZED", "Invalid or expired media session token", true);
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
    this.codec = msg.codec ?? this.opts.defaultCodec ?? "mulaw";
    this.sampleRate = msg.sampleRate ?? this.opts.defaultSampleRate ?? 8000;
    this.vad = new EnergyVAD({
      enabled: this.opts.vadEnabled ?? true,
      codec: this.codec,
      sampleRate: this.sampleRate,
      speechThreshold: this.opts.vadSpeechThreshold ?? 0.015,
      silenceMs: this.opts.vadSilenceMs ?? 700,
      minSpeechMs: this.opts.vadMinSpeechMs ?? 180,
      maxUtteranceMs: this.opts.vadMaxUtteranceMs ?? 12_000,
    });
    this.stateMachine.transition("LISTENING");
    this.started = true;
    logInfo("Media session started", {
      businessId: resolution.businessId,
      callId: resolution.callId,
      operation: "voice.media.start",
      status: "ok",
    });
    this.send({ type: "started", sessionId: this.sessionId, state: this.stateMachine.state, codec: this.codec, sampleRate: this.sampleRate });
  }

  private async appendAudio(chunk: Buffer): Promise<void> {
    if (!this.started) {
      this.sendError("NOT_STARTED", "First message must be a valid start frame");
      return;
    }
    const maxFrame = Math.min(this.opts.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES, this.opts.maxBufferBytes ?? DEFAULT_MAX_BUFFER_BYTES);
    if (chunk.length > maxFrame) {
      this.sendError("FRAME_TOO_LARGE", `Audio frame exceeds ${maxFrame} bytes`);
      return;
    }

    // Speech while an agent turn is running is treated as a barge-in. The
    // current turn cannot be cancelled at the provider boundary yet, so its
    // eventual audio is invalidated by turnSeq and never reaches the caller.
    const vad = this.vad.process(chunk);
    if (vad.speech && this.turnInFlight) {
      this.interruptActiveTurn();
    }

    const cap = this.opts.maxBufferBytes ?? DEFAULT_MAX_BUFFER_BYTES;
    if (this.bufferedBytes + chunk.length > cap) {
      this.buffer = [];
      this.bufferedBytes = 0;
      this.vad.reset();
      this.sendError("BUFFER_OVERFLOW", `Utterance exceeds ${cap} bytes; buffer cleared`);
      return;
    }
    this.buffer.push(chunk);
    this.bufferedBytes += chunk.length;

    if (vad.utteranceEnd) {
      const utterance = this.takeAudio();
      const eventId = `vad-${this.sessionId}-${++this.turnSeq}`;
      if (this.turnInFlight) {
        this.pendingTurn = { audio: utterance, eventId };
      } else {
        await this.runTurn({ audio: utterance, audioMimeType: this.audioMimeType, eventId });
      }
    }
  }

  private interruptActiveTurn(): void {
    this.turnSeq += 1;
    if (this.stateMachine.state === "PROCESSING" || this.stateMachine.state === "SPEAKING") {
      this.stateMachine.transition("INTERRUPTED");
      this.stateMachine.transition("LISTENING");
    }
    this.send({ type: "barge-in-ack", turnSeq: this.turnSeq });
  }

  private takeAudio(): Buffer {
    const audio = Buffer.concat(this.buffer);
    this.buffer = [];
    this.bufferedBytes = 0;
    return audio;
  }

  private async handleUtteranceEnd(msg: Record<string, unknown>): Promise<void> {
    const eventId = msg.eventId;
    const seq = msg.seq;
    if (seq !== undefined && (typeof seq !== "number" || !Number.isSafeInteger(seq) || seq < 0)) {
      this.sendError("INVALID_MESSAGE", "seq must be a non-negative integer");
      return;
    }
    if (typeof seq === "number") {
      if (this.lastAudioSeq !== null && seq <= this.lastAudioSeq) {
        this.send({ type: "turn-complete", eventId, duplicate: true, reason: "out_of_order" });
        return;
      }
      this.lastAudioSeq = seq;
    }
    if (typeof eventId !== "string" || !eventId) {
      this.sendError("INVALID_MESSAGE", "utterance-end requires eventId");
      return;
    }
    const audio = this.takeAudio();
    if (audio.length === 0) {
      this.sendError("EMPTY_UTTERANCE", "No audio buffered for this utterance");
      return;
    }
    if (this.turnInFlight) {
      this.interruptActiveTurn();
      this.pendingTurn = { audio, eventId };
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
    if (this.stateMachine.state === "LISTENING" || this.stateMachine.state === "INTERRUPTED") {
      if (this.stateMachine.state === "INTERRUPTED") this.stateMachine.transition("LISTENING");
      this.stateMachine.transition("PROCESSING");
    }
    const seq = this.turnSeq;
    const requestId = `${this.sessionId}-t${seq}-${Date.now()}`;
    try {
      const result = await this.opts.turnRunner({
        businessId: resolution.businessId,
        agentId: this.agentOverride ?? resolution.agentId ?? undefined,
        callId: resolution.callId,
        audio: input.audio,
        audioMimeType: input.audioMimeType,
        audioCodec: this.codec,
        audioSampleRate: this.sampleRate,
        transcript: input.transcript,
        eventId: input.eventId,
        language: this.language,
        voice: this.voice,
        // A telephony bridge must transcode to μ-law itself, so ask TTS for raw
        // PCM instead of a container format it cannot decode.
        ttsFormat: this.twilioStream ? "pcm" : undefined,
        requestId,
        actor: "media-server",
      });
      if (seq !== this.turnSeq || this.closed) {
        if (!this.closed && this.stateMachine.state === "PROCESSING") this.stateMachine.transition("LISTENING");
        // Caller barged in (or disconnected) while we worked: discard audio.
        if (!this.closed) this.send({ type: "turn-superseded", eventId: input.eventId });
        return;
      }
      if (result.duplicate) {
        if (this.stateMachine.state === "PROCESSING") this.stateMachine.transition("LISTENING");
        this.send({ type: "turn-complete", eventId: input.eventId, duplicate: true });
        return;
      }
      if (!result.heard) {
        if (this.stateMachine.state === "PROCESSING") this.stateMachine.transition("LISTENING");
        this.send({ type: "turn-complete", eventId: input.eventId, heard: false });
        return;
      }
      if (this.stateMachine.state === "PROCESSING") this.stateMachine.transition("SPEAKING");
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
      this.send({ type: "turn-complete", eventId: input.eventId, latencyMs: result.latencyMs, usage: result.usage, state: this.stateMachine.state });
      if (this.stateMachine.state === "SPEAKING") this.stateMachine.transition("LISTENING");
    } catch (err) {
      logWarn("Media turn failed", {
        businessId: resolution.businessId,
        callId: resolution.callId,
        operation: "voice.media.turn",
        status: "error",
        error: err instanceof Error ? err.message : String(err),
      });
      if (this.stateMachine.state !== "ENDED" && this.stateMachine.state !== "ENDING") {
        try { this.stateMachine.transition("ERROR"); } catch { /* terminal cleanup below */ }
      }
      this.send({
        type: "error",
        code: "TURN_FAILED",
        message: err instanceof Error ? err.message : "turn_failed",
        eventId: input.eventId,
      });
    } finally {
      this.turnInFlight = false;
      if (!this.closed && this.stateMachine.state === "ERROR") {
        try { this.stateMachine.transition("LISTENING"); } catch { /* ignore */ }
      }
      const pending = this.pendingTurn;
      this.pendingTurn = null;
      if (pending && !this.closed) {
        await this.runTurn({ audio: pending.audio, audioMimeType: this.audioMimeType, eventId: pending.eventId });
      }
    }
  }
}

export class MediaServer {
  private readonly sessions = new Set<MediaSession>();
  private readonly opts: Required<Pick<MediaServerOptions, "token" | "turnRunner" | "resolveCall">> &
    Pick<MediaServerOptions,
      "idleTimeoutMs" | "maxBufferBytes" | "maxFrameBytes" | "vadEnabled" |
      "vadSpeechThreshold" | "vadSilenceMs" | "vadMinSpeechMs" | "vadMaxUtteranceMs" |
      "defaultCodec" | "defaultSampleRate" | "allowStaticToken" | "maxConcurrentSessions" | "onSessionClosed" |
      "ttsPcmSampleRate" | "onHandoffRequest"
    >;

  constructor(opts: MediaServerOptions) {
    this.opts = {
      token: opts.token,
      turnRunner: opts.turnRunner ?? runVoiceTurn,
      resolveCall: opts.resolveCall ?? resolveCallFromDb,
      idleTimeoutMs: opts.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS,
      maxBufferBytes: opts.maxBufferBytes ?? DEFAULT_MAX_BUFFER_BYTES,
      maxFrameBytes: opts.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES,
      vadEnabled: opts.vadEnabled ?? false,
      vadSpeechThreshold: opts.vadSpeechThreshold ?? 0.015,
      vadSilenceMs: opts.vadSilenceMs ?? 700,
      vadMinSpeechMs: opts.vadMinSpeechMs ?? 180,
      vadMaxUtteranceMs: opts.vadMaxUtteranceMs ?? 12_000,
      defaultCodec: opts.defaultCodec ?? "mulaw",
      defaultSampleRate: opts.defaultSampleRate ?? 8000,
      allowStaticToken: opts.allowStaticToken ?? false,
      maxConcurrentSessions: opts.maxConcurrentSessions ?? 100,
      onSessionClosed: opts.onSessionClosed ?? (() => undefined),
      ttsPcmSampleRate: opts.ttsPcmSampleRate ?? 24_000,
      onHandoffRequest: opts.onHandoffRequest,
    };
  }

  /** Attach a new transport socket; returns its session handler. */
  accept(socket: MediaSocket): MediaSession {
    if (this.sessions.size >= (this.opts.maxConcurrentSessions ?? 100)) {
      socket.send(JSON.stringify({ type: "error", code: "CAPACITY_EXCEEDED", message: "Voice media capacity is temporarily full" }));
      socket.close(4429, "capacity");
      // The returned object is never expected to receive frames after close;
      // keeping it detached avoids mutating active session accounting.
      return new MediaSession(socket, this.opts);
    }
    let session!: MediaSession;
    const onSessionClosed = () => {
      this.sessions.delete(session);
      this.opts.onSessionClosed?.();
    };
    session = new MediaSession(socket, { ...this.opts, onSessionClosed });
    this.sessions.add(session);
    return session;
  }

  get activeSessions(): number {
    return this.sessions.size;
  }
}
