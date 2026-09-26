import { AppError, type ErrorCode } from "@/lib/errors";

/** Standard usage block reported by every AI provider call. */
export type ProviderUsage = {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  /** Seconds of audio (STT) / characters (TTS) / minutes (voice). */
  audioSeconds?: number;
  characters?: number;
  /** Embedding tokens. */
  embeddingTokens?: number;
};

export function emptyUsage(): ProviderUsage {
  return {};
}

export function providerErrorFromStatus(
  status: number,
  code: ErrorCode,
  message: string,
  details?: unknown,
): AppError {
  if (status === 429) return new AppError(429, "PROVIDER_RATE_LIMITED", message, details);
  if (status === 408 || status === 504) return new AppError(504, "PROVIDER_TIMEOUT", message, details);
  return new AppError(502, code, message, details);
}

/** Map an OpenAI-SDK-style error to a typed AppError. */
export function mapSdkError(err: unknown, fallbackCode: ErrorCode, operation: string): AppError {
  const anyErr = err as {
    status?: number;
    code?: string;
    message?: string;
    error?: { code?: string; message?: string; type?: string };
  };
  const status = typeof anyErr?.status === "number" ? anyErr.status : 0;
  const message =
    anyErr?.error?.message ?? (typeof anyErr?.message === "string" ? anyErr.message : `${operation} failed`);
  if (status === 429 || anyErr?.code === "rate_limit_exceeded") {
    return new AppError(429, "PROVIDER_RATE_LIMITED", `Provider rate limited during ${operation}`, {
      detail: message,
    });
  }
  if (status === 408 || status === 504 || anyErr?.code === "ETIMEDOUT" || /timed?\s*out/i.test(message)) {
    return new AppError(504, "PROVIDER_TIMEOUT", `Provider timeout during ${operation}`, { detail: message });
  }
  if (status === 401 || status === 403) {
    return new AppError(502, fallbackCode, `Provider authentication failed during ${operation}`, {
      detail: message,
    });
  }
  return new AppError(502, fallbackCode, `Provider error during ${operation}`, {
    status: status || undefined,
    detail: message,
  });
}

export function assertConfigured(condition: boolean, message: string): void {
  if (!condition) {
    throw new AppError(503, "PROVIDER_NOT_CONFIGURED", message);
  }
}
