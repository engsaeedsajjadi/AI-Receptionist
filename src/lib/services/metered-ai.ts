import type { ChatCompletionOptions, ChatMessage, LLMProvider } from "@/lib/providers/llm";
import type { EmbeddingProvider } from "@/lib/providers/embeddings";
import type { SynthesizeOptions, TTSProvider } from "@/lib/providers/tts";
import { withUsageReservation } from "@/lib/services/quotas";
/** Conservative request bounds; provider-reported overruns fail closed and remain accounted. */
export async function meteredCompletion(businessId: string, provider: LLMProvider, messages: ChatMessage[], options: ChatCompletionOptions = {}) {
  const inputBound = Buffer.byteLength(JSON.stringify({ messages, tools: options.tools, responseFormat: options.responseFormat }), "utf8") + 4096;
  const outputBound = options.maxTokens ?? 4096;
  return withUsageReservation(businessId, { llm_input_tokens: inputBound, llm_output_tokens: outputBound },
    () => provider.complete(messages, { ...options, businessId, maxTokens: outputBound }),
    (result) => ({ llm_input_tokens: result.usage.inputTokens ?? inputBound, llm_output_tokens: result.usage.outputTokens ?? outputBound }));
}
export async function meteredEmbeddings(businessId: string, provider: EmbeddingProvider, texts: string[], options?: { requestId?: string }) {
  if (!texts.length) return [];
  const output = [];
  // Settle successful batches before starting another; later failure must not erase their cost.
  for (let offset = 0; offset < texts.length; offset += 100) {
    const batch = texts.slice(offset, offset + 100);
    const bound = batch.reduce((total, text) => total + Buffer.byteLength(text, "utf8") + 256, 0);
    const results = await withUsageReservation(businessId, { embedding_tokens: bound }, () => provider.embedMany(batch, options),
      (results) => ({ embedding_tokens: results.some((result) => result.usage.embeddingTokens == null) ? bound : results.reduce((total, result) => total + result.usage.embeddingTokens!, 0) }));
    output.push(...results);
  }
  return output;
}
export async function meteredSpeech(businessId: string, provider: TTSProvider, text: string, options?: SynthesizeOptions) {
  return withUsageReservation(businessId, { tts_characters: text.length }, () => provider.synthesize(text, { ...options, businessId }),
    (result) => ({ tts_characters: result.usage.characters ?? text.length }));
}
