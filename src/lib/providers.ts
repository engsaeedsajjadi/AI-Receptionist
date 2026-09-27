/**
 * Backwards-compatible provider barrel.
 * New code should import from `@/lib/providers/<domain>` directly.
 */
export type { LLMProvider } from "@/lib/providers/llm";
export { CompatibleLLMProvider, DevLLMProvider, getLLMProvider, OpenAIProvider } from "@/lib/providers/llm";
export type { EmbeddingProvider } from "@/lib/providers/embeddings";
export { getEmbeddingProvider } from "@/lib/providers/embeddings";
export type { STTProvider } from "@/lib/providers/stt";
export { getSTTProvider } from "@/lib/providers/stt";
export type { TTSProvider } from "@/lib/providers/tts";
export { getTTSProvider } from "@/lib/providers/tts";
export type { VoiceProvider } from "@/lib/providers/voice";
export { getVoiceProvider } from "@/lib/providers/voice";
export type { StorageProvider } from "@/lib/providers/storage";
export { getStorageProvider } from "@/lib/providers/storage";
export type { NotificationProvider, NotificationChannel } from "@/lib/providers/notifications";
export {
  ConsoleNotificationProvider,
  EmailNotificationProvider,
  getNotificationProvider,
} from "@/lib/providers/notifications";
