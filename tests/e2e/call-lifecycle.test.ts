import { NextRequest } from "next/server";
import { afterAll, beforeAll, describe, expect } from "vitest";
import type { STTCapabilities, TTSCapabilities } from "@/lib/providers/capabilities";
import { and, eq } from "drizzle-orm";
import { closeDb, db } from "@/db";
import { appointments, callMessages, calls, notifications, usageRecords } from "@/db/schema";
import { computeHmacHex } from "@/lib/security";
import type { LLMProvider, ChatCompletionResult } from "@/lib/providers/llm";
import type { STTProvider, TranscriptionResult } from "@/lib/providers/stt";
import type { TTSProvider, SpeechResult } from "@/lib/providers/tts";
import { ensureDbReady, hasTestDatabase, itDb, truncateAll } from "../helpers/db";
import { uniqueTestIp } from "../helpers/http";
import { createAgent, createBusiness, createProperty } from "../helpers/fixtures";
import { POST as callStarted } from "@/app/api/v1/webhooks/voice/call-started/route";
import { POST as callEnded } from "@/app/api/v1/webhooks/voice/call-ended/route";

const runIntegration = hasTestDatabase();
// In tests VOICE_WEBHOOK_SECRET is unset → env.webhookSecret falls back here.
const SECRET = "dev-webhook-secret";
let keySeq = 0;
const nextKey = () => `e2e-${Date.now()}-${keySeq++}`;

