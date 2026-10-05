import { afterEach, describe, expect, it, vi } from "vitest";
import { closeRedis } from "@/lib/redis";
import { resetEnvCache } from "@/lib/env";
import {
  ConsoleNotificationProvider,
  EmailNotificationProvider,
  InternalNotificationProvider,
  SmsWebhookProvider,
  TelegramNotificationProvider,
  getNotificationProvider,
} from "@/lib/providers/notifications";
import { CompatibleSTTProvider, DevSTTProvider, OpenAISTTProvider, getSTTProvider } from "@/lib/providers/stt";
import { CompatibleTTSProvider, DevTTSProvider, OpenAITTSProvider, getTTSProvider } from "@/lib/providers/tts";
import { CompatibleEmbeddingProvider, DevEmbeddingProvider, OpenAIEmbeddingProvider, getEmbeddingProvider } from "@/lib/providers/embeddings";
import { CompatibleLLMProvider, DevLLMProvider, OpenAIProvider, getLLMProvider } from "@/lib/providers/llm";
import { HttpReranker, LexicalReranker, rerankWithFallback, rerankerFromEnv } from "@/lib/providers/reranker";

const ENV_SNAPSHOT = new Map<string, string | undefined>();
const stubEnv = (key: string, value: string) => {
  if (!ENV_SNAPSHOT.has(key)) ENV_SNAPSHOT.set(key, process.env[key]);
  process.env[key] = value;
  resetEnvCache();
};
afterEach(async () => {
  vi.unstubAllGlobals();
  for (const [key, value] of ENV_SNAPSHOT) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  ENV_SNAPSHOT.clear();
  resetEnvCache();
  await closeRedis();
});

describe("notification provider factory", () => {
  it("selects the provider for each channel", () => {
    expect(getNotificationProvider("email")).toBeInstanceOf(EmailNotificationProvider);
    expect(getNotificationProvider("sms")).toBeInstanceOf(SmsWebhookProvider);
    expect(getNotificationProvider("telegram")).toBeInstanceOf(TelegramNotificationProvider);
    expect(getNotificationProvider("internal")).toBeInstanceOf(InternalNotificationProvider);
  });

  it("fails loudly instead of pretending to deliver when SMTP is missing", async () => {
    stubEnv("SMTP_HOST", "");
    stubEnv("SMTP_USER", "");
    stubEnv("SMTP_PASS", "");
    const result = await new EmailNotificationProvider().send({ to: "ops@example.com", subject: "s", body: "b", businessId: crypto.randomUUID() });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/SMTP is not configured/);
  });

  it("reports the missing SMS gateway and Telegram credentials without throwing", async () => {
    stubEnv("SMS_WEBHOOK_URL", "");
    stubEnv("TELEGRAM_BOT_TOKEN", "");
    expect(await new SmsWebhookProvider().send({ to: "+989120000000", body: "خبر", businessId: crypto.randomUUID() })).toEqual({
      ok: false,
      error: "SMS_WEBHOOK_URL is not configured",
    });
    stubEnv("TELEGRAM_BOT_TOKEN", "token-1");
    stubEnv("TELEGRAM_DEFAULT_CHAT_ID", "");
    expect(await new TelegramNotificationProvider().send({ to: "", body: "خبر" })).toEqual({ ok: false, error: "missing_telegram_chat_id" });
  });

  it("surfaces a provider HTTP failure and a network failure as a non-ok result", async () => {
    stubEnv("SMS_WEBHOOK_URL", "https://sms.example.com/send");
    stubEnv("SMS_API_KEY", "sms-key");
    vi.stubGlobal("fetch", vi.fn(async () => new Response("gateway exploded", { status: 502 })));
    const sms = await new SmsWebhookProvider().send({ to: "+989120000000", body: "خبر" });
    expect(sms.ok).toBe(false);
    expect(sms.error).toContain("sms_gateway_http_502");

    stubEnv("TELEGRAM_BOT_TOKEN", "token-1");
    stubEnv("TELEGRAM_DEFAULT_CHAT_ID", "12345");
    vi.stubGlobal("fetch", vi.fn(async () => new Response("bad request", { status: 400 })));
    const telegram = await new TelegramNotificationProvider().send({ to: "12345", subject: "s", body: "b" });
    expect(telegram.ok).toBe(false);
    expect(telegram.error).toContain("telegram_http_400");

    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("socket hang up");
    }));
    const offline = await new TelegramNotificationProvider().send({ to: "12345", body: "b" });
    expect(offline.ok).toBe(false);
    expect(offline.error).toContain("socket hang up");
  });

  it("delivers through the gateway when it answers 2xx", async () => {
    stubEnv("SMS_WEBHOOK_URL", "https://sms.example.com/send");
    stubEnv("SMS_SENDER", "1000");
    const fetchMock = vi.fn<typeof fetch>(async () => new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    expect(await new SmsWebhookProvider().send({ to: "+989120000000", body: "خبر", businessId: crypto.randomUUID() })).toEqual({ ok: true });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://sms.example.com/send");
    expect(JSON.parse(String(init?.body))).toMatchObject({ to: "+989120000000", text: "خبر", sender: "1000" });
    stubEnv("TELEGRAM_BOT_TOKEN", "token-1");
    vi.stubGlobal("fetch", vi.fn(async () => new Response("ok", { status: 200 })));
    expect(await new TelegramNotificationProvider().send({ to: "12345", body: "خبر" })).toEqual({ ok: true });
  });

  it("treats an internal notification without a recipient as a failure", async () => {
    const provider = new InternalNotificationProvider();
    expect(await provider.send({ to: "", body: "b" })).toEqual({ ok: false, error: "missing_recipient" });
    expect(await provider.send({ to: "user-1", body: "b" })).toMatchObject({ ok: true });
    expect(await provider.send({ to: "", body: "b", businessId: crypto.randomUUID() })).toMatchObject({ ok: true });
    expect(provider.channel).toBe("internal");
  });

  it("constructs the dev console provider outside production", async () => {
    const provider = new ConsoleNotificationProvider();
    expect(provider.channel).toBe("internal");
    expect(await provider.send({ to: "dev", subject: "s", body: "b" })).toMatchObject({ ok: true });
  });
});

