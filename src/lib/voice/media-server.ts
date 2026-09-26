import { timingSafeEqual } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { calls } from "@/db/schema";
import { AppError } from "@/lib/errors";
import { getEnv } from "@/lib/env";
import { logError, logInfo, logWarn } from "@/lib/logger";
import { normalizeTelephonyAudio, type AudioFormat } from "@/lib/audio/format";
import { buildWav } from "@/lib/audio/wav";
import { EnergyVad, defaultVadConfig, type VadConfig } from "@/lib/audio/vad";
import {
  resolveBusinessByCalledNumber,
  type CalledNumberRoute,
} from "@/lib/services/phone-routing";
import { InvalidMediaToken, verifyMediaToken, type MediaTokenClaims } from "@/lib/voice/media-tokens";
import { TurnStateMachine, type VoiceTurnState } from "@/lib/voice/turn-machine";
import {
  deleteVoiceSession,
  newSessionDoc,
  saveVoiceSession,
  type VoiceSessionDoc,
} from "@/lib/voice/session-store";
import { SILENCE_FINAL, SILENCE_NUDGE, TURN_FAILURE_FALLBACK, speakText, type SpeakInput, type SpeakResult } from "@/lib/voice/speak";
import { runVoiceTurn, type VoiceTurnInput, type VoiceTurnResult } from "@/lib/voice/turn";

/**
 * Media-sidecar protocol (JSON text frames + binary audio frames).
 *
 * Gateway → server:
 *   { type: "start", token, businessId?, calledNumber?, callId?, externalCallId?,
 *     agentId?, language?, voice?, audioMimeType?, utteranceMode?, audio? }
 *     token: the per-call mediaToken delivered via stream/start (preferred;
 *            binds this socket to one call+tenant and wins over any asserted
 *            callId/businessId) — or the legacy static VOICE_MEDIA_TOKEN.
 *            A static token MUST NOT start with "v1." (reserved prefix).
 *     utteranceMode: "gateway" (default, gateway sends utterance-end) |
 *                    "server-vad" (server segments with VAD; requires audio
 *                    { encoding: pcm16|mulaw|alaw, sampleRate: 8000|16000 })
 *   <binary>                              audio chunk (opaque in gateway mode;
 *                                         telephony bytes in server-vad mode)
 *   { type: "audio", seq, ts?, payload }   sequenced audio frame (base64 payload;
 *                                         duplicates dropped, reorder window 32)
 *   { type: "utterance-end", eventId }    run a turn on the buffered audio (gateway mode)
 *   { type: "text", transcript, eventId?, isFinal? }
 *                                         text-topology turn; isFinal=false only
 *                                         acks (partials NEVER run tools)
 *   { type: "barge-in" }                  caller interrupted: supersede the in-flight turn
 *   { type: "ping" }                      → { type: "pong" } (NOT caller speech)
 *   { type: "stop" }                      clean shutdown of the session
 *
 * Server → gateway:
 *   { type: "started", sessionId, utteranceMode }
 *   { type: "agent-audio", eventId, mimeType, audio(base64)|null, audioUrl,
 *     transcript, reply, reprompt?, fallback? }
 *   { type: "turn-complete", eventId, latencyMs, usage }
 *   { type: "turn-superseded", eventId }
 *   { type: "partial-ack", eventId? }
 *   { type: "barge-in-ack", turnSeq, auto?, ignored?, state }
 *   { type: "vad", event: "speech-start"|"speech-end"|"max-utterance" }
 *   { type: "silence-giveup" }
 *   { type: "error", code, message }
 *   { type: "pong" }
 *
 * Large replies (>2 MB audio) send metadata + audioUrl only; the gateway
 * fetches the audio over HTTPS. Utterances are processed strictly one at a
 * time per session; a second utterance while one is in flight is rejected
 * (TURN_IN_PROGRESS) — except server-vad mode, which holds ONE pending
 * utterance so barge-in speech is never lost.
 */

/** Minimal socket surface so the core is testable without a real WebSocket. */
export interface MediaSocket {
  send(data: string | Buffer): void;
  close(code?: number, reason?: string): void;
  readonly readyState: number;
}

export const MediaSocketOpen = 1;

export type CallResolution = { businessId: string; callId: string; agentId: string | null };

/** Persistence seam for session docs (defaults to the Redis store). */
export type SessionHooks = {
  save: (doc: VoiceSessionDoc, ttlSeconds: number) => Promise<void>;
  remove: (sessionId: string) => Promise<void>;
};

