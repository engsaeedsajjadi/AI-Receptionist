import pino from "pino";
import { getEnv } from "@/lib/env";

const SECRET_KEYS = new Set([
  // Normalized to lowercase before comparison (matches "Authorization",
  // "API_KEY", ... regardless of producer casing).
  "authorization",
  "cookie",
  "set-cookie",
  "api_key",
  "apikey",
  "api-key",
  "password",
  "passwordhash",
  "passwd",
  "secret",
  "client_secret",
  "token",
  "refreshtoken",
  "accesstoken",
  "idtoken",
  "sessiontoken",
  "database_url",
  "redis_url",
  "jwt_secret",
  "jwt_refresh_secret",
  "openai_api_key",
  "compatible_llm_api_key",
  "voice_api_key",
  "voice_webhook_secret",
  "voice_media_token",
  "n8n_api_key",
  "n8n_webhook_secret",
  "n8n_basic_auth_password",
  "smtp_pass",
  "smtp_user",
  "s3_secret_access_key",
  "s3_access_key_id",
  "telegram_bot_token",
]);

function isSecretKey(key: string): boolean {
  return SECRET_KEYS.has(key.toLowerCase());
}

function redact(value: unknown, key?: string): unknown {
  if (key && isSecretKey(key)) return "[REDACTED]";
  if (typeof value === "string") {
    // Redact bearer tokens / long hex secrets that may hide in messages.
    if (/bearer\s+[A-Za-z0-9\-._~+/=]+/i.test(value)) return value.replace(/(bearer\s+)[A-Za-z0-9\-._~+/=]+/gi, "$1[REDACTED]");
    return value;
  }
  if (Array.isArray(value)) return value.map((v) => redact(v));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = isSecretKey(k) ? "[REDACTED]" : redact(v, k);
    }
    return out;
  }
  return value;
}

export type LogContext = {
  requestId?: string;
  businessId?: string;
  userId?: string;
  callId?: string;
  provider?: string;
  operation?: string;
  durationMs?: number;
  status?: string;
  errorCode?: string;
  [key: string]: unknown;
};

let instance: pino.Logger | null = null;

function createLogger(): pino.Logger {
  let level: pino.Level = "info";
  try {
    level = getEnv().LOG_LEVEL;
  } catch {
    level = process.env.LOG_LEVEL === "debug" ? "debug" : "info";
  }
  return pino({
    level,
    base: { service: "ai-receptionist" },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: {
      // Second layer (the manual redact() above is the first). Keys are
      // case-sensitive here, so cover the common casings explicitly.
      paths: [
        "authorization",
        "Authorization",
        "headers.authorization",
        "headers.Authorization",
        "headers.cookie",
        "headers.Cookie",
        "password",
        "Password",
        "passwordHash",
        "refreshToken",
        "accessToken",
        "token",
        "secret",
        "*.password",
        "*.Password",
        "*.token",
        "*.secret",
        "*.apiKey",
        "*.api_key",
        "*._secret",
      ],
      censor: "[REDACTED]",
    },
  });
}

export function logger(): pino.Logger {
  if (!instance) {
    try {
      instance = createLogger();
    } catch {
      // pino-pretty is optional in dev; fall back to plain pino.
      instance = pino({ level: "info", base: { service: "ai-receptionist" } });
    }
  }
  return instance;
}

export function logInfo(message: string, ctx: LogContext = {}): void {
  logger().info(redact(ctx) as object, message);
}

export function logWarn(message: string, ctx: LogContext = {}): void {
  logger().warn(redact(ctx) as object, message);
}

export function logError(message: string, ctx: LogContext & { error?: unknown } = {}): void {
  const { error, ...rest } = ctx;
  const err = error instanceof Error ? { name: error.name, message: error.message, stack: process.env.NODE_ENV === "production" ? undefined : error.stack } : error;
  logger().error({ ...(redact(rest) as object), error: redact(err) }, message);
}

export function redactForLog<T>(value: T): T {
  return redact(value) as T;
}