describe("AI provider factories", () => {
  it("keeps the development providers inert: they refuse instead of fabricating output", async () => {
    stubEnv("STT_PROVIDER", "dev");
    stubEnv("TTS_PROVIDER", "dev");
    stubEnv("EMBEDDING_PROVIDER", "dev");
    stubEnv("LLM_PROVIDER", "dev");
    expect(getSTTProvider()).toBeInstanceOf(DevSTTProvider);
    expect(getTTSProvider()).toBeInstanceOf(DevTTSProvider);
    expect(getEmbeddingProvider()).toBeInstanceOf(DevEmbeddingProvider);
    expect(getLLMProvider()).toBeInstanceOf(DevLLMProvider);
    await expect(getSTTProvider().transcribe(Buffer.from("audio"), {})).rejects.toThrow(/STT provider is not configured/);
    await expect(getTTSProvider().synthesize("سلام")).rejects.toThrow(/TTS provider is not configured/);
    await expect(getEmbeddingProvider().embed("متن")).rejects.toThrow(/Embedding provider is not configured/);
    await expect(getEmbeddingProvider().embedMany(["متن"])).rejects.toThrow(/Embedding provider is not configured/);
    await expect(getLLMProvider().complete([{ role: "user", content: "سلام" }])).rejects.toThrow(/LLM provider is not configured/);
  });

  it("wires the compatible providers from the deployment environment", () => {
    stubEnv("STT_PROVIDER", "compatible");
    stubEnv("TTS_PROVIDER", "compatible");
    stubEnv("EMBEDDING_PROVIDER", "compatible");
    stubEnv("LLM_PROVIDER", "compatible");
    stubEnv("COMPATIBLE_LLM_BASE_URL", "https://llm.example.com/v1");
    stubEnv("COMPATIBLE_LLM_API_KEY", "key");
    stubEnv("COMPATIBLE_LLM_MODEL", "gpt-oss-compatible");
    expect(getSTTProvider()).toBeInstanceOf(CompatibleSTTProvider);
    expect(getTTSProvider()).toBeInstanceOf(CompatibleTTSProvider);
    expect(getEmbeddingProvider()).toBeInstanceOf(CompatibleEmbeddingProvider);
    expect(getLLMProvider()).toBeInstanceOf(CompatibleLLMProvider);
  });

  it("requires credentials before constructing a cloud provider", () => {
    for (const key of ["STT_PROVIDER", "TTS_PROVIDER", "EMBEDDING_PROVIDER", "LLM_PROVIDER"]) stubEnv(key, "openai");
    stubEnv("OPENAI_API_KEY", "");
    expect(() => getSTTProvider()).toThrow(/OPENAI_API_KEY/);
    expect(() => getTTSProvider()).toThrow(/OPENAI_API_KEY/);
    expect(() => getEmbeddingProvider()).toThrow(/OPENAI_API_KEY/);
    expect(() => getLLMProvider()).toThrow(/OPENAI_API_KEY/);
    expect(() => new CompatibleSTTProvider({ baseURL: "", apiKey: "key" })).toThrow(/COMPATIBLE_LLM_BASE_URL/);
    expect(new OpenAISTTProvider({ apiKey: "sk-test" }).name).toBe("openai");
    expect(new OpenAITTSProvider({ apiKey: "sk-test" }).name).toBe("openai");
    expect(new OpenAIEmbeddingProvider({ apiKey: "sk-test" }).name).toBe("openai");
    expect(new OpenAIProvider({ apiKey: "sk-test" }).name).toBe("openai");
  });
});

