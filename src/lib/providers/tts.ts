import OpenAI from "openai";
import { GoogleGenAI } from "@google/genai";
import { AppError } from "@/lib/errors";
import { getEnv } from "@/lib/env";
import { logError, logInfo, logWarn } from "@/lib/logger";
import { assertConfigured, mapSdkError, type ProviderUsage } from "@/lib/providers/types";

export type TtsAudioFormat = "mp3" | "wav" | "opus" | "pcm";

export type SpeechResult = {
  audio: Buffer;
  mimeType: string;
  usage: ProviderUsage;
  provider: string;
  model: string;
  voice: string;
};

export type SynthesizeOptions = {
  voice?: string;
  format?: TtsAudioFormat;
  /** 0.25 - 4.0 playback speed. */
  speed?: number;
  requestId?: string;
  businessId?: string;
  callId?: string;
  timeoutMs?: number;
};

export interface TTSProvider {
  readonly name: string;
  synthesize(text: string, options?: SynthesizeOptions): Promise<SpeechResult>;
}

const MIME_FOR_FORMAT: Record<TtsAudioFormat, string> = {
  mp3: "audio/mpeg",
  wav: "audio/wav",
  opus: "audio/ogg",
  pcm: "audio/pcm",
};

type TtsProviderOptions = {
  apiKey: string;
  baseURL: string;
  model: string;
  voice: string;
  timeoutMs: number;
  maxRetries: number;
};

abstract class BaseTtsProvider implements TTSProvider {
  abstract readonly name: string;
  protected client: OpenAI;
  protected model: string;
  protected defaultVoice: string;

  constructor(opts: TtsProviderOptions) {
    this.client = new OpenAI({
      apiKey: opts.apiKey,
      baseURL: opts.baseURL,
      timeout: opts.timeoutMs,
      maxRetries: opts.maxRetries,
    });
    this.model = opts.model;
    this.defaultVoice = opts.voice;
  }

  async synthesize(text: string, options: SynthesizeOptions = {}): Promise<SpeechResult> {
    const start = Date.now();
    const input = text.trim();
    if (!input) throw new AppError(400, "INVALID_PAYLOAD", "TTS text must not be empty");
    if (input.length > 4096) {
      throw new AppError(400, "INVALID_PAYLOAD", "TTS text exceeds 4096 character limit");
    }
    const format = options.format ?? "mp3";
    const voice = options.voice ?? this.defaultVoice;
    try {
      const response = await this.client.audio.speech.create(
        {
          model: this.model,
          voice,
          input,
          response_format: format,
          speed: options.speed,
        },
        options.timeoutMs === undefined ? undefined : { timeout: options.timeoutMs },
      );
      const buffer = Buffer.from(await response.arrayBuffer());
      logInfo("TTS synthesis completed", {
        requestId: options.requestId,
        businessId: options.businessId,
        callId: options.callId,
        provider: this.name,
        operation: "tts.synthesize",
        durationMs: Date.now() - start,
        status: "ok",
      });
      return {
        audio: buffer,
        mimeType: MIME_FOR_FORMAT[format],
        usage: { characters: input.length },
        provider: this.name,
        model: this.model,
        voice,
      };
    } catch (err) {
      logError("TTS synthesis failed", {
        requestId: options.requestId,
        businessId: options.businessId,
        callId: options.callId,
        provider: this.name,
        operation: "tts.synthesize",
        durationMs: Date.now() - start,
        status: "error",
        error: err,
      });
      throw mapSdkError(err, "TTS_ERROR", "speech synthesis");
    }
  }
}

export class OpenAITTSProvider extends BaseTtsProvider {
  readonly name = "openai";

  constructor(overrides?: Partial<TtsProviderOptions>) {
    const e = getEnv();
    super({
      apiKey: overrides?.apiKey ?? e.OPENAI_API_KEY,
      baseURL: overrides?.baseURL ?? e.OPENAI_BASE_URL,
      model: overrides?.model ?? e.TTS_MODEL,
      voice: overrides?.voice ?? e.TTS_VOICE,
      timeoutMs: overrides?.timeoutMs ?? e.TTS_TIMEOUT_MS,
      maxRetries: overrides?.maxRetries ?? 1,
    });
    assertConfigured(Boolean(overrides?.apiKey ?? e.OPENAI_API_KEY), "OPENAI_API_KEY is required for TTS_PROVIDER=openai");
  }
}

export class CompatibleTTSProvider extends BaseTtsProvider {
  readonly name = "compatible";

  constructor(overrides?: Partial<TtsProviderOptions>) {
    const e = getEnv();
    super({
      apiKey: overrides?.apiKey ?? e.COMPATIBLE_LLM_API_KEY,
      baseURL: overrides?.baseURL ?? e.COMPATIBLE_LLM_BASE_URL,
      model: overrides?.model ?? e.TTS_MODEL,
      voice: overrides?.voice ?? e.TTS_VOICE,
      timeoutMs: overrides?.timeoutMs ?? e.TTS_TIMEOUT_MS,
      maxRetries: overrides?.maxRetries ?? 1,
    });
    assertConfigured(
      Boolean(overrides?.baseURL ?? e.COMPATIBLE_LLM_BASE_URL),
      "COMPATIBLE_LLM_BASE_URL is required for TTS_PROVIDER=compatible",
    );
  }
}

/**
 * Development TTS provider. NEVER returns placeholder audio — it throws a
 * configuration error. Production forbids TTS_PROVIDER=dev entirely.
 */
