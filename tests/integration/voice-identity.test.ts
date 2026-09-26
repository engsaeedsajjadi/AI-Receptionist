import { NextRequest } from "next/server";
import { afterAll, beforeAll, describe, expect } from "vitest";
import { eq } from "drizzle-orm";
import { closeDb, db } from "@/db";
import { callMessages, calls } from "@/db/schema";
import { computeHmacHex } from "@/lib/security";
import type { LLMProvider, ChatCompletionResult } from "@/lib/providers/llm";
import type { TTSCapabilities } from "@/lib/providers/capabilities";
import type { TTSProvider, SpeechResult } from "@/lib/providers/tts";
import { clearTurnMarker, runVoiceTurn } from "@/lib/voice/turn";
import { POST as transcript } from "@/app/api/v1/webhooks/voice/transcript/route";
import { ensureDbReady, hasTestDatabase, itDb, truncateAll } from "../helpers/db";
import { createAgent, createBusiness } from "../helpers/fixtures";

// In tests VOICE_WEBHOOK_SECRET is unset → env.webhookSecret falls back here.
const SECRET = "dev-webhook-secret";
let keySeq = 0;

function post(body: unknown, path: string): NextRequest {
  const raw = JSON.stringify(body);
  return new NextRequest(
    new Request(`http://localhost${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-webhook-signature": computeHmacHex(SECRET, raw),
        "x-idempotency-key": `voice-ident-${Date.now()}-${keySeq++}`,
      },
      body: raw,
    }),
  );
}

class FakeTTS implements TTSProvider {
  readonly name = "fake";
  readonly capabilities: TTSCapabilities = { supportsStreaming: false, supportsPersian: true, mode: "utterance", formats: ["mp3"], maxCharacters: 4096 };
  async synthesize(text: string): Promise<SpeechResult> {
    return { audio: Buffer.from(`AUDIO:${text}`), mimeType: "audio/mpeg", usage: { characters: text.length }, provider: "fake", model: "fake-tts", voice: "fake-voice" };
  }
}

class FakeLLM implements LLMProvider {
  readonly name = "fake";
  async complete(): Promise<ChatCompletionResult> {
    return {
      content: "پاسخ آزمایشی",
      toolCalls: [],
      finishReason: "stop",
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      model: "fake-llm",
      latencyMs: 1,
    };
  }
}

describe("P0-5 canonical voice identity (single CUSTOMER writer)", () => {
  const runIntegration = hasTestDatabase();

  beforeAll(async () => {
    if (!(await ensureDbReady())) return;
    await truncateAll();
  });

  afterAll(async () => {
    if (runIntegration) {
      await truncateAll().catch(() => undefined);
      await closeDb();
    }
  });

  async function seedCall(businessId: string, suffix: string) {
    const [row] = await db
      .insert(calls)
      .values({ businessId, externalCallId: `ident-${suffix}-${Date.now()}`, phoneNumber: "09123456789", status: "IN_PROGRESS" })
      .returning();
    return row;
  }

  itDb("gateway transcript + voice turn with the same eventId persist ONE customer row", async () => {
    const business = await createBusiness();
    await createAgent(business.id);
    const call = await seedCall(business.id, "both");
    const eventId = `seg-both-${Date.now()}`;
    const text = "سلام دنبال آپارتمان دو خوابه هستم";

    // Path 1: gateway-STT transcript webhook persists the caller segment.
    const r = await transcript(
      post(
        { business_id: business.id, external_call_id: call.externalCallId, transcript: text, role: "CUSTOMER", is_final: true, event_id: eventId },
        "/api/v1/webhooks/voice/transcript",
      ),
    );
    expect(r.status).toBe(200);

    // Path 2: the same utterance runs as a voice turn (media text topology).
    const turn = await runVoiceTurn({
      businessId: business.id,
      callId: call.id,
      eventId,
      transcript: text,
      requestId: `ident-req-${Date.now()}`,
      tts: new FakeTTS(),
      llm: new FakeLLM(),
    });
    expect(turn.duplicate).toBe(false);
    expect(turn.heard).toBe(true);

    const rows = await db.select().from(callMessages).where(eq(callMessages.callId, call.id));
    const customers = rows.filter((m) => m.role === "CUSTOMER");
    const agents = rows.filter((m) => m.role === "AGENT");
    // ONE customer row (the webhook's — the turn's insert collapsed), ONE agent reply.
    expect(customers).toHaveLength(1);
    expect(customers[0].eventId).toBe(eventId);
    expect(agents).toHaveLength(1);
    expect(agents[0].eventId).toBe(`${eventId}:reply`);
  });

  itDb("crash-retry of the same turn collapses both rows (no duplicate agent reply)", async () => {
    const business = await createBusiness();
    await createAgent(business.id);
    const call = await seedCall(business.id, "retry");
    const eventId = `seg-retry-${Date.now()}`;
    const input = {
      businessId: business.id,
      callId: call.id,
      eventId,
      transcript: "سلام قیمت‌ها چطور است",
      requestId: `ident-retry-${Date.now()}`,
      tts: new FakeTTS(),
      llm: new FakeLLM(),
    };
    const first = await runVoiceTurn(input);
    expect(first.duplicate).toBe(false);
    // Simulate crash after persistence but before the marker was honored:
    // the marker exists, so a plain redelivery is a cheap duplicate...
    const redelivery = await runVoiceTurn(input);
    expect(redelivery.duplicate).toBe(true);
    // ...and a retry that lost the marker (crash before redisSet) still
    // collapses onto the same rows instead of duplicating them.
    await clearTurnMarker(call.id, eventId);
    const retry = await runVoiceTurn(input);
    expect(retry.duplicate).toBe(false);

    const rows = await db.select().from(callMessages).where(eq(callMessages.callId, call.id));
    expect(rows.filter((m) => m.role === "CUSTOMER")).toHaveLength(1);
    expect(rows.filter((m) => m.role === "AGENT")).toHaveLength(1);
  });

  itDb("turns without eventId keep legacy NULL identity (playground/adhoc)", async () => {
    const business = await createBusiness();
    await createAgent(business.id);
    const call = await seedCall(business.id, "null");
    await runVoiceTurn({
      businessId: business.id,
      callId: call.id,
      transcript: "سلام",
      requestId: `ident-null-${Date.now()}`,
      tts: new FakeTTS(),
      llm: new FakeLLM(),
    });
    const rows = await db.select().from(callMessages).where(eq(callMessages.callId, call.id));
    expect(rows).toHaveLength(2);
    expect(rows.every((m) => m.eventId === null)).toBe(true);
  });
});
