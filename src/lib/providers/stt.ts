import OpenAI, { toFile } from "openai";
import { AppError } from "@/lib/errors";
import { getEnv } from "@/lib/env";
import { logError, logInfo } from "@/lib/logger";
import { assertConfigured, mapSdkError, type ProviderUsage } from "@/lib/providers/types";

export type TranscriptionResult = {
  text: string;
  language: string | null;
  /** "final" for file transcription; streaming adapters may return "partial". */
  status: "partial" | "final";
  confidence: number | null;
  durationSeconds: number | null;
  usage: ProviderUsage;
  provider: string;
  model: string;
};

export type TranscribeOptions = {
  filename?: string;
  mimeType?: string;
  /** BCP-47 / ISO code, e.g. "fa". Defaults to Persian. */
  language?: string;
  requestId?: string;
  businessId?: string;
  callId?: string;
  timeoutMs?: number;
};

export interface STTProvider {
  readonly name: string;
  transcribe(audio: Buffer, options?: TranscribeOptions): Promise<TranscriptionResult>;
}

const SUPPORTED_MIME = new Set([
  "audio/mpeg",
  "audio/mp3",
  "audio/wav",
  "audio/x-wav",
  "audio/webm",
  "audio/ogg",
  "audio/mp4",
  "audio/x-m4a",
  "audio/flac",
]);

function extensionFor(mimeType?: string): string {
  switch (mimeType) {
    case "audio/wav":
    case "audio/x-wav":
      return "wav";
    case "audio/webm":
      return "webm";
    case "audio/ogg":
      return "ogg";
    case "audio/mp4":
    case "audio/x-m4a":
      return "m4a";
    case "audio/flac":
      return "flac";
    default:
      return "mp3";
  }
}

type SttProviderOptions = {
  apiKey: string;
  baseURL: string;
  model: string;
  timeoutMs: number;
  maxRetries: number;
};

abstract class BaseSttProvider implements STTProvider {
  abstract readonly name: string;
  protected client: OpenAI;
  protected model: string;

  constructor(opts: SttProviderOptions) {
    this.client = new OpenAI({
      apiKey: opts.apiKey,
      baseURL: opts.baseURL,
      timeout: opts.timeoutMs,
      maxRetries: opts.maxRetries,
    });
    this.model = opts.model;
  }

  async transcribe(audio: Buffer, options: TranscribeOptions = {}): Promise<TranscriptionResult> {
    const start = Date.now();
    if (!audio || audio.length === 0) {
      throw new AppError(400, "INVALID_PAYLOAD", "Empty audio payload");
    }
    if (audio.length > 25 * 1024 * 1024) {
      throw new AppError(413, "PAYLOAD_TOO_LARGE", "Audio payload exceeds 25 MB limit");
    }
    const filename = options.filename ?? `call-audio.${extensionFor(options.mimeType)}`;
    const language = (options.language ?? "fa").split("-")[0]; // whisper expects ISO-639-1
    try {
      const file = await toFile(audio, filename, { type: options.mimeType ?? "audio/mpeg" });
      const response = await this.client.audio.transcriptions.create(
        {
          model: this.model,
          file,
          language,
          response_format: "verbose_json",
        },
        options.timeoutMs === undefined ? undefined : { timeout: options.timeoutMs },
      );
      const duration = typeof response.duration === "number" ? response.duration : null;
      logInfo("STT transcription completed", {
        requestId: options.requestId,
        businessId: options.businessId,
        callId: options.callId,
        provider: this.name,
        operation: "stt.transcribe",
        durationMs: Date.now() - start,
        status: "ok",
      });
      return {
        text: response.text ?? "",
        language: response.language ?? language,
        status: "final",
        confidence: null, // whisper verbose_json exposes segment confidences, not a global score
        durationSeconds: duration,
        usage: duration != null ? { audioSeconds: duration } : {},
        provider: this.name,
        model: this.model,
      };
    } catch (err) {
      logError("STT transcription failed", {
        requestId: options.requestId,
        businessId: options.businessId,
        callId: options.callId,
        provider: this.name,
        operation: "stt.transcribe",
        durationMs: Date.now() - start,
        status: "error",
        error: err,
      });
      throw mapSdkError(err, "STT_ERROR", "speech transcription");
    }
  }
}

export class OpenAISTTProvider extends BaseSttProvider {
  readonly name = "openai";

  constructor(overrides?: Partial<SttProviderOptions>) {
    const e = getEnv();
    super({
      apiKey: overrides?.apiKey ?? e.OPENAI_API_KEY,
      baseURL: overrides?.baseURL ?? e.OPENAI_BASE_URL,
      model: overrides?.model ?? e.STT_MODEL,
      timeoutMs: overrides?.timeoutMs ?? e.STT_TIMEOUT_MS,
      maxRetries: overrides?.maxRetries ?? 1,
    });
    assertConfigured(Boolean(overrides?.apiKey ?? e.OPENAI_API_KEY), "OPENAI_API_KEY is required for STT_PROVIDER=openai");
  }
}

export class CompatibleSTTProvider extends BaseSttProvider {
  readonly name = "compatible";

  constructor(overrides?: Partial<SttProviderOptions>) {
    const e = getEnv();
    super({
      apiKey: overrides?.apiKey ?? e.COMPATIBLE_LLM_API_KEY,
      baseURL: overrides?.baseURL ?? e.COMPATIBLE_LLM_BASE_URL,
      model: overrides?.model ?? e.STT_MODEL,
      timeoutMs: overrides?.timeoutMs ?? e.STT_TIMEOUT_MS,
      maxRetries: overrides?.maxRetries ?? 1,
    });
    assertConfigured(
      Boolean(overrides?.baseURL ?? e.COMPATIBLE_LLM_BASE_URL),
      "COMPATIBLE_LLM_BASE_URL is required for STT_PROVIDER=compatible",
    );
  }
}

/**
 * Development STT provider. NEVER returns fake transcripts — it throws a
 * configuration error. Production forbids STT_PROVIDER=dev entirely.
 */
export class DevSTTProvider implements STTProvider {
  readonly name = "dev";
  async transcribe(): Promise<TranscriptionResult> {
    throw new AppError(
      503,
      "PROVIDER_NOT_CONFIGURED",
      "STT provider is not configured. Set STT_PROVIDER=openai (with OPENAI_API_KEY) or STT_PROVIDER=compatible.",
    );
  }
}

export function getSTTProvider(): STTProvider {
  switch (getEnv().STT_PROVIDER) {
    case "openai":
      return new OpenAISTTProvider();
    case "compatible":
      return new CompatibleSTTProvider();
    case "dev":
      return new DevSTTProvider();
  }
}

export function isSupportedAudioMime(mimeType: string | null | undefined): boolean {
  if (!mimeType) return false;
  return SUPPORTED_MIME.has(mimeType.toLowerCase());
}
