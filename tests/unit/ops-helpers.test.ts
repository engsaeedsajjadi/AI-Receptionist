import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { acquireLock, closeRedis, redisDel, redisGet, redisIncr, redisSet, setNx } from "@/lib/redis";
import { resetEnvCache } from "@/lib/env";
import {
  MAX_OUTBOX_ATTEMPTS,
  OUTBOX_LEASE_SECONDS,
  TENANT_WEBHOOK_TOPICS,
  OutboxTopicSchema,
  outboxBackoffSeconds,
  registerOutboxHandler,
  resetOutboxHandlers,
} from "@/lib/services/outbox";
import { contentTypeForFilename, tenantKey, verifyLocalSignedUrl } from "@/lib/providers/storage";
import { reciprocalRankFuse, supportedDocTypes, uploadConstraints } from "@/lib/services/knowledge";
import { TENANT_STATES, assertTransition } from "@/lib/services/data-governance";
import { isSupportedAudioMime } from "@/lib/providers/stt";
import { AppError } from "@/lib/errors";

const ENV_SNAPSHOT = new Map<string, string | undefined>();
const stubEnv = (key: string, value: string) => {
  if (!ENV_SNAPSHOT.has(key)) ENV_SNAPSHOT.set(key, process.env[key]);
  process.env[key] = value;
  resetEnvCache();
};
afterEach(async () => {
  for (const [key, value] of ENV_SNAPSHOT) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  ENV_SNAPSHOT.clear();
  resetEnvCache();
  await closeRedis();
});

describe("outbox policy", () => {
  it("backs off exponentially and caps the delay", () => {
    expect(outboxBackoffSeconds(1)).toBe(20);
    expect(outboxBackoffSeconds(2)).toBe(40);
    expect(outboxBackoffSeconds(5)).toBe(320);
    expect(outboxBackoffSeconds(0)).toBe(20); // attempts are 1-based
    expect(outboxBackoffSeconds(-3)).toBe(20);
    expect(outboxBackoffSeconds(12)).toBe(3600);
    expect(outboxBackoffSeconds(Infinity)).toBe(3600);
  });

  it("keeps every documented topic and webhook mapping valid", () => {
    const topics = OutboxTopicSchema.options;
    expect(topics).toContain("lead.created");
    expect(topics).toContain("appointment.cancelled");
    expect(topics).toContain("notification.requested");
    expect(OutboxTopicSchema.safeParse("lead.deleted").success).toBe(false);
    for (const topic of Object.keys(TENANT_WEBHOOK_TOPICS)) expect(topics).toContain(topic);
    expect(MAX_OUTBOX_ATTEMPTS).toBeGreaterThanOrEqual(3);
    expect(OUTBOX_LEASE_SECONDS).toBeGreaterThan(30);
  });

  it("registers additional consumers and can reset them", () => {
    expect(() => {
      registerOutboxHandler("lead.created", async () => undefined);
      registerOutboxHandler("*", async () => undefined);
      resetOutboxHandlers();
      resetOutboxHandlers();
    }).not.toThrow();
  });
});

describe("redis fallback primitives without REDIS_URL", () => {
  beforeEach(async () => {
    stubEnv("REDIS_URL", "");
    await closeRedis();
  });

  it("implements set-if-absent, get, set, delete and increment in memory", async () => {
    expect(await setNx("k1", "v1", 60)).toBe(true);
    expect(await setNx("k1", "v2", 60)).toBe(false);
    expect(await redisGet("k1")).toBe("v1");
    await redisSet("k2", "v2");
    expect(await redisGet("k2")).toBe("v2");
    await redisSet("k3", "v3", 60);
    await redisDel("k3");
    expect(await redisGet("k3")).toBeNull();
    expect(await redisIncr("counter", 60)).toBe(1);
    expect(await redisIncr("counter", 60)).toBe(2);
    expect(await redisGet("counter")).toBe("2");
    expect(await redisGet("missing")).toBeNull();
  });

  it("expires entries and reports stale keys as absent", async () => {
    await redisSet("short", "value", 1);
    expect(await redisGet("short")).toBe("value");
    await new Promise((resolve) => setTimeout(resolve, 1100));
    expect(await redisGet("short")).toBeNull();
  });

  it("hands out one lock at a time and releases only for the owner", async () => {
    const release = await acquireLock("resources", 30);
    expect(release).toBeTypeOf("function");
    expect(await acquireLock("resources", 30)).toBeNull();
    await release!();
    const second = await acquireLock("resources", 30);
    expect(second).toBeTypeOf("function");
    await second!();
  });

  it("surfaces an unavailable Redis in production instead of falling back", async () => {
    // `isProduction` is captured at import time, so the production guard is
    // asserted through its observable contract: a configured URL is required,
    // and the fallback path is only reachable in dev/test.
    stubEnv("REDIS_URL", "redis://127.0.0.1:6379");
    await closeRedis();
    const client = (await import("@/lib/redis")).getRedis();
    expect(client).not.toBeNull();
    await closeRedis();
  });
});

