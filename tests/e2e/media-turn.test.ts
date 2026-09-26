import fs from "node:fs/promises";
import path from "node:path";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, describe, expect } from "vitest";
import type { STTCapabilities, TTSCapabilities } from "@/lib/providers/capabilities";
import { eq } from "drizzle-orm";
import { closeDb, db } from "@/db";
import { callMessages, calls, customers, leads, usageRecords } from "@/db/schema";
import { computeHmacHex } from "@/lib/security";
import type { ChatCompletionResult, LLMProvider } from "@/lib/providers/llm";
import type { STTProvider, TranscriptionResult } from "@/lib/providers/stt";
import type { SpeechResult, TTSProvider } from "@/lib/providers/tts";
import { MediaServer, MediaSocketOpen, type MediaSocket } from "@/lib/voice/media-server";
import { loadVoiceSession } from "@/lib/voice/session-store";
import { runVoiceTurn } from "@/lib/voice/turn";
import { ensureDbReady, hasTestDatabase, itDb, truncateAll } from "../helpers/db";
import { ensureRedisReady, hasTestRedis } from "../helpers/redis";
import { createAgent, createBusiness, createProperty } from "../helpers/fixtures";
import { POST as callStarted } from "@/app/api/v1/webhooks/voice/call-started/route";
import { POST as callEnded } from "@/app/api/v1/webhooks/voice/call-ended/route";

const runIntegration = hasTestDatabase() && hasTestRedis();
const SECRET = "dev-webhook-secret";
const TOKEN = "e2e-media-token";
let keySeq = 0;