export type MediaServerOptions = {
  /**
   * VOICE_MEDIA_TOKEN: HMAC key verifying per-call media tokens (preferred)
   * and the legacy static token accepted for zero-downtime gateway upgrades.
   * Empty = refuse everything. Never sent to gateways by the app.
   */
  token: string;
  turnRunner?: (input: VoiceTurnInput) => Promise<VoiceTurnResult>;
  resolveCall?: (
    businessId: string,
    callId?: string,
    externalCallId?: string,
  ) => Promise<CallResolution | null>;
  /** Called-number -> business routing (defaults to the DB-backed resolver). */
  routeCall?: (calledNumber: string) => Promise<CalledNumberRoute>;
  /** Session-doc persistence (defaults to the Redis store). */
  sessionHooks?: SessionHooks;
  sessionTtlSeconds?: number;
  /** Out-of-turn speech (defaults to real TTS + archival). */
  speakRunner?: (input: SpeakInput) => Promise<SpeakResult>;
  /** VAD thresholds for server-vad mode (defaults to VOICE_VAD_* env). */
  vadConfig?: VadConfig | null;
  /** Max sessions per MediaServer (0/unset = unlimited). */
  maxSessions?: number;
  idleTimeoutMs?: number;
  maxBufferBytes?: number;
  /** Max single audio frame/payload (bytes); larger frames are dropped. */
  maxFrameBytes?: number;
  /** Silence reprompt tuning (null = disabled; the sidecar enables from env). */
  silenceTimeoutMs?: number | null;
  maxReprompts?: number;
  /** Silence-giveup marker (defaults to the DB-backed update). */
  markSilenceGiveup?: (businessId: string, callId: string) => Promise<void>;
};

type ResolvedOpts = Required<
  Pick<MediaServerOptions, "token" | "turnRunner" | "resolveCall" | "routeCall" | "sessionHooks" | "speakRunner" | "markSilenceGiveup">
> &
  Pick<
    MediaServerOptions,
    | "vadConfig"
    | "maxSessions"
    | "sessionTtlSeconds"
    | "idleTimeoutMs"
    | "maxBufferBytes"
    | "maxFrameBytes"
    | "silenceTimeoutMs"
    | "maxReprompts"
  >;

type StartMessage = {
  type: "start";
  token?: string;
  businessId?: string;
  /** Dialled number; routes the tenant when businessId is absent (or must agree). */
  calledNumber?: string;
  callId?: string;
  externalCallId?: string;
  agentId?: string;
  language?: string;
  voice?: string;
  audioMimeType?: string;
  utteranceMode?: string;
  audio?: { encoding?: string; sampleRate?: number };
};

const DEFAULT_IDLE_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_MAX_BUFFER_BYTES = 10 * 1024 * 1024;
const DEFAULT_MAX_FRAME_BYTES = 262_144;
const INLINE_AUDIO_BYTES = 2 * 1024 * 1024;
/** Max held out-of-order frames before the newcomer is dropped. */
const REORDER_WINDOW = 32;

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

/**
 * Record that a session gave up on caller silence. The end-of-call chain
 * (and n8n automations) read `calls.metadata.silenceGiveup` to decide the
 * callback policy — the media layer never invents CRM records itself.
 */