function post(body: unknown, key: string, path: string): NextRequest {
  const raw = JSON.stringify(body);
  return new NextRequest(
    new Request(`http://localhost${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-webhook-signature": computeHmacHex(SECRET, raw),
        "x-idempotency-key": key,
        "x-real-ip": uniqueTestIp(),
      },
      body: raw,
    }),
  );
}

class FakeTTS implements TTSProvider {
  readonly name = "fake";
  readonly capabilities: TTSCapabilities = {
    supportsStreaming: false,
    supportsPersian: true,
    mode: "utterance",
    formats: ["mp3"],
    maxCharacters: 4096,
  };
  async synthesize(text: string): Promise<SpeechResult> {
    return {
      audio: Buffer.from(`AUDIO:${text}`),
      mimeType: "audio/mpeg",
      usage: { characters: text.length },
      provider: "fake",
      model: "fake-tts",
      voice: "fake-voice",
    };
  }
}

class FakeSTT implements STTProvider {
  readonly name = "fake";
  readonly capabilities: STTCapabilities = {
    supportsStreaming: false,
    supportsPartialTranscripts: false,
    supportsPersian: true,
    mode: "file",
    maxAudioBytes: null,
  };
  async transcribe(): Promise<TranscriptionResult> {
    return {
      text: "unused",
      language: "fa",
      status: "final",
      confidence: 1,
      durationSeconds: 1,
      usage: { audioSeconds: 1 },
      provider: "fake",
      model: "fake-stt",
    };
  }
}

type ScriptStep = { content?: string; toolCalls?: ChatCompletionResult["toolCalls"] };

class FakeLLM implements LLMProvider {
  readonly name = "fake";
  private n = 0;
  constructor(private script: ScriptStep[]) {}
  async complete(): Promise<ChatCompletionResult> {
    const step = this.script[Math.min(this.n++, this.script.length - 1)];
    return {
      content: step.content ?? null,
      toolCalls: step.toolCalls ?? [],
      finishReason: "stop",
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      model: "fake-llm",
      latencyMs: 1,
    };
  }
}

/**
 * Critical E2E: one full voice-call journey across every seam —
 * signed HTTP webhooks (call-started/call-ended) + runVoiceTurn turns with
 * fake providers (the Phase C seam: routes own HTTP/auth/idempotency,
 * runVoiceTurn owns STT→agent→TTS). No PSTN credential exists in CI, so the
 * provider edge stays explicitly faked; everything else is real: Postgres
 * rows, tool execution, usage metering, notifications, idempotency.
 */
describe.skipIf(!runIntegration)("critical E2E: full call journey (real database)", () => {
  const ext = `e2e-call-${Date.now()}`;
  let businessId: string;
  let callId: string;

  beforeAll(async () => {
    if (!(await ensureDbReady())) return;
    await truncateAll();
    businessId = (await createBusiness("E2E Lifecycle Biz")).id;
    await createAgent(businessId);
    await createProperty(businessId, { code: "E2E-APT-1", city: "تهران", neighborhood: "سعادت‌آباد" });
  });

  afterAll(async () => {
    if (runIntegration) {
      await truncateAll().catch(() => undefined);
      await closeDb();
    }
  });

  itDb("call-started → search turn → booking turn → call-ended → billed + notified", async () => {
    const { runVoiceTurn } = await import("@/lib/voice/turn");
    const { checkAvailability } = await import("@/lib/services/appointments");

    // 1. Provider rings: signed call-started creates the call + meters it.
    const started = await callStarted(
      post(
        { business_id: businessId, external_call_id: ext, phone_number: "09123456789" },
        nextKey(),
        "/api/v1/webhooks/voice/call-started",
      ),
    );
    expect(started.status).toBe(200);
    const startedJson = (await started.json()) as { ok: boolean; callId: string; duplicate: boolean };
    expect(startedJson.ok).toBe(true);
    callId = startedJson.callId;
    const [call] = await db.select().from(calls).where(eq(calls.id, callId)).limit(1);
    expect(call.status).toBe("RINGING");

    // 2. Turn 1 — buyer asks; agent REALLY searches listings via the tool.
    const turn1 = await runVoiceTurn({
      businessId,
      callId,
      eventId: `e2e-evt-1-${Date.now()}`,
      transcript: "یه آپارتمان دو خوابه تو سعادت‌آباد می‌خوام",
      requestId: nextKey(),
      stt: new FakeSTT(),
      tts: new FakeTTS(),
      llm: new FakeLLM([
        { toolCalls: [{ id: "e2e-tc-1", name: "search_properties", arguments: { city: "تهران" } }] },
        { content: "یک آپارتمان دو خوابه در سعادت‌آباد برایتان پیدا کردم." },
      ]),
    });
    expect(turn1.duplicate).toBe(false);
    expect(turn1.toolCalls).toEqual([{ tool: "search_properties", status: "SUCCESS" }]);
    expect(turn1.audioStored).toBe(true);

    // 3. Turn 2 — buyer books; agent REALLY books via the tool.
    const date = new Date(Date.now() + 10 * 24 * 3600 * 1000).toISOString().slice(0, 10);
    const avail = await checkAvailability({ businessId, date });
    const slot = avail.slots.find((s) => s.available);
    expect(slot).toBeTruthy();
    const turn2 = await runVoiceTurn({
      businessId,
      callId,
      eventId: `e2e-evt-2-${Date.now()}`,
      transcript: "برای بازدید همان روز رزرو کن",
      requestId: nextKey(),
      stt: new FakeSTT(),
      tts: new FakeTTS(),
      llm: new FakeLLM([
        {
          toolCalls: [
            {
              id: "e2e-tc-2",
              name: "create_appointment",
              arguments: { scheduledAt: slot!.start, durationMinutes: 30 },
            },
          ],
        },
        { content: "بازدید شما رزرو شد." },
      ]),
    });
    expect(turn2.toolCalls).toEqual([{ tool: "create_appointment", status: "SUCCESS" }]);
    const [appt] = await db
      .select()
      .from(appointments)
      .where(and(eq(appointments.businessId, businessId), eq(appointments.scheduledAt, new Date(slot!.start))));
    expect(appt?.status).toBe("SCHEDULED");

    // 4. Transcript persisted across both turns (customer + agent each).
    const messages = await db.select().from(callMessages).where(eq(callMessages.callId, callId));
    expect(messages.length).toBeGreaterThanOrEqual(4);

    // 5. Provider hangs up: signed call-ended completes + bills (no summary
    // payload and no LLM configured → summary stays honestly empty).
    const endedKey = nextKey();
    const ended = await callEnded(
      post(
        { business_id: businessId, external_call_id: ext, duration_seconds: 180, status: "COMPLETED" },
        endedKey,
        "/api/v1/webhooks/voice/call-ended",
      ),
    );
    expect(ended.status).toBe(200);
    const [done] = await db.select().from(calls).where(eq(calls.id, callId)).limit(1);
    expect(done.status).toBe("COMPLETED");
    expect(done.durationSeconds).toBe(180);
    expect(done.summary).toBeNull();

    const usage = await db.select().from(usageRecords).where(eq(usageRecords.businessId, businessId));
    const byType = new Map(usage.map((u) => [u.type, u]));
    expect(byType.has("calls")).toBe(true);
    expect(byType.has("tts_characters")).toBe(true);
    expect(byType.has("llm_input_tokens")).toBe(true);
    const minutes = byType.get("voice_minutes");
    expect(minutes).toBeTruthy();
    expect(Number(minutes!.quantity)).toBeCloseTo(3.0, 5);

    // 6. Completion notification recorded on the default internal channel
    // (dashboard inbox): SENT with the row itself as the delivery proof.
    const [notif] = await db
      .select()
      .from(notifications)
      .where(and(eq(notifications.businessId, businessId), eq(notifications.type, "call_completed")))
      .limit(1);
    expect(notif).toBeTruthy();
    expect(notif.channel).toBe("internal");
    expect(notif.status).toBe("SENT");
    expect(notif.sentAt).toBeTruthy();

    // 7. Redelivered call-ended bills nothing twice.
    const replay = await callEnded(
      post(
        { business_id: businessId, external_call_id: ext, duration_seconds: 180, status: "COMPLETED" },
        endedKey,
        "/api/v1/webhooks/voice/call-ended",
      ),
    );
    expect(replay.status).toBe(200);
    expect(((await replay.json()) as { duplicate: boolean }).duplicate).toBe(true);
    const minutesAfter = await db
      .select()
      .from(usageRecords)
      .where(and(eq(usageRecords.businessId, businessId), eq(usageRecords.type, "voice_minutes")));
    expect(minutesAfter).toHaveLength(1);
  });

  itDb("call-ended for an unknown call is 404 (no cross-tenant completion)", async () => {
    const res = await callEnded(
      post(
        { business_id: businessId, external_call_id: `nope-${Date.now()}`, duration_seconds: 10 },
        nextKey(),
        "/api/v1/webhooks/voice/call-ended",
      ),
    );
    expect(res.status).toBe(404);
  });
});
