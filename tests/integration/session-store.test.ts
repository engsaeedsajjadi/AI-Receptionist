import { describe, expect } from "vitest";
import {
  deleteVoiceSession,
  loadVoiceSession,
  newSessionDoc,
  saveVoiceSession,
} from "@/lib/voice/session-store";
import { ensureRedisReady, hasTestRedis, itRedis } from "../helpers/redis";

describe.skipIf(!hasTestRedis())("voice session store (real redis)", () => {
  itRedis("round-trips a session doc and refreshes activity", async () => {
    if (!(await ensureRedisReady())) return;
    const doc = newSessionDoc({ sessionId: `s-${Date.now()}`, callId: "call-1", businessId: "biz-1" });
    expect(doc.state).toBe("IDLE");
    await saveVoiceSession(doc, 60);
    const loaded = await loadVoiceSession(doc.sessionId);
    expect(loaded).toMatchObject({ sessionId: doc.sessionId, callId: "call-1", businessId: "biz-1" });
    expect(loaded?.customerId).toBeNull();

    await saveVoiceSession({ ...doc, state: "LISTENING", turnSeq: 3 }, 60);
    const updated = await loadVoiceSession(doc.sessionId);
    expect(updated).toMatchObject({ state: "LISTENING", turnSeq: 3 });

    await deleteVoiceSession(doc.sessionId);
    expect(await loadVoiceSession(doc.sessionId)).toBeNull();
  });

  itRedis("missing sessions load as null (never throws)", async () => {
    if (!(await ensureRedisReady())) return;
    expect(await loadVoiceSession(`nope-${Date.now()}`)).toBeNull();
  });
});
