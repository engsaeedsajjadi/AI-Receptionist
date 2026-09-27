import { NextRequest } from "next/server";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { callMessages, calls, usageRecords } from "@/db/schema";
import { computeHmacHex } from "@/lib/security";
import type { LLMProvider, ChatCompletionResult } from "@/lib/providers/llm";
import type { STTProvider, TranscriptionResult } from "@/lib/providers/stt";
import type { TTSProvider, SpeechResult } from "@/lib/providers/tts";
import { runVoiceTurn } from "@/lib/voice/turn";
import { ensureDbReady, hasTestDatabase, itDb, truncateAll } from "../helpers/db";
import { createAgent, createBusiness } from "../helpers/fixtures";
import { POST as audioWebhook } from "@/app/api/v1/webhooks/voice/audio/route";

const SECRET = "dev-webhook-secret";
let keySeq = 0;
const nextKey = () => `vt-${Date.now()}-${keySeq++}`;
const createdBusinessIds: string[] = [];

// ---------------------------------------------------------------------------
// Fake providers (deterministic, in-process — these test OUR pipeline, not the
// vendors; live-provider verification stays explicitly BLOCKED without creds).
// ---------------------------------------------------------------------------

class FakeSTT implements STTProvider {
  readonly name = "fake";
  calls = 0;
  constructor(private text: string, private duration = 3) {}
  async transcribe(): Promise<TranscriptionResult> {
    this.calls++;
    return {
      text: this.text,
      language: "fa",
      status: "final",
      confidence: 0.99,
      durationSeconds: this.duration,
      usage: { audioSeconds: this.duration },
      provider: "fake",
      model: "fake-stt",
    };
  }
}