describe("reranker selection and degradation", () => {
  const candidate = (content: string, score: number) => ({
    id: crypto.randomUUID(),
    documentId: crypto.randomUUID(),
    content,
    score,
  });
  const candidates = [candidate("کمیسیون فروش دو درصد است", 0.9), candidate("ساعات کاری دفتر نه تا هجده", 0.8), candidate("پارکینگ اختصاصی دارد", 0.7)];

  it("returns no provider unless one is configured, and falls back to the RRF order", async () => {
    stubEnv("RERANK_PROVIDER", "none");
    expect(rerankerFromEnv()).toBeNull();
    const result = await rerankWithFallback({ query: "کمیسیون", candidates, topN: 2 });
    expect(result).toMatchObject({ provider: "rrf", model: null, usedFallback: true, costUsd: null, latencyMs: 0 });
    expect(result.candidates.map((c) => c.content)).toEqual(["کمیسیون فروش دو درصد است", "ساعات کاری دفتر نه تا هجده"]);
    // An explicitly configured provider is honoured even with no env.
    const explicit = await rerankWithFallback({ query: "کمیسیون", candidates, provider: new LexicalReranker(), topN: 1 });
    expect(explicit.provider).toBe("lexical");
    expect(explicit.model).toBe("lexical-overlap-v1");
    expect(explicit.usedFallback).toBe(false);
    expect(explicit.candidates[0].content).toContain("کمیسیون");
    // No candidates ⇒ nothing to rerank, and no provider call is made.
    const empty = await rerankWithFallback({ query: "کمیسیون", candidates: [], provider: new LexicalReranker() });
    expect(empty.usedFallback).toBe(false);
    expect(empty.candidates).toEqual([]);
  });

  it("ranks lexically without any network call, keeping the input set closed", async () => {
    const ranked = await new LexicalReranker().rerank("ساعات کاری", candidates, { topN: 2 });
    expect(ranked).toHaveLength(2);
    expect(ranked[0].content).toContain("ساعات کاری");
    const ids = new Set(candidates.map((c) => c.id));
    for (const item of ranked) expect(ids.has(item.id)).toBe(true); // never introduces a document
    expect(await new LexicalReranker().rerank("", candidates)).toHaveLength(3);
    expect(new LexicalReranker().model).toBe("lexical-overlap-v1");
    expect(await rerankWithFallback({ query: "x", candidates, provider: new LexicalReranker(), topN: 0 })).toBeTruthy();
  });

  it("requires a base URL for the HTTP reranker and never constructs it silently", () => {
    expect(() => new HttpReranker({ baseURL: "" })).toThrow(/RERANK_BASE_URL is not configured/);
    stubEnv("RERANK_PROVIDER", "lexical");
    expect(rerankerFromEnv()).toBeInstanceOf(LexicalReranker);
    stubEnv("RERANK_PROVIDER", "http");
    stubEnv("RERANK_BASE_URL", "https://rerank.example.com/");
    expect(rerankerFromEnv()).toBeInstanceOf(HttpReranker);
    expect(String(rerankerFromEnv()!.model)).toBeTruthy();
  });

  it("reorders from the provider payload and refuses malformed payloads", async () => {
    stubEnv("RERANK_PROVIDER", "http");
    stubEnv("RERANK_BASE_URL", "https://rerank.example.com");
    stubEnv("RERANK_API_KEY", "key");
    stubEnv("RERANK_MODEL", "rerank-live-1");
    const fetchMock = vi.fn<typeof fetch>(async () =>
      new Response(JSON.stringify({ results: [{ index: 1, relevance_score: 0.99 }, { index: 0, relevance_score: 0.01 }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const reranked = await rerankWithFallback({ query: "ساعات کاری", candidates });
    expect(reranked.provider).toBe("http");
    expect(reranked.model).toBe("rerank-live-1");
    expect(reranked.candidates[0].content).toContain("ساعات کاری");
    expect(reranked.candidates).toHaveLength(2); // candidates the provider did not score are dropped, never invented
    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse(String(init?.body))).toMatchObject({ model: "rerank-live-1", query: "ساعات کاری" });
    expect((init?.headers as Record<string, string>).Authorization).toMatch(/^Bearer /);

    // A malformed payload, an out-of-range score or an empty result set all
    // degrade to the RRF ordering rather than emptying the evidence set.
    for (const payload of [{ results: [{ index: 0, relevance_score: "high" }] }, { results: "nope" }, {}, { results: [] }]) {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } })),
      );
      const fallback = await rerankWithFallback({ query: "q", candidates });
      expect(fallback.usedFallback).toBe(true);
      expect(fallback.provider).toBe("rrf");
    }
  });

  it("falls back to the RRF order when the reranker fails or times out", async () => {
    stubEnv("RERANK_PROVIDER", "http");
    stubEnv("RERANK_BASE_URL", "https://rerank.example.com");
    vi.stubGlobal("fetch", vi.fn(async () => new Response("boom", { status: 500 })));
    const failed = await rerankWithFallback({ query: "کمیسیون", candidates, topN: 1 });
    expect(failed).toMatchObject({ provider: "rrf", usedFallback: true, model: null });
    expect(failed.candidates).toHaveLength(1);

    vi.stubGlobal("fetch", vi.fn(async () => {
      const err = new Error("The operation was aborted");
      err.name = "AbortError";
      throw err;
    }));
    const aborted = await rerankWithFallback({ query: "کمیسیون", candidates });
    expect(aborted.usedFallback).toBe(true);
  });
});
