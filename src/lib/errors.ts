/**
 * Typed application errors + consistent API error format.
 *
 * Response shape:
 * { "success": false, "error": { "code": "...", "message": "...", "requestId": "..." } }
 */

export type ErrorCode =
  | "QUOTA_EXCEEDED"
  | "BAD_REQUEST"
  | "INVALID_PAYLOAD"
  | "INVALID_JSON"
  | "VALIDATION_ERROR"
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CONFLICT"
  | "RATE_LIMITED"
  | "PAYLOAD_TOO_LARGE"
  | "UNSUPPORTED_MEDIA_TYPE"
  | "APPOINTMENT_CONFLICT"
  | "LEAD_NOT_FOUND"
  | "CUSTOMER_NOT_FOUND"
  | "CALL_NOT_FOUND"
  | "AGENT_NOT_FOUND"
  | "KNOWLEDGE_NOT_FOUND"
  | "PROPERTY_NOT_FOUND"
  | "USER_NOT_FOUND"
  | "BUSINESS_NOT_FOUND"
  | "APPOINTMENT_NOT_FOUND"
  | "NOTIFICATION_NOT_FOUND"
  | "EMAIL_EXISTS"
  | "SLUG_EXISTS"
  | "DOMAIN_TAKEN"
  | "PHONE_TAKEN"
  | "VOICE_CONSENT_REQUIRED"
  | "INVALID_CREDENTIALS"
  | "TOKEN_REVOKED"
  | "TOKEN_REUSE_DETECTED"
  | "INVALID_SIGNATURE"
  | "WEBHOOK_REPLAY"
  | "STALE_TIMESTAMP"
  | "PROVIDER_ERROR"
  | "PROVIDER_TIMEOUT"
  | "PROVIDER_RATE_LIMITED"
  | "PROVIDER_NOT_CONFIGURED"
  | "LLM_ERROR"
  | "STT_ERROR"
  | "TTS_ERROR"
  | "VOICE_ERROR"
  | "EMBEDDING_ERROR"
  | "TRANSFER_FAILED"
  | "TRANSFER_IN_PROGRESS"
  | "TRANSFER_UNAVAILABLE"
  | "STORAGE_ERROR"
  | "N8N_ERROR"
  | "ANSWER_NOT_GROUNDED"
  | "DEPENDENCY_UNAVAILABLE"
  | "PROVIDER_CIRCUIT_OPEN"
  | "INTERNAL_ERROR";

export class AppError extends Error {
  readonly status: number;
  readonly code: ErrorCode;
  readonly details?: unknown;

  constructor(status: number, code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = "AppError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function badRequest(code: ErrorCode, message: string, details?: unknown): AppError {
  return new AppError(400, code, message, details);
}

export function unauthorized(message = "Unauthorized"): AppError {
  return new AppError(401, "UNAUTHORIZED", message);
}

export function forbidden(message = "Forbidden"): AppError {
  return new AppError(403, "FORBIDDEN", message);
}

export function notFound(code: ErrorCode, message: string): AppError {
  return new AppError(404, code, message);
}

export function conflict(code: ErrorCode, message: string): AppError {
  return new AppError(409, code, message);
}

export function tooManyRequests(retryAfterSeconds?: number): AppError {
  return new AppError(429, "RATE_LIMITED", "Too many requests", retryAfterSeconds ? { retryAfterSeconds } : undefined);
}

export function providerError(
  code: ErrorCode,
  message: string,
  opts?: { status?: number; details?: unknown },
): AppError {
  return new AppError(opts?.status ?? 502, code, message, opts?.details);
}

export function toErrorPayload(err: unknown, requestId: string): {
  status: number;
  body: { success: false; error: { code: string; message: string; requestId: string } };
  headers?: Record<string, string>;
} {
  if (err instanceof AppError) {
    const headers: Record<string, string> = {};
    if (err.code === "RATE_LIMITED") {
      const retry = (err.details as { retryAfterSeconds?: number } | undefined)?.retryAfterSeconds;
      if (retry) headers["Retry-After"] = String(retry);
    }
    return {
      status: err.status,
      body: { success: false, error: { code: err.code, message: err.message, requestId } },
      headers,
    };
  }
  const message = process.env.NODE_ENV === "production" ? "Unexpected server error" : err instanceof Error ? err.message : "Unexpected server error";
  return {
    status: 500,
    body: { success: false, error: { code: "INTERNAL_ERROR", message, requestId } },
  };
}