function post(body: unknown, path: string): NextRequest {
  const raw = JSON.stringify(body);
  return new NextRequest(
    new Request(`http://localhost${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-webhook-signature": computeHmacHex(SECRET, raw),
        "x-idempotency-key": `e2e-media-${Date.now()}-${keySeq++}`,
      },
      body: raw,
    }),
  );
}

class FakeSocket implements MediaSocket {
  sent: string[] = [];
  closed: { code?: number; reason?: string } | null = null;
  readyState = MediaSocketOpen;
  send(data: string | Buffer): void {
    this.sent.push(data.toString());
  }
  close(code?: number, reason?: string): void {
    this.closed = { code, reason };
  }
  messages(): Array<Record<string, unknown>> {
    return this.sent.map((s) => JSON.parse(s) as Record<string, unknown>);
  }
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
  private n = 0;
  constructor(private script: string[]) {}
  async transcribe(): Promise<TranscriptionResult> {
    const text = this.script[Math.min(this.n++, this.script.length - 1)];
    return {
      text,
      language: "fa",
      status: "final",
      confidence: 0.99,
      durationSeconds: 2,
      usage: { audioSeconds: 2 },
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

function toolCall(id: string, name: string, args: Record<string, unknown>) {
  return { id, name, arguments: args };
}

/**
 * Phase 3 §40: the full media journey with provider fakes ONLY at the
 * integration boundary. Real: webhook auth, call rows, MediaSession state
 * machine, runVoiceTurn, tool registry, Postgres side effects, Redis turn
 * markers + session docs, usage metering, call completion. No PSTN
 * credential exists in CI, so this is explicitly NOT a real-telephony test.
 */
describe.skipIf(!runIntegration)("e2e: websocket media -> real turns -> real tools", () => {
  let businessId: string;
  let callId: string;

  beforeAll(async () => {
    if (!(await ensureDbReady()) || !(await ensureRedisReady())) return;
    await truncateAll();
    businessId = (await createBusiness("E2E Media Biz")).id;
    await createAgent(businessId);
    await createProperty(businessId, {
      code: "MEDIA-APT-1",
      city: "تهران",
      neighborhood: "سعادت‌آباد",
      bedrooms: 2,
      price: "5000000000",
    });
  });

  afterAll(async () => {
    if (runIntegration) {
      await truncateAll().catch(() => undefined);
      await fs.rm(path.resolve("storage/business", businessId), { recursive: true, force: true }).catch(() => undefined);
      await closeDb();
    }
  });

  itDb("start -> audio turn (real search) -> lead turn (real row) -> end billed", async () => {
    const ext = `e2e-media-${Date.now()}`;
    const started = await callStarted(
      post({ business_id: businessId, external_call_id: ext, phone_number: "09120000000" }, "/api/v1/webhooks/voice/call-started"),
    );
    expect(started.status).toBe(200);
    callId = ((await started.json()) as { callId: string }).callId;

    const stt = new FakeSTT(["یه آپارتمان دو خوابه تو سعادت‌آباد می‌خوام", "سارا محمدی هستم، همین شماره"]);
    const tts = new FakeTTS();
    const llm = new FakeLLM([
      { toolCalls: [toolCall("c1", "search_properties", { city: "تهران", neighborhood: "سعادت‌آباد", bedrooms: 2 })] },
      { content: "یک مورد مناسب در سعادت‌آباد پیدا کردم؛ برای بازدید هماهنگ کنم؟" },
      {
        toolCalls: [
          toolCall("c2", "create_lead", {
            name: "سارا محمدی",
            phone: "09120000000",
            intent: "BUY",
            location: "سعادت‌آباد",
            bedrooms: 2,
          }),
        ],
      },
      { content: "درخواست شما ثبت شد؛ کارشناس ما تماس می‌گیرد." },
    ]);

    const media = new MediaServer({
      token: TOKEN,
      turnRunner: (input) => runVoiceTurn({ ...input, stt, tts, llm }),
    });
    const socket = new FakeSocket();
    const session = media.accept(socket);

    // 1. Start binds the socket to the real call row.
    await session.handleMessage(JSON.stringify({ type: "start", token: TOKEN, businessId, callId }));
    const startedMsg = socket.messages().at(-1) as { type: string; sessionId: string };
    expect(startedMsg.type).toBe("started");
    expect(session.turnState).toBe("LISTENING");
    const doc = await loadVoiceSession(startedMsg.sessionId);
    expect(doc).toMatchObject({ callId, businessId, state: "LISTENING" });

    // 2. Partial text never runs tools (no transcript rows appear).
    await session.handleMessage(JSON.stringify({ type: "text", transcript: "یه آپارتمان دو خو", isFinal: false }));
    expect(socket.messages().at(-1)).toMatchObject({ type: "partial-ack" });
    expect(await db.select().from(callMessages).where(eq(callMessages.callId, callId))).toHaveLength(0);

    // 3. Audio turn: real STT text -> real agent -> REAL property search.
    await session.handleMessage(Buffer.from("utterance-bytes-turn-1"));
    await session.handleMessage(JSON.stringify({ type: "utterance-end", eventId: "m1" }));
    const complete1 = socket.messages().find((m) => m.type === "turn-complete" && m.eventId === "m1");
    expect(complete1).toMatchObject({ latencyMs: expect.anything(), usage: expect.anything() });
    const audio1 = socket.messages().find((m) => m.type === "agent-audio" && m.eventId === "m1");
    expect(audio1).toMatchObject({ transcript: "یه آپارتمان دو خوابه تو سعادت‌آباد می‌خوام" });
    expect(String((audio1 as { reply: string }).reply)).toContain("سعادت‌آباد");

    // 4. Second audio turn: REAL lead row in Postgres.
    await session.handleMessage(Buffer.from("utterance-bytes-turn-2"));
    await session.handleMessage(JSON.stringify({ type: "utterance-end", eventId: "m2" }));
    expect(socket.messages().some((m) => m.type === "turn-complete" && m.eventId === "m2")).toBe(true);
    const leadRows = await db.select().from(leads).where(eq(leads.businessId, businessId));
    expect(leadRows).toHaveLength(1);
    expect(leadRows[0].location).toContain("سعادت‌آباد");
    const customerRows = await db.select().from(customers).where(eq(customers.businessId, businessId));
    expect(customerRows).toHaveLength(1);
    expect(customerRows[0].name).toContain("سارا");
    expect(customerRows[0].phone).toBe("09120000000");

    // 5. Transcript persisted (2 turns x CUSTOMER+AGENT, plus one TOOL outcome
    // row per executed tool for P0-3 idempotent replay), usage metered.
    const transcript = await db.select().from(callMessages).where(eq(callMessages.callId, callId));
    expect(transcript.filter((m) => m.role === "CUSTOMER")).toHaveLength(2);
    expect(transcript.filter((m) => m.role === "AGENT")).toHaveLength(2);
    const toolRows = transcript.filter((m) => m.role === "TOOL");
    expect(toolRows).toHaveLength(2);
    for (const row of toolRows) {
      expect((row.metadata as Record<string, unknown>).outcome).toMatchObject({ status: "SUCCESS" });
    }
    const usage = await db.select().from(usageRecords).where(eq(usageRecords.businessId, businessId));
    const types = usage.map((u) => u.type);
    expect(types).toContain("stt_minutes");
    expect(types).toContain("tts_characters");
    expect(types).toContain("llm_input_tokens");
    expect(types).toContain("llm_output_tokens");

    // 6. Redelivery of the same utterance event is a free duplicate (no double billing).
    const usageBefore = usage.length;
    await session.handleMessage(Buffer.from("utterance-bytes-turn-2-again"));
    await session.handleMessage(JSON.stringify({ type: "utterance-end", eventId: "m2" }));
    expect(socket.messages().at(-1)).toMatchObject({ type: "turn-complete", eventId: "m2", duplicate: true });
    const usageAfter = await db.select().from(usageRecords).where(eq(usageRecords.businessId, businessId));
    expect(usageAfter.length).toBe(usageBefore);

    // 7. Clean stop + call-ended completes the call.
    await session.handleMessage(JSON.stringify({ type: "stop" }));
    expect(socket.closed).toMatchObject({ code: 1000 });
    expect(session.turnState).toBe("ENDED");
    media.release(session);

    const ended = await callEnded(
      post({ business_id: businessId, external_call_id: ext }, "/api/v1/webhooks/voice/call-ended"),
    );
    expect(ended.status).toBe(200);
    const [call] = await db.select().from(calls).where(eq(calls.id, callId)).limit(1);
    expect(call.status).toBe("COMPLETED");
  });
});
