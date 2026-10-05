import OpenAI from "openai";
import { AppError } from "@/lib/errors";
import { getEnv } from "@/lib/env";
import { logError, logInfo } from "@/lib/logger";
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
    case "dev":
      return new DevTTSProvider();
  }
}