function isRetryableGeminiTtsError(error: unknown): boolean {
  const err = error as {
    name?: string;
    status?: number;
    code?: string;
    message?: string;
    cause?: { code?: string };
  } | null;

  if (!err) return false;

  if (typeof err.status === "number" && err.status > 0) {
    return (
      err.status === 408 ||
      err.status === 429 ||
      (err.status >= 500 && err.status <= 599)
    );
  }

  const retryableNames = new Set([
    "APIConnectionError",
    "APITimeoutError",
    "APIConnectionTimeoutError",
    "AbortError",
    "TimeoutError",
  ]);

  if (retryableNames.has(err.name ?? "")) return true;

  const code = err.code ?? err.cause?.code ?? "";

  if (/^(ECONNRESET|ETIMEDOUT|EAI_AGAIN|UND_ERR_SOCKET|UND_ERR_CONNECT_TIMEOUT)$/.test(code)) {
    return true;
  }

  return /TypeError:\s*unusable|fetch failed|socket hang up|network error|timed?\s*out/i.test(
    err.message ?? "",
  );
}

async function withGeminiTtsRetry<T>(
  operation: () => Promise<T>,
  context: {
    requestId?: string;
    businessId?: string;
    callId?: string;
  },
): Promise<T> {
  const maxAttempts = 3;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await operation();
    } catch (error) {
      if (
        attempt >= maxAttempts ||
        !isRetryableGeminiTtsError(error)
      ) {
        throw error;
      }

      const delayMs = 200 * 2 ** (attempt - 1);

      logWarn("Gemini TTS transient error; retrying", {
        ...context,
        provider: "gemini",
        operation: "tts.synthesize.retry",
        status: "retry",
        attempt,
        maxAttempts,
        delayMs,
        error: error instanceof Error
          ? error.message.slice(0, 200)
          : "transient_error",
      });

      await new Promise<void>((resolve) =>
        setTimeout(resolve, delayMs)
      );
    }
  }

  throw new Error("Gemini TTS retry attempts exhausted");
}

export class GeminiTTSProvider implements TTSProvider {
  readonly name = "gemini";

  private readonly ai: GoogleGenAI;
  private readonly model: string;
  private readonly defaultVoice: string;

  constructor() {
    const e = getEnv();

    assertConfigured(
      Boolean(e.COMPATIBLE_LLM_API_KEY),
      "COMPATIBLE_LLM_API_KEY is required for TTS_PROVIDER=gemini",
    );

    this.ai = new GoogleGenAI({
      apiKey: e.COMPATIBLE_LLM_API_KEY,
    });

    this.model = e.TTS_MODEL;
    this.defaultVoice = e.TTS_VOICE;
  }

  async synthesize(
    text: string,
    options: SynthesizeOptions = {},
  ): Promise<SpeechResult> {
    const start = Date.now();
    const input = text.trim();

    if (!input) {
      throw new AppError(
        400,
        "INVALID_PAYLOAD",
        "TTS text must not be empty",
      );
    }

    if (input.length > 4096) {
      throw new AppError(
        400,
        "INVALID_PAYLOAD",
        "TTS text exceeds 4096 character limit",
      );
    }

    const voice = options.voice ?? this.defaultVoice;
    const requestedFormat = options.format ?? "wav";

    const mimeType =
      requestedFormat === "pcm"
        ? "audio/l16"
        : "audio/wav";

    try {
      const interaction = await withGeminiTtsRetry(() => this.ai.interactions.create({
        model: this.model,
        input: [
          {
            type: "user_input",
            content: [
              {
                type: "text",
                text: input,
              },
            ],
          },
        ],
        response_format: {
          type: "audio",
          mime_type: mimeType,
          sample_rate: 24000,
        },
        generation_config: {
          speech_config: [
            {
              voice,
            },
          ],
        },
      }), {
        requestId: options.requestId,
        businessId: options.businessId,
        callId: options.callId,
      });

      const audioData = interaction.output_audio?.data;

      if (!audioData) {
        throw new Error("Gemini TTS returned no audio data");
      }

      const audio = Buffer.from(audioData, "base64");

      logInfo("TTS synthesis completed", {
        requestId: options.requestId,
        businessId: options.businessId,
        callId: options.callId,
        provider: this.name,
        operation: "tts.synthesize",
        durationMs: Date.now() - start,
		audioBytes: audio.byteLength,
		audioHeader: audio.subarray(0, 44).toString("hex"),
        status: "ok",
      });

      return {
        audio,
        mimeType,
        usage: {
          characters: input.length,
        },
        provider: this.name,
        model: this.model,
        voice,
      };
    } catch (err) {
      logError("TTS synthesis failed", {
        requestId: options.requestId,
        businessId: options.businessId,
        callId: options.callId,
        provider: this.name,
        operation: "tts.synthesize",
        durationMs: Date.now() - start,
        status: "error",
        error: err,
      });

      throw mapSdkError(
        err,
        "TTS_ERROR",
        "speech synthesis",
      );
    }
  }
}
export class DevTTSProvider implements TTSProvider {
  readonly name = "dev";
  async synthesize(): Promise<SpeechResult> {
    throw new AppError(
      503,
      "PROVIDER_NOT_CONFIGURED",
      "TTS provider is not configured. Set TTS_PROVIDER=openai (with OPENAI_API_KEY) or TTS_PROVIDER=compatible.",
    );
  }
}

export function getTTSProvider(): TTSProvider {
  switch (getEnv().TTS_PROVIDER) {
    case "openai":
      return new OpenAITTSProvider();

    case "compatible":
      return new CompatibleTTSProvider();

    case "gemini":
      return new GeminiTTSProvider();

    case "dev":
      return new DevTTSProvider();
  }
}