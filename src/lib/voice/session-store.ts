import { redisDel, redisGet, redisSet } from "@/lib/redis";
import type { VoiceTurnState } from "@/lib/voice/turn-machine";

/**
 * Redis-backed voice session documents (Phase 3 §15).
 *
 * Short-lived distributed state: survives socket reconnects and sidecar
 * restarts. NEVER holds audio bytes (§35) — only small control fields.
 * TTL-bounded (VOICE_SESSION_TIMEOUT_MS): abandoned calls evaporate even
 * if cleanup never runs.
 */

export type VoiceSessionDoc = {
  sessionId: string;
  callId: string;
  businessId: string;
  customerId: string | null;
  state: VoiceTurnState;
  /** Latest turn identity (null before the first turn). */
  turnId: string | null;
  turnSeq: number;
  interruptions: number;
  reprompts: number;
  utterances: number;
  startedAt: string;
  lastActivityAt: string;
};

export function sessionKey(sessionId: string): string {
  return `voice:session:${sessionId}`;
}

export function newSessionDoc(input: {
  sessionId: string;
  callId: string;
  businessId: string;
  customerId?: string | null;
}): VoiceSessionDoc {
  const now = new Date().toISOString();
  return {
    sessionId: input.sessionId,
    callId: input.callId,
    businessId: input.businessId,
    customerId: input.customerId ?? null,
    state: "IDLE",
    turnId: null,
    turnSeq: 0,
    interruptions: 0,
    reprompts: 0,
    utterances: 0,
    startedAt: now,
    lastActivityAt: now,
  };
}

function parseDoc(raw: string): VoiceSessionDoc | null {
  try {
    const doc = JSON.parse(raw) as VoiceSessionDoc;
    if (!doc || typeof doc.sessionId !== "string" || typeof doc.state !== "string") return null;
    return doc;
  } catch {
    return null;
  }
}

export async function loadVoiceSession(sessionId: string): Promise<VoiceSessionDoc | null> {
  const raw = await redisGet(sessionKey(sessionId));
  if (!raw) return null;
  return parseDoc(raw);
}

export async function saveVoiceSession(doc: VoiceSessionDoc, ttlSeconds: number): Promise<void> {
  await redisSet(sessionKey(doc.sessionId), JSON.stringify({ ...doc, lastActivityAt: new Date().toISOString() }), ttlSeconds);
}

export async function deleteVoiceSession(sessionId: string): Promise<void> {
  await redisDel(sessionKey(sessionId));
}
