import { z } from "zod";
import { AppError } from "@/lib/errors";
import { getEnv } from "@/lib/env";
import { logWarn } from "@/lib/logger";
import { metrics } from "@/lib/telemetry";

/**
 * Optional reranking provider.
 *
 * Flow: hybrid retrieval → candidate set → reranker → final evidence set.
 * The reranker is strictly optional: when it is not configured, fails, or
 * times out, retrieval falls back to the existing RRF ordering. A reranker can
 * only REORDER candidates it was given — it can never introduce a document that
 * retrieval (and therefore the ACL predicate) did not already authorize.
 */

export type RerankCandidate = { id: string; documentId: string; content: string; score: number };

export type RerankResult = {
  candidates: RerankCandidate[];
  provider: string;
  model: string | null;
  latencyMs: number;
  /** Provider-reported cost in USD when available; null = unknown (never 0 as "free"). */
  costUsd: number | null;
  usedFallback: boolean;
};

export interface RerankerProvider {
  readonly name: string;
  readonly model: string;
  rerank(query: string, candidates: RerankCandidate[], opts?: { topN?: number }): Promise<RerankCandidate[]>;
}

/** Deterministic lexical reranker: no network, no cost, stable in tests. */
export class LexicalReranker implements RerankerProvider {
  readonly name = "lexical";
  readonly model = "lexical-overlap-v1";

  async rerank(query: string, candidates: RerankCandidate[], opts?: { topN?: number }): Promise<RerankCandidate[]> {
    const terms = tokenize(query);
    if (terms.length === 0) return candidates.slice(0, opts?.topN ?? candidates.length);
    return [...candidates]
      .map((candidate) => {
        const content = tokenize(candidate.content);
        const overlap = terms.filter((term) => content.includes(term)).length / terms.length;
        const positionBoost = 1 / (1 + candidates.indexOf(candidate));
        return { candidate, score: overlap * 0.85 + candidate.score * 0.1 + positionBoost * 0.05 };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, opts?.topN ?? candidates.length)
      .map(({ candidate, score }) => ({ ...candidate, score }));
  }
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((term) => term.length >= 2)
    .slice(0, 64);
}

const ResponseSchema = z.object({
  results: z.array(z.object({ index: z.number().int().min(0), relevance_score: z.number().finite() })).max(100),
});

/**
 * OpenAI-compatible `/rerank` endpoint adapter (Cohere/Jina/vLLM/Tei shapes
 * differ slightly, so the parser accepts both `results` and `data`). Requires
 * RERANK_BASE_URL (+ optional RERANK_API_KEY); when unset the provider is not
 * constructed and retrieval keeps RRF ordering.
 */
export class HttpReranker implements RerankerProvider {
  readonly name = "http";
  readonly model: string;
  private baseURL: string;
  private apiKey: string;
  private timeoutMs: number;

  constructor(overrides?: { baseURL?: string; apiKey?: string; model?: string; timeoutMs?: number }) {
    const env = getEnv() as unknown as Record<string, string | number | undefined>;
    const baseURL = String(overrides?.baseURL ?? env.RERANK_BASE_URL ?? "");
    const apiKey = String(overrides?.apiKey ?? env.RERANK_API_KEY ?? "");
    if (!baseURL) throw new AppError(503, "PROVIDER_NOT_CONFIGURED", "RERANK_BASE_URL is not configured");
    this.baseURL = baseURL.replace(/\/$/, "");
    this.apiKey = apiKey;
    this.model = String(overrides?.model ?? env.RERANK_MODEL ?? "rerank-1");
    this.timeoutMs = overrides?.timeoutMs ?? Number(env.RERANK_TIMEOUT_MS ?? 8000);
  }

  async rerank(query: string, candidates: RerankCandidate[], opts?: { topN?: number }): Promise<RerankCandidate[]> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(`${this.baseURL}/rerank`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: this.model,
          query,
          documents: candidates.map((candidate) => candidate.content),
          top_n: Math.min(opts?.topN ?? candidates.length, candidates.length),
        }),
        signal: controller.signal,
      });
      if (!res.ok) throw new AppError(502, "PROVIDER_ERROR", `Reranker responded with HTTP ${res.status}`);
      const body = (await res.json()) as { results?: unknown[]; data?: unknown[] };
      const parsed = ResponseSchema.safeParse({ results: body.results ?? body.data ?? [] });
      if (!parsed.success) throw new AppError(502, "PROVIDER_ERROR", "Reranker returned an unexpected payload");
      // An empty/absent result list is a provider failure, not a valid ranking:
      // it must degrade to the RRF order instead of silently emptying the
      // candidate set the answer would have been grounded in.
      if (parsed.data.results.length === 0) throw new AppError(502, "PROVIDER_ERROR", "Reranker returned no results");
      const byIndex = new Map(parsed.data.results.map((item) => [item.index, item.relevance_score]));
      return candidates
        .map((candidate, index) => ({ candidate, score: byIndex.get(index) }))
        .filter((entry): entry is { candidate: RerankCandidate; score: number } => entry.score !== undefined)
        .sort((a, b) => b.score - a.score)
        .map(({ candidate, score }) => ({ ...candidate, score }));
    } finally {
      clearTimeout(timer);
    }
  }
}

export function rerankerFromEnv(): RerankerProvider | null {
  const env = getEnv() as unknown as Record<string, string | undefined>;
  if (env.RERANK_PROVIDER === "http") return new HttpReranker();
  if (env.RERANK_PROVIDER === "lexical") return new LexicalReranker();
  return null;
}

/**
 * Run the configured reranker with a hard fallback to the RRF ordering.
 * Latency/provider/fallback are returned for analytics; failures are logged
 * without content (never the query text or documents).
 */
export async function rerankWithFallback(input: {
  query: string;
  candidates: RerankCandidate[];
  provider?: RerankerProvider | null;
  topN?: number;
}): Promise<RerankResult> {
  const provider = input.provider === undefined ? rerankerFromEnv() : input.provider;
  const started = Date.now();
  if (!provider || input.candidates.length === 0) {
    return {
      candidates: input.candidates.slice(0, input.topN ?? input.candidates.length),
      provider: "rrf",
      model: null,
      latencyMs: 0,
      costUsd: null,
      usedFallback: provider === null,
    };
  }
  try {
    const reranked = await provider.rerank(input.query, input.candidates, { topN: input.topN });
    const latencyMs = Date.now() - started;
    metrics().retrievalDuration.observe({}, latencyMs / 1000);
    return { candidates: reranked, provider: provider.name, model: provider.model, latencyMs, costUsd: null, usedFallback: false };
  } catch (err) {
    logWarn("Reranker unavailable; using RRF ordering", {
      operation: "rerank.fallback",
      provider: provider.name,
      status: "fallback",
      error: err instanceof Error ? err.message : String(err),
    });
    return {
      candidates: input.candidates.slice(0, input.topN ?? input.candidates.length),
      provider: "rrf",
      model: null,
      latencyMs: Date.now() - started,
      costUsd: null,
      usedFallback: true,
    };
  }
}