export async function markSilenceGiveupInDb(businessId: string, callId: string): Promise<void> {
  const [row] = await db
    .select({ metadata: calls.metadata })
    .from(calls)
    .where(and(eq(calls.id, callId), eq(calls.businessId, businessId)))
    .limit(1);
  if (!row) return;
  const metadata = { ...((row.metadata as Record<string, unknown> | null) ?? {}) };
  metadata.silenceGiveup = { at: new Date().toISOString() };
  await db.update(calls).set({ metadata }).where(eq(calls.id, callId));
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
  private utteranceMode: "gateway" | "server-vad" = "gateway";
  private negotiatedAudio: AudioFormat | null = null;
  private vad: EnergyVad | null = null;
  private buffer: Buffer[] = [];
  private bufferedBytes = 0;
  private utterancePcm: Buffer[] = [];
  private utterancePcmBytes = 0;
  private heldFrames = new Map<number, Buffer>();
  private heldBytes = 0;
  private maxDeliveredSeq: number | null = null;
  private pendingVad: { audio: Buffer; eventId: string } | null = null;
  private vadUtterances = 0;
  private turnInFlight = false;
  private turnSeq = 0;
  private machine = new TurnStateMachine();
  private doc: VoiceSessionDoc | null = null;
  private saveQueue: Promise<void> = Promise.resolve();
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private silenceTimer: ReturnType<typeof setTimeout> | null = null;
  private repromptInFlight = false;
  private repromptCancelled = false;
  private silenceSeq = 0;

  constructor(
    private readonly socket: MediaSocket,
    private readonly opts: ResolvedOpts,
  ) {
    sessionSeq += 1;
    this.sessionId = `media-${Date.now()}-${sessionSeq}`;
  }

  get turnState(): VoiceTurnState {
    return this.machine.state;
  }

  /** Entry point for every inbound frame. Never throws. */
  async handleMessage(data: string | Buffer): Promise<void> {
    if (this.closed) return;
    this.refreshIdleTimer();
    try {
      if (typeof data !== "string" && Buffer.isBuffer(data)) {
        this.appendBinary(data);
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
    if (this.closed) return;
    this.closed = true;
    this.clearTimers();
    this.releaseAudio();
    logInfo("Media session closed", {
      sessionId: this.sessionId,
      businessId: this.resolution?.businessId,
      callId: this.resolution?.callId,
      operation: "voice.media.close",
      status: "ok",
      state: this.machine.state,
    });
    // Best-effort end marker: the socket is already gone, never block on it.
    if (this.doc) {
      const doc = this.doc;
      this.doc = null;
      void (async () => {
        try {
          this.machine.transition("ENDING");
          this.machine.transition("ENDED");
        } catch {
          // already terminal — the ENDED save below still applies
        }
        try {
          await this.opts.sessionHooks.save(
            { ...doc, state: "ENDED" },
            this.opts.sessionTtlSeconds ?? 600,
          );
        } catch (err) {
          logError("Voice session end-save failed", {
            sessionId: doc.sessionId,
            businessId: doc.businessId,
            callId: doc.callId,
            operation: "voice.media.end",
            status: "error",
            error: err,
          });
        }
      })();
    }
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
    this.clearTimers();
    this.releaseAudio();
    if (this.doc) {
      const doc = this.doc;
      this.doc = null;
      void this.opts.sessionHooks.remove(doc.sessionId).catch((err: unknown) => {
        logWarn("Voice session doc removal failed", {
          sessionId: doc.sessionId,
          businessId: doc.businessId,
          callId: doc.callId,
          operation: "voice.media.remove",
          status: "error",
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }
    try {
      this.socket.close(code, reason);
    } catch {
      // ignore close errors
    }
  }

  private clearTimers(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    if (this.silenceTimer) {
      clearTimeout(this.silenceTimer);
      this.silenceTimer = null;
    }
  }

  private releaseAudio(): void {
    this.buffer = [];
    this.bufferedBytes = 0;
    this.utterancePcm = [];
    this.utterancePcmBytes = 0;
    this.heldFrames.clear();
    this.heldBytes = 0;
    this.pendingVad = null;
    this.vad?.reset();
  }

  private refreshIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    const ms = this.opts.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.idleTimer = setTimeout(() => {
      this.sendError("IDLE_TIMEOUT", "Session idle too long", true);
    }, ms);
    if (typeof this.idleTimer === "object" && "unref" in this.idleTimer) {
      (this.idleTimer as unknown as { unref: () => void }).unref();
    }
  }

  private resetSilenceTimer(): void {
    if (this.silenceTimer) {
      clearTimeout(this.silenceTimer);
      this.silenceTimer = null;
    }
    const ms = this.opts.silenceTimeoutMs ?? null;
    if (ms == null || !this.started || this.closed) return;
    this.silenceTimer = setTimeout(() => {
      this.silenceTimer = null;
      void this.onSilence();
    }, ms);
    if (typeof this.silenceTimer === "object" && "unref" in this.silenceTimer) {
      (this.silenceTimer as unknown as { unref: () => void }).unref();
    }
  }

  /** Move the state machine and persist the doc (saves are serialised). */
  private setState(to: VoiceTurnState): void {
    const transition = this.machine.transition(to); // throws 409 on illegal jumps
    if (this.doc) {
      const doc: VoiceSessionDoc = { ...this.doc, state: transition.to };
      this.doc = doc;
      this.enqueueSave(doc);
    }
  }

  private updateDoc(patch: Partial<VoiceSessionDoc>): void {
    if (!this.doc) return;
    this.doc = { ...this.doc, ...patch };
    this.enqueueSave(this.doc);
  }

  private enqueueSave(doc: VoiceSessionDoc): void {
    const ttl = this.opts.sessionTtlSeconds ?? 600;
    this.saveQueue = this.saveQueue
      .then(() => this.opts.sessionHooks.save(doc, ttl))
      .catch((err: unknown) => {
        // Bookkeeping must never kill a call — but it must never be silent.
        logError("Voice session save failed", {
          sessionId: doc.sessionId,
          businessId: doc.businessId,
          callId: doc.callId,
          operation: "voice.media.save",
          status: "error",
          error: err,
        });
      });
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
      case "audio":
        this.handleAudioFrame(msg);
        break;
      case "utterance-end":
        await this.handleUtteranceEnd(msg);
        break;
      case "text":
        await this.handleText(msg);
        break;
      case "barge-in":
        this.handleBargeIn(false);
        break;
      case "ping":
        this.send({ type: "pong" });
        break;
      case "stop":
        this.send({ type: "stopped", sessionId: this.sessionId });
        try {
          this.setState("ENDING");
          this.setState("ENDED");
        } catch {
          // already terminal; still close below
        }
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
    // Auth: a "v1." token is a per-call credential minted at call-started
    // and verified against this same secret; anything else must equal the
    // legacy static token. Failures are fatal and never echo the token.
    const presented = msg.token ?? "";
    let callClaims: MediaTokenClaims | null = null;
    if (presented.startsWith("v1.")) {
      try {
        callClaims = verifyMediaToken(presented, this.opts.token);
      } catch (err) {
        const reason = err instanceof InvalidMediaToken ? err.reason : "INVALID";
        this.sendError("UNAUTHORIZED", `Invalid media token (${reason})`, true);
        return;
      }
    } else if (!this.opts.token || !safeEqual(presented, this.opts.token)) {
      this.sendError("UNAUTHORIZED", "Invalid media token", true);
      return;
    }
    // Tenant binding: a per-call token fixes the tenant; deterministic
    // called-number routing wins next; an asserted businessId is accepted
    // only when it agrees with both (same rule as the call-started webhook
    // — a call must never enter the wrong agent).
    let businessId = callClaims?.businessId ?? msg.businessId ?? null;
    if (callClaims && msg.businessId && msg.businessId !== callClaims.businessId) {
      this.sendError("TENANT_MISMATCH", "businessId disagrees with media token binding", true);
      return;
    }
    if (msg.calledNumber) {
      const route = await this.opts.routeCall(msg.calledNumber);
      if (!route.ok) {
        this.sendError("UNROUTABLE_NUMBER", `Called number is not routable (${route.reason})`, true);
        return;
      }
      if (businessId && businessId !== route.businessId) {
        this.sendError("TENANT_MISMATCH", "businessId disagrees with called-number routing", true);
        return;
      }
      businessId = route.businessId;
    }
    if (!businessId) {
      this.sendError("INVALID_START", "start requires businessId or calledNumber", true);
      return;
    }
    // Call binding: the token fixes the call row. A gateway asserting a
    // DIFFERENT callId is mixing calls — fail loudly, never coerce.
    if (callClaims && msg.callId && msg.callId !== callClaims.callId) {
      this.sendError("CALL_MISMATCH", "callId disagrees with media token binding", true);
      return;
    }
    const resolution = await this.opts.resolveCall(
      businessId,
      callClaims?.callId ?? msg.callId,
      callClaims?.externalCallId ?? msg.externalCallId,
    );
    if (!resolution) {
      this.sendError("CALL_NOT_FOUND", "Call not found for this business", true);
      return;
    }
    const mode = msg.utteranceMode ?? "gateway";
    if (mode !== "gateway" && mode !== "server-vad") {
      this.sendError("INVALID_START", `Unknown utteranceMode: ${mode}`, true);
      return;
    }
    if (mode === "server-vad") {
      const encoding = msg.audio?.encoding;
      const sampleRate = msg.audio?.sampleRate;
      if (encoding !== "pcm16" && encoding !== "mulaw" && encoding !== "alaw") {
        this.sendError("INVALID_START", "server-vad requires audio.encoding (pcm16|mulaw|alaw)", true);
        return;
      }
      if (sampleRate !== 8000 && sampleRate !== 16000) {
        this.sendError("INVALID_START", "server-vad requires audio.sampleRate (8000|16000)", true);
        return;
      }
      this.negotiatedAudio = { encoding, sampleRate, channels: 1 };
      const vadConfig = this.opts.vadConfig ?? defaultVadConfig(getEnv());
      this.vad = new EnergyVad(vadConfig);
    }
    this.utteranceMode = mode;
    this.resolution = resolution;
    this.agentOverride = msg.agentId;
    this.language = msg.language;
    this.voice = msg.voice;
    this.audioMimeType = msg.audioMimeType;
    this.started = true;
    this.doc = newSessionDoc({
      sessionId: this.sessionId,
      callId: resolution.callId,
      businessId: resolution.businessId,
    });
    this.setState("LISTENING");
    this.resetSilenceTimer();
    logInfo("Media session started", {
      sessionId: this.sessionId,
      businessId: resolution.businessId,
      callId: resolution.callId,
      operation: "voice.media.start",
      status: "ok",
    });
    this.send({ type: "started", sessionId: this.sessionId, utteranceMode: this.utteranceMode });
  }

  private appendBinary(chunk: Buffer): void {
    if (!this.started) {
      this.sendError("NOT_STARTED", "First message must be a valid start frame");
      return;
    }
    const frameCap = this.opts.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES;
    if (chunk.length > frameCap) {
      this.sendError("FRAME_TOO_LARGE", `Audio frame exceeds ${frameCap} bytes; dropped`);
      return;
    }
    this.onSpeechActivity();
    this.deliverAudio(chunk);
  }

  private handleAudioFrame(msg: Record<string, unknown>): void {
    const seq = msg.seq;
    const payload = msg.payload;
    if (typeof seq !== "number" || !Number.isInteger(seq) || seq < 0) {
      this.sendError("INVALID_MESSAGE", "audio requires an integer seq >= 0");
      return;
    }
    if (typeof payload !== "string" || !payload) {
      this.sendError("INVALID_MESSAGE", "audio requires a base64 payload");
      return;
    }
    let bytes: Buffer;
    try {
      bytes = Buffer.from(payload, "base64");
    } catch {
      this.sendError("INVALID_MESSAGE", "audio payload is not valid base64");
      return;
    }
    const frameCap = this.opts.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES;
    if (bytes.length > frameCap) {
      this.sendError("FRAME_TOO_LARGE", `Audio frame exceeds ${frameCap} bytes; dropped`);
      return;
    }
    this.onSpeechActivity();
    if (this.maxDeliveredSeq === null) {
      // First sequenced frame sets the baseline (gateways may start anywhere).
      this.maxDeliveredSeq = seq;
      this.deliverAudio(bytes);
      return;
    }
    if (seq <= this.maxDeliveredSeq) {
      return; // duplicate / late retransmit — drop silently
    }
    if (seq === this.maxDeliveredSeq + 1) {
      this.maxDeliveredSeq = seq;
      this.deliverAudio(bytes);
      this.drainHeld();
      return;
    }
    if (this.heldFrames.size >= REORDER_WINDOW) {
      this.sendError("REORDER_OVERFLOW", "Too many out-of-order frames; frame dropped");
      return;
    }
    if (!this.accountHeld(seq, bytes)) return; // over the buffer cap
    this.heldFrames.set(seq, bytes);
  }

  private drainHeld(): void {
    while (this.maxDeliveredSeq !== null && this.heldFrames.has(this.maxDeliveredSeq + 1)) {
      const next = this.maxDeliveredSeq + 1;
      const bytes = this.heldFrames.get(next) as Buffer;
      this.heldFrames.delete(next);
      this.heldBytes -= bytes.length;
      this.bufferedBytes -= bytes.length;
      this.maxDeliveredSeq = next;
      this.deliverAudio(bytes);
    }
  }

  /** Flush held frames in seq order (gaps are skipped and logged). Used at utterance-end. */
  private flushHeld(): void {
    if (this.heldFrames.size === 0) return;
    const seqs = [...this.heldFrames.keys()].sort((a, b) => a - b);
    const expected = (this.maxDeliveredSeq ?? seqs[0] - 1) + 1;
    if (seqs[0] > expected) {
      logWarn("Media frame gap at utterance-end (skipped)", {
        sessionId: this.sessionId,
        businessId: this.resolution?.businessId,
        callId: this.resolution?.callId,
        operation: "voice.media.gap",
        status: "error",
        error: `missing seq ${expected}..${seqs[0] - 1}`,
      });
    }
    for (const seq of seqs) {
      const bytes = this.heldFrames.get(seq) as Buffer;
      this.heldBytes -= bytes.length;
      this.bufferedBytes -= bytes.length;
      this.maxDeliveredSeq = Math.max(this.maxDeliveredSeq ?? seq, seq);
      this.deliverAudio(bytes);
    }
    this.heldFrames.clear();
    this.heldBytes = 0;
  }

  /** Account held-frame bytes against the buffer cap (false = overflow path taken). */
  private accountHeld(seq: number, bytes: Buffer): boolean {
    void seq;
    const cap = this.opts.maxBufferBytes ?? DEFAULT_MAX_BUFFER_BYTES;
    if (this.bufferedBytes + bytes.length > cap) {
      this.handleOverflow(cap);
      return false;
    }
    this.heldBytes += bytes.length;
    this.bufferedBytes += bytes.length;
    return true;
  }

  /** Caller produced audio: cancel any in-flight reprompt and restart silence. */
  private onSpeechActivity(): void {
    this.repromptCancelled = true;
    this.resetSilenceTimer();
  }

  private deliverAudio(chunk: Buffer): void {
    if (this.utteranceMode === "server-vad") {
      this.deliverVadAudio(chunk);
      return;
    }
    const cap = this.opts.maxBufferBytes ?? DEFAULT_MAX_BUFFER_BYTES;
    if (this.bufferedBytes + chunk.length > cap) {
      this.handleOverflow(cap);
      return;
    }
    this.buffer.push(chunk);
    this.bufferedBytes += chunk.length;
  }

  private handleOverflow(cap: number): void {
    this.buffer = [];
    this.bufferedBytes = 0;
    this.heldFrames.clear();
    this.heldBytes = 0;
    this.utterancePcm = [];
    this.utterancePcmBytes = 0;
    this.sendError("BUFFER_OVERFLOW", `Utterance exceeds ${cap} bytes; buffer cleared`);
  }

  private deliverVadAudio(chunk: Buffer): void {
    const format = this.negotiatedAudio as AudioFormat;
    const vad = this.vad as EnergyVad;
    let pcm: Buffer;
    try {
      pcm = normalizeTelephonyAudio(chunk, format);
    } catch {
      this.sendError("INVALID_MESSAGE", "Audio chunk does not match the negotiated format");
      return;
    }
    const cap = this.opts.maxBufferBytes ?? DEFAULT_MAX_BUFFER_BYTES;
    if (this.utterancePcmBytes + pcm.length > cap) {
      this.handleOverflow(cap);
      return;
    }
    this.utterancePcm.push(pcm);
    this.utterancePcmBytes += pcm.length;
    let events;
    try {
      events = vad.push(pcm);
    } catch {
      this.sendError("INVALID_MESSAGE", "VAD rejected the audio chunk");
      return;
    }
    for (const event of events) {
      this.send({ type: "vad", event });
      if (event === "speech-start") this.onVadSpeechStart();
      else void this.finishVadUtterance();
    }
  }

  /** VAD heard the caller: barge in when the agent holds the floor, else just listen. */
  private onVadSpeechStart(): void {
    logInfo("VAD speech-start", {
      sessionId: this.sessionId,
      businessId: this.resolution?.businessId,
      callId: this.resolution?.callId,
      operation: "voice.media.vad",
      status: "ok",
      state: this.machine.state,
    });
    if (this.machine.state === "SPEAKING" || this.machine.state === "PROCESSING") {
      this.handleBargeIn(true);
    }
  }

  private takeVadAudio(): Buffer {
    const audio = Buffer.concat(this.utterancePcm);
    this.utterancePcm = [];
    this.utterancePcmBytes = 0;
    this.vad?.reset();
    return audio;
  }

  private async finishVadUtterance(): Promise<void> {
    const pcm = this.takeVadAudio();
    if (pcm.length === 0 || this.turnInFlight) {
      if (pcm.length > 0) {
        // Barge-in speech while the superseded turn drains: hold ONE utterance.
        if (this.pendingVad) {
          logWarn("VAD pending overflow (oldest held utterance dropped)", {
            sessionId: this.sessionId,
            businessId: this.resolution?.businessId,
            callId: this.resolution?.callId,
            operation: "voice.media.vad",
            status: "error",
          });
        }
        this.vadUtterances += 1;
        this.pendingVad = { audio: buildWav(pcm, 16000), eventId: `vad-${this.sessionId}-${this.vadUtterances}` };
      }
      return;
    }
    this.vadUtterances += 1;
    const eventId = `vad-${this.sessionId}-${this.vadUtterances}`;
    logInfo("VAD utterance finished", {
      sessionId: this.sessionId,
      businessId: this.resolution?.businessId,
      callId: this.resolution?.callId,
      operation: "voice.media.vad",
      status: "ok",
      eventId,
    });
    await this.runTurn({ audio: buildWav(pcm, 16000), audioMimeType: "audio/wav", eventId });
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
    this.onSpeechActivity();
    this.flushHeld();
    if (this.utteranceMode === "server-vad") {
      // Gateway-assisted boundary in VAD mode: force-finish pending audio.
      const pcm = this.takeVadAudio();
      if (pcm.length === 0) {
        this.sendError("EMPTY_UTTERANCE", "No audio buffered for this utterance");
        return;
      }
      await this.runTurn({ audio: buildWav(pcm, 16000), audioMimeType: "audio/wav", eventId });
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
    // Partials are informational only — they NEVER enter the agent/tool pipeline.
    if (msg.isFinal === false) {
      this.send({ type: "partial-ack", ...(typeof eventId === "string" ? { eventId } : {}) });
      return;
    }
    if (typeof eventId !== "string" || !eventId) {
      this.sendError("INVALID_MESSAGE", "text requires eventId");
      return;
    }
    this.onSpeechActivity();
    await this.runTurn({ transcript: transcript.slice(0, 20000), eventId });
  }

  private handleBargeIn(auto: boolean): void {
    const state = this.machine.state;
    if (state === "SPEAKING" || state === "PROCESSING") {
      // Invalidate the in-flight turn: its audio is discarded on completion.
      this.turnSeq += 1;
      try {
        this.setState("INTERRUPTED");
      } catch {
        // already moved (e.g. double barge-in) — the seq bump still applies
      }
      if (this.doc) this.updateDoc({ interruptions: this.doc.interruptions + 1 });
      this.send({ type: "barge-in-ack", turnSeq: this.turnSeq, ...(auto ? { auto: true } : {}) });
      logInfo("Caller barge-in", {
        sessionId: this.sessionId,
        businessId: this.resolution?.businessId,
        callId: this.resolution?.callId,
        operation: "voice.media.barge-in",
        status: "ok",
        turnSeq: this.turnSeq,
        auto,
      });
      return;
    }
    this.send({ type: "barge-in-ack", turnSeq: this.turnSeq, ignored: true, state });
    logInfo("Caller barge-in ignored", {
      sessionId: this.sessionId,
      businessId: this.resolution?.businessId,
      callId: this.resolution?.callId,
      operation: "voice.media.barge-in",
      status: "ignored",
      state,
    });
  }

  private async runTurn(input: { audio?: Buffer; audioMimeType?: string; transcript?: string; eventId: string }): Promise<void> {
    if (this.turnInFlight) {
      this.sendError("TURN_IN_PROGRESS", "Finish the current utterance before starting another");
      return;
    }
    try {
      this.setState("PROCESSING");
    } catch {
      this.sendError("TURN_REJECTED", `Cannot start a turn while ${this.machine.state}`);
      return;
    }
    const resolution = this.resolution as CallResolution;
    this.turnInFlight = true;
    const seq = this.turnSeq;
    const requestId = `${this.sessionId}-t${seq}-${Date.now()}`;
    this.updateDoc({ turnId: requestId, turnSeq: seq, utterances: (this.doc?.utterances ?? 0) + 1 });
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
        if (!this.closed) {
          this.send({ type: "turn-superseded", eventId: input.eventId });
          try {
            this.setState("LISTENING");
          } catch {
            // e.g. already ENDING — shutdown owns the state now
          }
        }
        return;
      }
      if (result.duplicate) {
        try {
          this.setState("LISTENING");
        } catch { /* terminal race */ }
        this.send({ type: "turn-complete", eventId: input.eventId, duplicate: true });
        return;
      }
      if (!result.heard) {
        try {
          this.setState("LISTENING");
        } catch { /* terminal race */ }
        this.send({ type: "turn-complete", eventId: input.eventId, heard: false });
        return;
      }
      try {
        this.setState("SPEAKING");
      } catch { /* terminal race — still deliver the audio below */ }
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
      try {
        this.setState("LISTENING");
      } catch { /* terminal race */ }
      this.resetSilenceTimer();
    } catch (err) {
      // Technical detail stays server-side; the caller hears a safe fallback.
      logWarn("Media turn failed", {
        requestId,
        sessionId: this.sessionId,
        businessId: resolution.businessId,
        callId: resolution.callId,
        operation: "voice.media.turn",
        status: "error",
        eventId: input.eventId,
        error: err instanceof Error ? err.message : String(err),
      });
      try {
        this.setState("ERROR");
      } catch { /* terminal race */ }
      await this.speakFallback(input.eventId, TURN_FAILURE_FALLBACK);
      try {
        this.setState("LISTENING");
      } catch { /* terminal race */ }
      this.send({ type: "error", code: "TURN_FAILED", message: "turn_failed", eventId: input.eventId });
      this.resetSilenceTimer();
    } finally {
      this.turnInFlight = false;
      // Drain ONE held VAD utterance (barge-in speech that arrived mid-turn).
      if (this.pendingVad && !this.closed && this.started) {
        const pending = this.pendingVad;
        this.pendingVad = null;
        await this.runTurn({ audio: pending.audio, audioMimeType: "audio/wav", eventId: pending.eventId });
      }
    }
  }

  /** Speak a fixed string outside any turn (reprompts, failure fallback). */
  private async speakFixed(text: string, requestId: string): Promise<SpeakResult | null> {
    const resolution = this.resolution as CallResolution;
    try {
      return await this.opts.speakRunner({
        businessId: resolution.businessId,
        callId: resolution.callId,
        text,
        voice: this.voice,
        requestId,
      });
    } catch (err) {
      logWarn("Out-of-turn speech failed", {
        requestId,
        sessionId: this.sessionId,
        businessId: resolution.businessId,
        callId: resolution.callId,
        operation: "voice.media.speak",
        status: "error",
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  private sendSpokenAudio(
    eventId: string,
    speech: SpeakResult,
    flag: "reprompt" | "fallback",
    extra?: Record<string, unknown>,
  ): void {
    const inline = speech.audio.length <= INLINE_AUDIO_BYTES ? speech.audio.toString("base64") : null;
    this.send({
      type: "agent-audio",
      eventId,
      mimeType: speech.mimeType,
      audio: inline,
      audioUrl: speech.audioUrl,
      transcript: "",
      reply: "",
      [flag]: true,
      ...extra,
    });
  }

  private async speakFallback(eventId: string, text: string): Promise<void> {
    const speech = await this.speakFixed(text, `${this.sessionId}-fallback-${Date.now()}`);
    if (speech && !this.closed) this.sendSpokenAudio(eventId, speech, "fallback");
  }

  private async onSilence(): Promise<void> {
    if (this.closed || !this.started) return;
    // Only nudge a session that is actually waiting for the caller.
    if (this.machine.state !== "LISTENING" || this.repromptInFlight) {
      this.resetSilenceTimer();
      return;
    }
    const maxReprompts = this.opts.maxReprompts ?? 2;
    const reprompts = this.doc?.reprompts ?? 0;
    if (reprompts >= maxReprompts) {
      await this.giveUpOnSilence();
      return;
    }
    this.repromptInFlight = true;
    this.repromptCancelled = false;
    this.silenceSeq += 1;
    const eventId = `silence-${this.sessionId}-${this.silenceSeq}`;
    try {
      const speech = await this.speakFixed(SILENCE_NUDGE, eventId);
      if (this.closed || this.repromptCancelled || !speech) return; // caller spoke (or left): stay quiet
      this.sendSpokenAudio(eventId, speech, "reprompt");
      if (this.doc) this.updateDoc({ reprompts: this.doc.reprompts + 1 });
      logInfo("Voice silence reprompt spoken", {
        sessionId: this.sessionId,
        businessId: this.resolution?.businessId,
        callId: this.resolution?.callId,
        operation: "voice.media.reprompt",
        status: "ok",
      });
    } finally {
      this.repromptInFlight = false;
      this.resetSilenceTimer();
    }
  }

  private async giveUpOnSilence(): Promise<void> {
    this.silenceSeq += 1;
    const eventId = `silence-${this.sessionId}-${this.silenceSeq}-final`;
    const speech = await this.speakFixed(SILENCE_FINAL, eventId);
    if (!this.closed && speech && !this.repromptCancelled) {
      this.sendSpokenAudio(eventId, speech, "reprompt", { final: true });
    }
    this.send({ type: "silence-giveup" });
    const resolution = this.resolution as CallResolution;
    try {
      await this.opts.markSilenceGiveup(resolution.businessId, resolution.callId);
    } catch (err) {
      logWarn("Silence-giveup marker failed", {
        sessionId: this.sessionId,
        businessId: resolution.businessId,
        callId: resolution.callId,
        operation: "voice.media.giveup",
        status: "error",
        error: err instanceof Error ? err.message : String(err),
      });
    }
    logInfo("Voice session gave up on silence", {
      sessionId: this.sessionId,
      businessId: resolution.businessId,
      callId: resolution.callId,
      operation: "voice.media.giveup",
      status: "ok",
    });
    try {
      this.setState("ENDING");
      this.setState("ENDED");
    } catch {
      // already terminal
    }
    this.close(1000, "silence-giveup");
  }
}

export class MediaServer {
  private readonly opts: ResolvedOpts & Pick<MediaServerOptions, "vadConfig" | "maxSessions" | "sessionTtlSeconds" | "idleTimeoutMs" | "maxBufferBytes" | "maxFrameBytes" | "silenceTimeoutMs" | "maxReprompts">;
  private readonly sessions = new Set<MediaSession>();

  constructor(opts: MediaServerOptions) {
    this.opts = {
      token: opts.token,
      turnRunner: opts.turnRunner ?? runVoiceTurn,
      resolveCall: opts.resolveCall ?? resolveCallFromDb,
      routeCall: opts.routeCall ?? resolveBusinessByCalledNumber,
      sessionHooks: opts.sessionHooks ?? {
        save: (doc, ttl) => saveVoiceSession(doc, ttl),
        remove: (sessionId) => deleteVoiceSession(sessionId),
      },
      speakRunner: opts.speakRunner ?? speakText,
      markSilenceGiveup: opts.markSilenceGiveup ?? markSilenceGiveupInDb,
      vadConfig: opts.vadConfig,
      maxSessions: opts.maxSessions,
      sessionTtlSeconds: opts.sessionTtlSeconds,
      idleTimeoutMs: opts.idleTimeoutMs,
      maxBufferBytes: opts.maxBufferBytes,
      maxFrameBytes: opts.maxFrameBytes,
      silenceTimeoutMs: opts.silenceTimeoutMs,
      maxReprompts: opts.maxReprompts,
    };
  }

  /**
   * Attach a new transport socket; returns its session handler.
   * Throws 503 SERVER_FULL when the session cap is reached.
   */
  accept(socket: MediaSocket): MediaSession {
    const cap = this.opts.maxSessions ?? 0;
    if (cap > 0 && this.sessions.size >= cap) {
      throw new AppError(503, "SERVER_FULL", `Media server at capacity (${cap} sessions)`);
    }
    const session = new MediaSession(socket, this.opts);
    this.sessions.add(session);
    return session;
  }

  /** Release a session (call on socket close). */
  release(session: MediaSession): void {
    this.sessions.delete(session);
  }

  /** Close every session (graceful shutdown). */
  closeAll(): void {
    for (const session of [...this.sessions]) {
      try {
        session.handleClose();
      } catch {
        // never let one bad session block shutdown
      }
      this.sessions.delete(session);
    }
  }

  /** Health snapshot: session count + per-state breakdown. */
  snapshot(): { sessions: number; states: Record<string, number> } {
    const states: Record<string, number> = {};
    for (const s of this.sessions) {
      const state = s.turnState;
      states[state] = (states[state] ?? 0) + 1;
    }
    return { sessions: this.sessions.size, states };
  }
}
