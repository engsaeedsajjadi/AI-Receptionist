import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { beforeAll, beforeEach, afterAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { OpenAIProvider, CompatibleLLMProvider } from "@/lib/providers/llm";
import { OpenAIEmbeddingProvider, CompatibleEmbeddingProvider } from "@/lib/providers/embeddings";
import { OpenAISTTProvider, CompatibleSTTProvider, isSupportedAudioMime } from "@/lib/providers/stt";
import { OpenAITTSProvider, CompatibleTTSProvider } from "@/lib/providers/tts";
import { mapSdkError, providerErrorFromStatus } from "@/lib/providers/types";

type RequestRecord = { url: string; body: string; authorization?: string; contentType?: string };
let server: Server, baseURL: string;
let requests: RequestRecord[] = [];
let reply: unknown, status = 200;
const completion = (content: string | null = "سلام") => ({ id: "test-response", object: "chat.completion", model: "contract-model", choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }], usage: { prompt_tokens: 11, completion_tokens: 4, total_tokens: 15 } });
const vector = (values: number[]) => Buffer.from(new Float32Array(values).buffer).toString("base64");
const options = () => ({ apiKey: "test-fixture-key", baseURL, model: "contract-model", timeoutMs: 2000, maxRetries: 0 });
beforeAll(async () => {
  server = createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const part of req) chunks.push(Buffer.from(part));
    requests.push({ url: req.url ?? "", body: Buffer.concat(chunks).toString(), authorization: req.headers.authorization, contentType: req.headers["content-type"] });
    res.writeHead(status, { "Content-Type": Buffer.isBuffer(reply) ? "audio/mpeg" : "application/json" });
    res.end(Buffer.isBuffer(reply) ? reply : JSON.stringify(reply));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});
beforeEach(() => { requests = []; status = 200; reply = completion(); });
afterAll(async () => { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); });

