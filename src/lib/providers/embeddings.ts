import OpenAI from "openai";
import { AppError } from "@/lib/errors";
import { getEnv } from "@/lib/env";
import { logError } from "@/lib/logger";
import { assertConfigured, mapSdkError, type ProviderUsage } from "@/lib/providers/types";

export type EmbedResult = {
  embedding: number[];
  usage: ProviderUsage;
  model: string;
  dimensions: number;
};

export interface EmbeddingProvider {
  readonly name: string;
  embed(text: string, opts?: { requestId?: string }): Promise<EmbedResult>;
  embedMany(texts: string[], opts?: { requestId?: string }): Promise<EmbedResult[]>;
}

type EmbeddingProviderOptions = {
  apiKey: string;
  baseURL: string;
  model: string;
  timeoutMs: number;
  maxRetries: number;
};

const MAX_BATCH = 100;

abstract class BaseEmbeddingProvider implements EmbeddingProvider {
  abstract readonly name: string;
  protected client: OpenAI;
  protected model: string;

  constructor(opts: EmbeddingProviderOptions) {
    this.client = new OpenAI({
      apiKey: opts.apiKey,
      baseURL: opts.baseURL,
      timeout: opts.timeoutMs,
      maxRetries: opts.maxRetries,
    });
    this.model = opts.model;
  }

  async embed(text: string, opts?: { requestId?: string }): Promise<EmbedResult> {
    const results = await this.embedMany([text], opts);
    return results[0];
  }

  async embedMany(texts: string[], opts?: { requestId?: string }): Promise<EmbedResult[]> {
    if (texts.length === 0) return [];
    const out: EmbedResult[] = [];
    for (let i = 0; i < texts.length; i += MAX_BATCH) {
      const batch = texts.slice(i, i + MAX_BATCH);
      try {
        const response = await this.client.embeddings.create({ model: this.model, input: batch });
        const perItemTokens =
          response.usage?.total_tokens != null ? Math.ceil(response.usage.total_tokens / batch.length) : undefined;
        for (const item of response.data.sort((a, b) => a.index - b.index)) {
          out.push({
            embedding: item.embedding,
            usage: perItemTokens != null ? { embeddingTokens: perItemTokens, totalTokens: perItemTokens } : {},
            model: this.model,
            dimensions: item.embedding.length,
          });
        }
      } catch (err) {
        logError("Embedding request failed", {
          requestId: opts?.requestId,
          provider: this.name,
          operation: "embedding.embed",
          status: "error",
          error: err,
        });
        throw mapSdkError(err, "EMBEDDING_ERROR", "embedding");
      }
    }
    return out;
  }
}

export class OpenAIEmbeddingProvider extends BaseEmbeddingProvider {
  readonly name = "openai";

  constructor(overrides?: Partial<EmbeddingProviderOptions>) {
    const e = getEnv();
    super({
      apiKey: overrides?.apiKey ?? e.OPENAI_API_KEY,
      baseURL: overrides?.baseURL ?? e.OPENAI_BASE_URL,
      model: overrides?.model ?? e.EMBEDDING_MODEL,
      timeoutMs: overrides?.timeoutMs ?? e.LLM_TIMEOUT_MS,
      maxRetries: overrides?.maxRetries ?? e.LLM_MAX_RETRIES,
    });
    assertConfigured(Boolean(overrides?.apiKey ?? e.OPENAI_API_KEY), "OPENAI_API_KEY is required for EMBEDDING_PROVIDER=openai");
  }
}

export class CompatibleEmbeddingProvider extends BaseEmbeddingProvider {
  readonly name = "compatible";

  constructor(overrides?: Partial<EmbeddingProviderOptions>) {
    const e = getEnv();
    super({
      apiKey: overrides?.apiKey ?? e.COMPATIBLE_LLM_API_KEY,
      baseURL: overrides?.baseURL ?? e.COMPATIBLE_LLM_BASE_URL,
      model: overrides?.model ?? e.EMBEDDING_MODEL,
      timeoutMs: overrides?.timeoutMs ?? e.LLM_TIMEOUT_MS,
      maxRetries: overrides?.maxRetries ?? e.LLM_MAX_RETRIES,
    });
    assertConfigured(
      Boolean(overrides?.baseURL ?? e.COMPATIBLE_LLM_BASE_URL),
      "COMPATIBLE_LLM_BASE_URL is required for EMBEDDING_PROVIDER=compatible",
    );
  }
}

export class DevEmbeddingProvider implements EmbeddingProvider {
  readonly name = "dev";
  async embed(): Promise<EmbedResult> {
    throw new AppError(
      503,
      "PROVIDER_NOT_CONFIGURED",
      "Embedding provider is not configured. Set EMBEDDING_PROVIDER=openai (with OPENAI_API_KEY) or EMBEDDING_PROVIDER=compatible.",
    );
  }
  async embedMany(): Promise<EmbedResult[]> {
    return this.embed().then((r) => [r]);
  }
}

export function getEmbeddingProvider(): EmbeddingProvider {
  switch (getEnv().EMBEDDING_PROVIDER) {
    case "openai":
      return new OpenAIEmbeddingProvider();
    case "compatible":
      return new CompatibleEmbeddingProvider();
    case "dev":
      return new DevEmbeddingProvider();
  }
}

/** Expected vector dimensions (must match the pgvector column). */
export function expectedEmbeddingDimensions(): number {
  return getEnv().EMBEDDING_DIMENSIONS;
}