class FakeTTS implements TTSProvider {
  readonly name = "fake";
  calls = 0;
  async synthesize(text: string): Promise<SpeechResult> {
    this.calls++;
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

type ScriptStep = { content?: string; toolCalls?: ChatCompletionResult["toolCalls"] };

class FakeLLM implements LLMProvider {
  readonly name = "fake";
  calls = 0;
  constructor(private script: ScriptStep[]) {}
  async complete(): Promise<ChatCompletionResult> {
    const step = this.script[Math.min(this.calls++, this.script.length - 1)];
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

async function seedCall(businessId: string, externalCallId: string, agentId?: string) {
  const [row] = await db
    .insert(calls)
    .values({ businessId, externalCallId, phoneNumber: "09123456789", status: "IN_PROGRESS", agentId: agentId ?? null })
    .returning();
  return row;
}

function signedJson(body: unknown, key: string): NextRequest {
  const raw = JSON.stringify(body);
  return new NextRequest(
    new Request("http://localhost/api/v1/webhooks/voice/audio", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-webhook-signature": computeHmacHex(SECRET, raw),
        "x-idempotency-key": key,
      },
      body: raw,
    }),
  );
}

/** Build a multipart request with a FIXED boundary so we can HMAC the exact bytes. */
function signedMultipart(fields: Record<string, string>, audio: { bytes: Buffer; filename: string } | null, key: string): NextRequest {
  const boundary = "TESTBOUNDARY123";
  const parts: Buffer[] = [];
  for (const [k, v] of Object.entries(fields)) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  }
  if (audio) {
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="audio"; filename="${audio.filename}"\r\nContent-Type: audio/mpeg\r\n\r\n`,
      ),
    );
    parts.push(audio.bytes);
    parts.push(Buffer.from("\r\n"));
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  const body = Buffer.concat(parts);
  return new NextRequest(
    new Request("http://localhost/api/v1/webhooks/voice/audio", {
      method: "POST",
      headers: {
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
        "x-webhook-signature": computeHmacHex(SECRET, body),
        "x-idempotency-key": key,
      },
      body: body as unknown as BodyInit,
    }),
  );
}

describe.skipIf(!hasTestDatabase())("voice turn pipeline (real database, fake providers)", () => {
  beforeAll(async () => {
    if (!(await ensureDbReady())) return;
    await truncateAll();
  });
  beforeEach(async () => {
    if (!(await ensureDbReady())) return;
    await truncateAll();
  });
  afterAll(async () => {
    // Remove archived test reply audio from local storage.
    for (const id of createdBusinessIds) {
      await fs.rm(path.resolve("storage/business", id), { recursive: true, force: true }).catch(() => undefined);
    }
  });

  async function setup(name: string) {
    const business = await createBusiness(`${name} ${Date.now()}`);
    createdBusinessIds.push(business.id);
    const agent = await createAgent(business.id);
    const call = await seedCall(business.id, `ext-${Date.now()}-${Math.random().toString(36).slice(2)}`, agent.id);
    return { business, agent, call };
  }

  itDb("audio → STT → agent → TTS → archived audio + usage + transcript", async () => {
    const { business, agent, call } = await setup("Voice Biz");
    const stt = new FakeSTT("سلام، یه آپارتمان دو خوابه می‌خوام");
    const tts = new FakeTTS();
    const llm = new FakeLLM([{ content: "سلام! حتماً کمکتون می‌کنم. بودجه‌تون چقدره؟" }]);

    const result = await runVoiceTurn({
      businessId: business.id,
      agentId: agent.id,
      callId: call.id,
      audio: Buffer.from("fake-audio-bytes"),
      audioMimeType: "audio/mpeg",
      eventId: `evt-${Date.now()}`,
      requestId: `req-${Date.now()}`,
      actor: "test",
      stt,
      tts,
      llm,
    });

    expect(result.duplicate).toBe(false);
    expect(result.heard).toBe(true);
    expect(result.transcript).toBe("سلام، یه آپارتمان دو خوابه می‌خوام");
    expect(result.reply).toContain("بودجه");
    expect(result.audio?.toString().startsWith("AUDIO:")).toBe(true);
    expect(result.audioUrl).toContain("/api/v1/files/");
    expect(result.audioStored).toBe(true);
    expect(result.latencyMs.total).toBeGreaterThanOrEqual(0);
    expect(result.latencyMs.stt).toBeDefined();
    expect(result.latencyMs.agent).toBeDefined();
    expect(result.latencyMs.tts).toBeDefined();
    expect(result.usage).toMatchObject({ sttMinutes: 0.05, llmInputTokens: 10, llmOutputTokens: 5 });
    expect(result.usage.ttsCharacters).toBeGreaterThan(0);

    // Transcript persisted (normalized customer + agent messages).
    const messages = await db.select().from(callMessages).where(eq(callMessages.callId, call.id));
    expect(messages.map((m) => m.role).sort()).toEqual(["AGENT", "CUSTOMER"]);

    // Usage ledger rows (idempotent keys, no double counting).
    const usage = await db.select().from(usageRecords).where(eq(usageRecords.businessId, business.id));
    const types = usage.map((u) => u.type).sort();
    expect(types).toEqual(["llm_input_tokens", "llm_output_tokens", "stt_minutes", "tts_characters"]);
  });

  itDb("transcript input skips STT but still runs agent + TTS", async () => {
    const { business, agent, call } = await setup("Voice Biz T");
    const stt = new FakeSTT("نباید صدا شود");
    const tts = new FakeTTS();
    const llm = new FakeLLM([{ content: "پاسخ متنی" }]);

    const result = await runVoiceTurn({
      businessId: business.id,
      agentId: agent.id,
      callId: call.id,
      transcript: "متن آماده دروازه",
      eventId: `evt-${Date.now()}-t`,
      requestId: `req-${Date.now()}-t`,
      stt,
      tts,
      llm,
    });

    expect(result.heard).toBe(true);
    expect(result.transcript).toBe("متن آماده دروازه");
    expect(stt.calls).toBe(0);
    expect(tts.calls).toBe(1);
    const usage = await db.select().from(usageRecords).where(eq(usageRecords.businessId, business.id));
    expect(usage.map((u) => u.type)).not.toContain("stt_minutes");
  });

  itDb("runs real tool calls inside the turn", async () => {
    const { business, agent, call } = await setup("Voice Biz Tools");
    const llm = new FakeLLM([
      { toolCalls: [{ id: "tc-1", name: "get_business_info", arguments: {} }] },
      { content: "اطلاعات کسب‌وکار را بررسی کردم." },
    ]);

    const result = await runVoiceTurn({
      businessId: business.id,
      agentId: agent.id,
      callId: call.id,
      transcript: "ساعات کاری؟",
      eventId: `evt-${Date.now()}-tools`,
      requestId: `req-${Date.now()}-tools`,
      stt: new FakeSTT("x"),
      tts: new FakeTTS(),
      llm,
    });

    expect(result.toolCalls).toEqual([{ tool: "get_business_info", status: "SUCCESS" }]);
    expect(llm.calls).toBe(2);
  });

  itDb("empty STT result is honest no-speech (no agent, no TTS)", async () => {
    const { business, agent, call } = await setup("Voice Biz Silence");
    const tts = new FakeTTS();
    const llm = new FakeLLM([{ content: "نباید برسد" }]);

    const result = await runVoiceTurn({
      businessId: business.id,
      agentId: agent.id,
      callId: call.id,
      audio: Buffer.from("silence"),
      eventId: `evt-${Date.now()}-silence`,
      requestId: `req-${Date.now()}-silence`,
      stt: new FakeSTT("   "),
      tts,
      llm,
    });

    expect(result.heard).toBe(false);
    expect(result.reply).toBe("");
    expect(result.audio).toBeNull();
    expect(tts.calls).toBe(0);
    expect(llm.calls).toBe(0);
  });

  itDb("redelivered event returns duplicate without re-running", async () => {
    const { business, agent, call } = await setup("Voice Biz Dup");
    const eventId = `evt-${Date.now()}-dup`;
    const base = {
      businessId: business.id,
      agentId: agent.id,
      callId: call.id,
      transcript: "سلام مجدد",
      eventId,
      requestId: `req-${Date.now()}-dup`,
    };
    const first = await runVoiceTurn({ ...base, stt: new FakeSTT("x"), tts: new FakeTTS(), llm: new FakeLLM([{ content: "اول" }]) });
    expect(first.duplicate).toBe(false);
    const tts2 = new FakeTTS();
    const llm2 = new FakeLLM([{ content: "دوم" }]);
    const second = await runVoiceTurn({ ...base, stt: new FakeSTT("x"), tts: tts2, llm: llm2 });
    expect(second.duplicate).toBe(true);
    expect(tts2.calls).toBe(0);
    expect(llm2.calls).toBe(0);

    const usage = await db
      .select()
      .from(usageRecords)
      .where(and(eq(usageRecords.businessId, business.id), eq(usageRecords.type, "tts_characters")));
    expect(usage).toHaveLength(1);
  });

  itDb("audio webhook rejects invalid signatures", async () => {
    const req = new NextRequest(
      new Request("http://localhost/api/v1/webhooks/voice/audio", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-webhook-signature": "bad", "x-idempotency-key": nextKey() },
        body: JSON.stringify({ a: 1 }),
      }),
    );
    const res = await audioWebhook(req);
    expect(res.status).toBe(401);
  });

  itDb("audio webhook fails honestly when providers are unconfigured", async () => {
    const { business, call } = await setup("Voice Biz Uncfg");
    const res = await audioWebhook(
      signedJson(
        { business_id: business.id, external_call_id: call.externalCallId, transcript: "سلام", event_id: `e-${Date.now()}` },
        nextKey(),
      ),
    );
    // No fake success: dev providers throw, route surfaces 503.
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("PROVIDER_NOT_CONFIGURED");
  });

  itDb("audio webhook validates multipart uploads", async () => {
    const { business, call } = await setup("Voice Biz MP");
    const fields = { business_id: business.id, external_call_id: call.externalCallId as string };
    const missing = await audioWebhook(signedMultipart(fields, null, nextKey()));
    expect(missing.status).toBe(400);

    // Valid multipart parses and then fails honestly at STT (dev provider).
    const parsed = await audioWebhook(
      signedMultipart(fields, { bytes: Buffer.from("fake-audio"), filename: "a.mp3" }, nextKey()),
    );
    expect(parsed.status).toBe(503);
  });
});