describe.each([OpenAIProvider, CompatibleLLMProvider])("chat HTTP contract %s", Provider => {
  it("preserves tool IDs/signatures, schema and model controls without leaking internal context", async () => {
    reply = { ...completion(null), choices: [{ message: { content: null, tool_calls: [
      { id: "call1", type: "function", function: { name: "search_knowledge", arguments: '{"query":"سلام"}' }, extra_content: { google: { thought_signature: "signed-thought" } } },
      { id: "call2", type: "function", function: { name: "invalid", arguments: "{broken" } },
      { id: "call3", type: "custom", custom: { name: "not-a-function", input: "x" } },
    ] }, finish_reason: "tool_calls" }] };
    const result = await new Provider(options()).complete([
      { role: "system", content: "Use evidence" }, { role: "user", content: "سلام" },
      { role: "assistant", content: "", toolCalls: [{ id: "previous", name: "search_knowledge", arguments: "{}", thoughtSignature: "previous-signature" }] },
      { role: "tool", content: "evidence", toolCallId: "previous" },
    ], { model: "selected-model", temperature: 0.7, maxTokens: 17, toolChoice: "required", tools: [{ name: "search_knowledge", description: "lookup", parameters: { type: "object" } }], responseFormat: { name: "answer", schema: { type: "object" } }, businessId: "internal-tenant", callId: "internal-call", requestId: "internal-request" });
    expect(requests).toHaveLength(1); expect(requests[0].url).toBe("/v1/chat/completions");
    expect(requests[0].authorization).toBe("Bearer test-fixture-key");
    const body = JSON.parse(requests[0].body);
    expect(body).toMatchObject({ model: "selected-model", temperature: 0.7, max_tokens: 17, tool_choice: "required", response_format: { json_schema: { strict: true } } });
    expect(body.messages[2]).toMatchObject({ content: null, tool_calls: [{ id: "previous", extra_content: { google: { thought_signature: "previous-signature" } } }] });
    expect(body.messages[3]).toMatchObject({ tool_call_id: "previous" });
    expect(requests[0].body).not.toContain("internal-");
    expect(result.toolCalls).toEqual([{ id: "call1", name: "search_knowledge", arguments: { query: "سلام" }, thoughtSignature: "signed-thought" }, { id: "call2", name: "invalid", arguments: { _raw: "{broken" }, thoughtSignature: undefined }]);
    expect(result.usage).toEqual({ inputTokens: 11, outputTokens: 4, totalTokens: 15 });
  });
  it("keeps missing usage unknown and empty choices empty", async () => {
    reply = { choices: [], model: "" };
    const result = await new Provider(options()).complete([{ role: "user", content: "test" }]);
    expect(result).toMatchObject({ content: null, toolCalls: [], finishReason: null, model: "contract-model" });
    expect(result.usage.inputTokens).toBeUndefined(); expect(result.usage.outputTokens).toBeUndefined();
    expect(JSON.parse(requests[0].body).temperature).toBe(0.2);
  });
  it("validates structured output and rejects malformed, wrong-shape and empty results", async () => {
    const provider = new Provider(options()), schema = z.object({ available: z.boolean() });
    reply = completion('{"available":true}');
    expect((await provider.completeJson([], schema, "availability")).data).toEqual({ available: true });
    expect(JSON.parse(requests[0].body).response_format.json_schema.strict).toBe(false);
    for (const invalid of [null, "not-json", '{"available":"yes"}']) {
      reply = completion(invalid);
      await expect(provider.completeJson([], schema, "availability")).rejects.toMatchObject({ status: 502, code: "LLM_ERROR" });
    }
  });
  it.each([[429, "PROVIDER_RATE_LIMITED"], [504, "PROVIDER_TIMEOUT"], [401, "LLM_ERROR"], [500, "LLM_ERROR"]])("maps HTTP %s honestly without retry when disabled", async (httpStatus, code) => {
    status = Number(httpStatus); reply = { error: { message: "fixture failure" } };
    await expect(new Provider(options()).complete([])).rejects.toMatchObject({ code }); expect(requests).toHaveLength(1);
  });
});
describe.each([OpenAIEmbeddingProvider, CompatibleEmbeddingProvider])("embedding HTTP contract %s", Provider => {
  it("restores index order and handles unknown usage and empty batches", async () => {
    reply = { data: [{ index: 1, embedding: vector([0, 1]) }, { index: 0, embedding: vector([1, 0]) }] };
    const provider = new Provider(options());
    expect(await provider.embedMany([])).toEqual([]); expect(requests).toHaveLength(0);
    const result = await provider.embedMany(["first", "second"]);
    expect(result.map(item => item.embedding)).toEqual([[1, 0], [0, 1]]);
    expect(result.every(item => item.usage.embeddingTokens === undefined)).toBe(true);
    expect(JSON.parse(requests[0].body)).toMatchObject({ input: ["first", "second"], model: "contract-model" });
    reply = { data: [{ index: 0, embedding: vector([1, 2]) }], usage: { total_tokens: 7 } };
    expect(await provider.embed("single")).toMatchObject({ dimensions: 2, usage: { embeddingTokens: 7 } });
  });
  it("maps provider authentication failures", async () => {
    status = 403; reply = { error: { message: "fixture denied" } };
    await expect(new Provider(options()).embed("private text")).rejects.toMatchObject({ status: 502, code: "EMBEDDING_ERROR" });
  });
});
describe.each([OpenAISTTProvider, CompatibleSTTProvider])("STT HTTP contract %s", Provider => {
  it("sends multipart audio, normalizes language and retains reported duration", async () => {
    reply = { text: "سلام", duration: 12.5, language: "persian" };
    const result = await new Provider(options()).transcribe(Buffer.from("fixture-audio"), { language: "fa-IR", mimeType: "audio/wav" });
    expect(requests[0].url).toBe("/v1/audio/transcriptions"); expect(requests[0].contentType).toContain("multipart/form-data");
    expect(requests[0].body).toContain('filename="call-audio.wav"'); expect(requests[0].body).toContain("verbose_json");
    expect(result).toMatchObject({ text: "سلام", durationSeconds: 12.5, usage: { audioSeconds: 12.5 }, confidence: null, status: "final" });
  });
  it("does not invent duration or transcript when the response omits them", async () => {
    reply = {};
    expect(await new Provider(options()).transcribe(Buffer.from("fixture"))).toMatchObject({ text: "", language: "fa", durationSeconds: null, usage: {} });
  });
  it("rejects empty/oversized audio before HTTP and maps provider errors", async () => {
    const provider = new Provider(options());
    await expect(provider.transcribe(Buffer.alloc(0))).rejects.toMatchObject({ status: 400 });
    await expect(provider.transcribe(Buffer.alloc(25 * 1024 * 1024 + 1))).rejects.toMatchObject({ status: 413 });
    expect(requests).toHaveLength(0); status = 429; reply = { error: { message: "slow down" } };
    await expect(provider.transcribe(Buffer.from("fixture"))).rejects.toMatchObject({ code: "PROVIDER_RATE_LIMITED" });
  });
});
describe.each([OpenAITTSProvider, CompatibleTTSProvider])("TTS HTTP contract %s", Provider => {
  it("returns exact response bytes and counts trimmed input characters", async () => {
    reply = Buffer.from([0, 1, 255, 9]);
    const result = await new Provider({ ...options(), voice: "default" }).synthesize(" سلام ", { voice: "selected", format: "wav", speed: 0.8 });
    expect(requests[0].url).toBe("/v1/audio/speech"); expect(JSON.parse(requests[0].body)).toMatchObject({ input: "سلام", voice: "selected", response_format: "wav", speed: 0.8 });
    expect(result.audio).toEqual(reply); expect(result.mimeType).toBe("audio/wav"); expect(result.usage.characters).toBe(4);
    const defaults = await new Provider({ ...options(), voice: "default" }).synthesize("a");
    expect(defaults).toMatchObject({ mimeType: "audio/mpeg", voice: "default" });
  });
  it("rejects invalid input before HTTP and propagates upstream failure", async () => {
    const provider = new Provider({ ...options(), voice: "default" });
    for (const text of [" ", "x".repeat(4097)]) await expect(provider.synthesize(text)).rejects.toMatchObject({ status: 400 });
    expect(requests).toHaveLength(0); status = 500; reply = { error: { message: "fixture down" } };
    await expect(provider.synthesize("سلام")).rejects.toMatchObject({ code: "TTS_ERROR" });
  });
});
it("maps timeout/rate-limit variants and accepts only the supported audio MIME list", () => {
  for (const err of [{ code: "ETIMEDOUT" }, { message: "Request timed out" }, { status: 408 }]) expect(mapSdkError(err, "LLM_ERROR", "test").code).toBe("PROVIDER_TIMEOUT");
  expect(mapSdkError({ code: "rate_limit_exceeded" }, "LLM_ERROR", "test").code).toBe("PROVIDER_RATE_LIMITED");
  expect(mapSdkError(null, "TTS_ERROR", "test").code).toBe("TTS_ERROR");
  for (const status of [408, 504]) expect(providerErrorFromStatus(status, "STT_ERROR", "test").status).toBe(504);
  expect(providerErrorFromStatus(429, "STT_ERROR", "test").status).toBe(429);
  expect(providerErrorFromStatus(400, "STT_ERROR", "test").status).toBe(502);
  expect(isSupportedAudioMime("AUDIO/WAV")).toBe(true); expect(isSupportedAudioMime("text/plain")).toBe(false); expect(isSupportedAudioMime(null)).toBe(false);
});
