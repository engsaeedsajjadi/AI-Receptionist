import { db } from "@/db";
import { usageRecords } from "@/db/schema";
import { estimateCost } from "@/lib/pricing";
import type { ProviderUsage } from "@/lib/providers/types";

export type UsageType =
  | "voice_minutes"
  | "stt_minutes"
  | "tts_characters"
  | "llm_input_tokens"
  | "llm_output_tokens"
  | "embedding_tokens"
  | "calls"
  | "storage_bytes"
  | "notifications";

export type RecordUsageInput = {
  businessId: string;
  type: UsageType;
  quantity: number;
  unit: string;
  provider?: string;
  /** Idempotency: retries with the same key are recorded once. */
  idempotencyKey?: string;
  metadata?: Record<string, unknown>;
};

function toQuantityString(quantity: number): string {
  if (!Number.isFinite(quantity) || quantity < 0) return "0";
  return String(Math.round(quantity * 10000) / 10000);
}

/**
 * Record tenant-scoped usage with optional idempotency.
 * Provider-reported quantities are stored verbatim; cost is an estimate.
 */
export async function recordUsage(input: RecordUsageInput): Promise<{ recorded: boolean; costUsd: number | null }> {
  const cost = estimateCost(input.type, input.quantity);
  const values = {
    businessId: input.businessId,
    type: input.type,
    quantity: toQuantityString(input.quantity),
    unit: input.unit,
    provider: input.provider ?? null,
    estimatedCost: cost != null ? String(Math.round(cost * 1_000_000) / 1_000_000) : null,
    currency: "USD",
    idempotencyKey: input.idempotencyKey ?? null,
    metadata: input.metadata ?? {},
  };

  if (input.idempotencyKey) {
    const rows = await db
      .insert(usageRecords)
      .values(values)
      .onConflictDoNothing({ target: [usageRecords.businessId, usageRecords.idempotencyKey] })
      .returning({ id: usageRecords.id });
    return { recorded: rows.length > 0, costUsd: cost };
  }

  await db.insert(usageRecords).values(values);
  return { recorded: true, costUsd: cost };
}

/** Record LLM token usage (input + output rows) from a provider usage block. */
export async function recordLlmUsage(input: {
  businessId: string;
  usage: ProviderUsage;
  provider: string;
  model?: string;
  idempotencyKey?: string;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  const meta = { ...(input.metadata ?? {}), model: input.model };
  if (input.usage.inputTokens) {
    await recordUsage({
      businessId: input.businessId,
      type: "llm_input_tokens",
      quantity: input.usage.inputTokens,
      unit: "token",
      provider: input.provider,
      idempotencyKey: input.idempotencyKey ? `${input.idempotencyKey}:in` : undefined,
      metadata: meta,
    });
  }
  if (input.usage.outputTokens) {
    await recordUsage({
      businessId: input.businessId,
      type: "llm_output_tokens",
      quantity: input.usage.outputTokens,
      unit: "token",
      provider: input.provider,
      idempotencyKey: input.idempotencyKey ? `${input.idempotencyKey}:out` : undefined,
      metadata: meta,
    });
  }
}

/** Record embedding token usage. */
export async function recordEmbeddingUsage(input: {
  businessId: string;
  tokens: number;
  provider: string;
  model?: string;
  idempotencyKey?: string;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  if (!input.tokens) return;
  await recordUsage({
    businessId: input.businessId,
    type: "embedding_tokens",
    quantity: input.tokens,
    unit: "token",
    provider: input.provider,
    idempotencyKey: input.idempotencyKey,
    metadata: { ...(input.metadata ?? {}), model: input.model },
  });
}
