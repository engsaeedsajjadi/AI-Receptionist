import { NextRequest } from "next/server";
import { afterAll, beforeAll, describe, expect } from "vitest";
import { and, eq } from "drizzle-orm";
import { closeDb, db } from "@/db";
import { appointments, calls } from "@/db/schema";
import {
  acquireLock,
  closeRedis,
  getRedis,
  redisDel,
  redisGet,
  redisIncr,
  setNx,
} from "@/lib/redis";
import type { LLMProvider, ChatCompletionResult } from "@/lib/providers/llm";
import type { STTProvider, TranscriptionResult } from "@/lib/providers/stt";
import type { TTSProvider, SpeechResult } from "@/lib/providers/tts";
import { ensureDbReady, hasTestDatabase, truncateAll } from "../helpers/db";
import { ensureRedisReady, hasTestRedis, itRedis } from "../helpers/redis";
import { createAgent, createBusiness } from "../helpers/fixtures";

const runRedis = hasTestRedis();
const runDb = hasTestDatabase();
const tag = `e2e-${Date.now()}`;
let seq = 0;
const key = (name: string) => `test:${tag}:${seq++}:${name}`;

class FakeSTT implements STTProvider {
  readonly name = "fake";
  calls = 0;
  async transcribe(): Promise<TranscriptionResult> {
    this.calls++;
    return {
      text: "سلام",
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

class FakeLLM implements LLMProvider {
  readonly name = "fake";
  calls = 0;
  async complete(): Promise<ChatCompletionResult> {
    this.calls++;
    return {
      content: "سلام، چطور می‌توانم کمک کنم؟",
      toolCalls: [],
      finishReason: "stop",
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      model: "fake-llm",
      latencyMs: 1,
    };
  }
}

describe.skipIf(!runRedis)("redis E2E (real server, no fallback)", () => {
  beforeAll(async () => {
    if (!(await ensureRedisReady())) return;
    // Prove we are on the REAL client: with REDIS_URL set, getRedis()
    // must return a live connection, never the in-memory fallback.
    const client = getRedis();
    expect(client).not.toBeNull();
    await expect(client!.ping()).resolves.toBe("PONG");
  });

  afterAll(async () => {
    if (runRedis) await closeRedis();
  });

  itRedis("setNx is exclusive: first writer wins until delete", async () => {
    const k = key("nx");
    await redisDel(k);
    expect(await setNx(k, "a", 60)).toBe(true);
    expect(await setNx(k, "b", 60)).toBe(false);
    expect(await redisGet(k)).toBe("a");
    await redisDel(k);
    expect(await setNx(k, "b", 60)).toBe(true);
    await redisDel(k);
  });

  itRedis("redisIncr counts with a TTL (fixed-window primitive)", async () => {
    const k = key("incr");
    await redisDel(k);
    expect(await redisIncr(k, 60)).toBe(1);
    expect(await redisIncr(k, 60)).toBe(2);
    expect(await redisIncr(k, 60)).toBe(3);
    const ttl = await getRedis()!.ttl(k);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(60);
    await redisDel(k);
  });

  itRedis("acquireLock grants mutual exclusion and releases ownership", async () => {
    const k = key("lock");
    await redisDel(`lock:${k}`);
    const releaseA = await acquireLock(k, 30);
    expect(releaseA).not.toBeNull();
    // Second contender fails while A holds the lock.
    expect(await acquireLock(k, 30)).toBeNull();
    // Crash safety: the lock key carries a TTL.
    expect(await getRedis()!.ttl(`lock:${k}`)).toBeGreaterThan(0);
    await releaseA!();
    // After release, acquisition succeeds again.
    const releaseB = await acquireLock(k, 30);
    expect(releaseB).not.toBeNull();
    await releaseB!();
  });

  itRedis("rate limiter trips 429 over real Redis counters", async () => {
    const { enforceRateLimit } = await import("@/lib/rate-limit");
    const req = new NextRequest("http://localhost/api/test");
    const scope = key("rl-login"); // login preset: 5 per 60s
    for (let i = 0; i < 5; i++) {
      const info = await enforceRateLimit(req, "login", scope);
      expect(info.remaining).toBe(4 - i);
    }
    await expect(enforceRateLimit(req, "login", scope)).rejects.toMatchObject({
      status: 429,
      code: "RATE_LIMITED",
    });
  });
});

describe.skipIf(!runRedis || !runDb)("redis E2E with database (real server + real PG)", () => {
  let businessId: string;

  beforeAll(async () => {
    if (!(await ensureRedisReady()) || !(await ensureDbReady())) return;
    await truncateAll();
    businessId = (await createBusiness("Redis E2E Biz")).id;
    await createAgent(businessId);
  });

  afterAll(async () => {
    if (runRedis && runDb) {
      await truncateAll().catch(() => undefined);
      await closeDb();
      await closeRedis();
    }
  });

  itRedis("concurrent booking race: exactly one wins (lock + constraint)", async () => {
    if (!(await ensureDbReady())) return;
    const { checkAvailability, createAppointment } = await import("@/lib/services/appointments");
    const date = new Date(Date.now() + 9 * 24 * 3600 * 1000).toISOString().slice(0, 10);
    const avail = await checkAvailability({ businessId, date });
    const slot = avail.slots.find((s) => s.available);
    expect(slot).toBeTruthy();

    const attempts = await Promise.allSettled([
      createAppointment(businessId, { scheduledAt: slot!.start, durationMinutes: 30 }),
      createAppointment(businessId, { scheduledAt: slot!.start, durationMinutes: 30 }),
    ]);
    const won = attempts.filter((a) => a.status === "fulfilled");
    const lost = attempts.filter((a) => a.status === "rejected");
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    expect((lost[0] as PromiseRejectedResult).reason).toMatchObject({ code: "APPOINTMENT_CONFLICT" });

    const rows = await db
      .select({ id: appointments.id })
      .from(appointments)
      .where(and(eq(appointments.businessId, businessId), eq(appointments.scheduledAt, new Date(slot!.start))));
    expect(rows).toHaveLength(1);
  });

  itRedis("voice-turn marker in real Redis suppresses redelivery work", async () => {
    if (!(await ensureDbReady())) return;
    const { runVoiceTurn } = await import("@/lib/voice/turn");
    const [call] = await db
      .insert(calls)
      .values({ businessId, externalCallId: `redis-e2e-${tag}`, phoneNumber: "09123456789", status: "IN_PROGRESS" })
      .returning();
    const stt = new FakeSTT();
    const tts = new FakeTTS();
    const llm = new FakeLLM();
    const eventId = `evt-${tag}-1`;

    const first = await runVoiceTurn({
      businessId,
      callId: call.id,
      eventId,
      audio: Buffer.from("RIFF....fake-wav"),
      audioMimeType: "audio/wav",
      requestId: `redis-e2e-1-${tag}`,
      stt,
      tts,
      llm,
    });
    expect(first.duplicate).toBe(false);
    expect(stt.calls).toBe(1);
    expect(llm.calls).toBe(1);
    // The completion marker lives in REAL Redis (not the process fallback).
    expect(await redisGet(`voice:turn-done:${call.id}:${eventId}`)).toBe("done");

    const replay = await runVoiceTurn({
      businessId,
      callId: call.id,
      eventId,
      audio: Buffer.from("RIFF....fake-wav"),
      audioMimeType: "audio/wav",
      requestId: `redis-e2e-2-${tag}`,
      stt,
      tts,
      llm,
    });
    expect(replay.duplicate).toBe(true);
    expect(stt.calls).toBe(1);
    expect(tts.calls).toBe(1);
    expect(llm.calls).toBe(1);
  });
});