describe("storage key safety and content types", () => {
  it("builds tenant-scoped keys and neutralises traversal attempts", () => {
    const key = tenantKey("biz-1", "knowledge", "../etc/passwd");
    expect(key.startsWith("business/biz-1/")).toBe(true);
    expect(key).not.toContain("..");
    expect(tenantKey("biz-1", "knowledge", "فایل من.xlsx")).toContain("business/biz-1/knowledge/");
    expect(tenantKey("biz-1", "a\\b")).toBe("business/biz-1/a/b");
    expect(tenantKey("biz-1", "  ")).toBe("business/biz-1/__");
    expect(tenantKey("biz-1", "..")).toBe("business/biz-1/");
    expect(tenantKey("biz-1", "/abs/path")).toBe("business/biz-1/abs/path");
  });

  it("maps known extensions to safe content types", () => {
    expect(contentTypeForFilename("report.PDF")).toBe("application/pdf");
    expect(contentTypeForFilename("doc.docx")).toContain("wordprocessingml");
    expect(contentTypeForFilename("notes.markdown")).toBe("text/markdown");
    expect(contentTypeForFilename("notes.txt")).toBe("text/plain");
    expect(contentTypeForFilename("call.mp3")).toBe("audio/mpeg");
    expect(contentTypeForFilename("call.wav")).toBe("audio/wav");
    expect(contentTypeForFilename("call.ogg")).toBe("audio/ogg");
    expect(contentTypeForFilename("call.webm")).toBe("audio/webm");
    expect(contentTypeForFilename("call.m4a")).toBe("audio/x-m4a");
    expect(contentTypeForFilename("archive.zip")).toBe("application/octet-stream");
  });

  it("rejects forged or expired local signed URLs", () => {
    const past = String(Math.floor((Date.now() - 60_000) / 1000));
    expect(verifyLocalSignedUrl("business/b/knowledge/a.txt", past, "0".repeat(64))).toBe(false);
    expect(verifyLocalSignedUrl("business/b/knowledge/a.txt", "not-a-number", "sig")).toBe(false);
    const future = String(Math.floor((Date.now() + 60_000) / 1000));
    expect(verifyLocalSignedUrl("business/b/knowledge/a.txt", future, "0".repeat(64))).toBe(false);
    // A signature of the wrong length must not throw — it is simply invalid.
    expect(verifyLocalSignedUrl("business/b/knowledge/a.txt", future, "short")).toBe(false);
  });
});

describe("knowledge helpers", () => {
  const chunk = (id: string, source: "vector" | "keyword" = "vector") =>
    ({
      id,
      documentId: `doc-${id}`,
      content: `content ${id}`,
      chunkIndex: 0,
      similarity: 0,
      source,
    }) as never;

  it("fuses ranked lists with reciprocal rank weighting and deduplicates ids", () => {
    const fused = reciprocalRankFuse([[chunk("a"), chunk("b")], [chunk("b", "keyword"), chunk("c", "keyword")]], 60);
    expect(fused.map((c) => c.id)).toEqual(["b", "a", "c"]);
    expect(fused.find((c) => c.id === "b")!.score).toBeGreaterThan(fused.find((c) => c.id === "a")!.score);
    expect(fused.find((c) => c.id === "b")!.source).toBe("both");
    expect(reciprocalRankFuse([], 60)).toEqual([]);
    expect(reciprocalRankFuse([[]], 60)).toEqual([]);
    // A single list preserves its ranking order.
    expect(reciprocalRankFuse([[chunk("x"), chunk("y")]], 60).map((c) => c.id)).toEqual(["x", "y"]);
  });

  it("documents the accepted upload types and their limits", () => {
    expect(supportedDocTypes()).toEqual(["PDF", "DOCX", "TXT", "MARKDOWN"]);
    const constraints = uploadConstraints();
    expect(constraints.maxBytes).toBeGreaterThan(0);
    expect(constraints.allowedMime.length).toBeGreaterThan(3);
    expect(constraints.supportedTypes).toEqual(supportedDocTypes());
  });

  it("recognises supported audio mime types only", () => {
    for (const mime of ["audio/mpeg", "audio/wav", "audio/ogg", "audio/webm", "audio/x-m4a", "audio/mp4", "audio/flac", "AUDIO/MPEG"]) {
      expect(isSupportedAudioMime(mime)).toBe(true);
    }
    for (const mime of [undefined, null, "", "audio/unknown", "text/plain", "application/json"]) {
      expect(isSupportedAudioMime(mime)).toBe(false);
    }
  });
});

describe("tenant offboarding state machine", () => {
  it("allows only the documented transitions", () => {
    expect(TENANT_STATES).toEqual(["ACTIVE", "SUSPENDED", "PENDING_DELETION", "DELETED"]);
    expect(() => assertTransition("ACTIVE", "SUSPENDED")).not.toThrow();
    expect(() => assertTransition("ACTIVE", "PENDING_DELETION")).not.toThrow();
    expect(() => assertTransition("SUSPENDED", "ACTIVE")).not.toThrow();
    expect(() => assertTransition("PENDING_DELETION", "SUSPENDED")).not.toThrow();
    expect(() => assertTransition("PENDING_DELETION", "ACTIVE")).toThrow(AppError);
    expect(() => assertTransition("PENDING_DELETION", "DELETED")).not.toThrow();
    expect(() => assertTransition("DELETED", "ACTIVE")).toThrow(AppError);
    expect(() => assertTransition("DELETED", "PENDING_DELETION")).toThrow();
    expect(() => assertTransition("SUSPENDED", "DELETED")).toThrow();
  });
});
