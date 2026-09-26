import { z } from "zod";

const nodeEnv = process.env.NODE_ENV ?? "development";
export const isProduction = nodeEnv === "production";
export const isTest = nodeEnv === "test";
export const isDev = !isProduction && !isTest;

const providerEnum = z.enum(["openai", "compatible", "dev"]);
const storageEnum = z.enum(["local", "s3"]);
const voiceEnum = z.enum(["generic", "dev"]);

/**
 * Schema-based environment validation.
 * Production fails fast when critical configuration is missing.
 */
const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3000),
  APP_URL: z.string().default("http://localhost:3000"),
  NEXT_PUBLIC_APP_NAME: z.string().default("AI Receptionist"),

  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),

  REDIS_URL: z.string().default(""),
  JWT_SECRET: z.string().default(""),
  JWT_REFRESH_SECRET: z.string().default(""),
  JWT_ACCESS_EXPIRE_MINUTES: z.coerce.number().int().positive().default(15),
  JWT_REFRESH_EXPIRE_DAYS: z.coerce.number().int().positive().default(30),
  TRUST_PROXY: z
    .string()
    .default("false")
    .transform((v) => v === "true"),

  VOICE_WEBHOOK_SECRET: z.string().default(""),
  N8N_WEBHOOK_SECRET: z.string().default(""),

  LLM_PROVIDER: providerEnum.default("dev"),
  OPENAI_API_KEY: z.string().default(""),
  OPENAI_BASE_URL: z.string().default("https://api.openai.com/v1"),
  LLM_MODEL: z.string().default("gpt-4o-mini"),
  LLM_TIMEOUT_MS: z.coerce.number().int().positive().default(60_000),
  LLM_MAX_RETRIES: z.coerce.number().int().min(0).max(5).default(2),

  COMPATIBLE_LLM_BASE_URL: z.string().default(""),
  COMPATIBLE_LLM_API_KEY: z.string().default(""),
  COMPATIBLE_LLM_MODEL: z.string().default(""),

  EMBEDDING_PROVIDER: providerEnum.default("dev"),
  EMBEDDING_MODEL: z.string().default("text-embedding-3-small"),
  EMBEDDING_DIMENSIONS: z.coerce.number().int().positive().default(1536),

  VOICE_PROVIDER: voiceEnum.default("dev"),
  VOICE_API_BASE_URL: z.string().default(""),
  VOICE_API_KEY: z.string().default(""),
  VOICE_DEFAULT_LANGUAGE: z.string().default("fa-IR"),
  VOICE_AUTO_ANSWER: z
    .string()
    .default("true")
    .transform((v) => v !== "false"),
  /** Public WebSocket URL of the media sidecar (wss://...); empty disables gateway streaming. */
  VOICE_MEDIA_PUBLIC_URL: z.string().default(""),
  /** Shared token authenticating gateways to the media sidecar. */
  VOICE_MEDIA_TOKEN: z.string().default(""),
  VOICE_MEDIA_PORT: z.coerce.number().int().positive().default(3001),

  STT_PROVIDER: providerEnum.default("dev"),
  STT_MODEL: z.string().default("whisper-1"),
  STT_TIMEOUT_MS: z.coerce.number().int().positive().default(60_000),

  TTS_PROVIDER: providerEnum.default("dev"),
  TTS_MODEL: z.string().default("tts-1"),
  TTS_VOICE: z.string().default("alloy"),
  TTS_TIMEOUT_MS: z.coerce.number().int().positive().default(60_000),

  STORAGE_PROVIDER: storageEnum.default("local"),
  LOCAL_STORAGE_DIR: z.string().default("./storage"),
  MAX_UPLOAD_BYTES: z.coerce.number().int().positive().default(25 * 1024 * 1024),
  ALLOWED_UPLOAD_MIME: z
    .string()
    .default(
      "application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain,text/markdown",
    ),

  S3_ENDPOINT: z.string().default(""),
  S3_REGION: z.string().default("us-east-1"),
  S3_BUCKET: z.string().default("ai-receptionist"),
  S3_ACCESS_KEY_ID: z.string().default(""),
  S3_SECRET_ACCESS_KEY: z.string().default(""),
  S3_FORCE_PATH_STYLE: z
    .string()
    .default("false")
    .transform((v) => v === "true"),

  NOTIFICATION_DEFAULT_CHANNEL: z.enum(["email", "internal"]).default("internal"),
  SMTP_HOST: z.string().default(""),
  SMTP_PORT: z.coerce.number().int().positive().default(587),
  SMTP_SECURE: z
    .string()
    .default("false")
    .transform((v) => v === "true"),
  SMTP_USER: z.string().default(""),
  SMTP_PASS: z.string().default(""),
  SMTP_FROM: z.string().default("no-reply@example.com"),

  N8N_ENABLED: z
    .string()
    .default("false")
    .transform((v) => v === "true"),
  N8N_URL: z.string().default("http://localhost:5678"),
  N8N_API_KEY: z.string().default(""),
  N8N_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),

  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  SENTRY_DSN: z.string().default(""),
  SENTRY_ENVIRONMENT: z.string().default("production"),
  SENTRY_TRACES_SAMPLE_RATE: z.coerce.number().min(0).max(1).default(0.1),
});

export type AppEnv = z.infer<typeof envSchema>;

function fail(message: string): never {
  throw new Error(`[env] ${message}`);
}

function loadEnv(): AppEnv {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const details = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    fail(`Invalid environment configuration: ${details}`);
  }
  const e = parsed.data;

  if (isProduction) {
    if (!e.REDIS_URL) fail("REDIS_URL is required in production");
    if (e.JWT_SECRET.length < 32) fail("JWT_SECRET must be at least 32 characters in production");
    if (e.JWT_REFRESH_SECRET.length < 32)
      fail("JWT_REFRESH_SECRET must be at least 32 characters in production");
    if (!e.VOICE_WEBHOOK_SECRET) fail("VOICE_WEBHOOK_SECRET is required in production");
    if (!e.N8N_WEBHOOK_SECRET) fail("N8N_WEBHOOK_SECRET is required in production");
    if (["openai"].includes(e.LLM_PROVIDER) && !e.OPENAI_API_KEY)
      fail("OPENAI_API_KEY is required when LLM_PROVIDER=openai");
    if (e.LLM_PROVIDER === "compatible" && !e.COMPATIBLE_LLM_BASE_URL)
      fail("COMPATIBLE_LLM_BASE_URL is required when LLM_PROVIDER=compatible");
    if (e.LLM_PROVIDER === "dev") fail("LLM_PROVIDER=dev is not allowed in production");
    if (e.STT_PROVIDER === "dev") fail("STT_PROVIDER=dev is not allowed in production");
    if (e.TTS_PROVIDER === "dev") fail("TTS_PROVIDER=dev is not allowed in production");
    if (e.EMBEDDING_PROVIDER === "dev") fail("EMBEDDING_PROVIDER=dev is not allowed in production");
    if (e.VOICE_PROVIDER === "dev") fail("VOICE_PROVIDER=dev is not allowed in production");
    if (e.VOICE_PROVIDER === "generic" && (!e.VOICE_API_BASE_URL || !e.VOICE_API_KEY))
      fail("VOICE_API_BASE_URL and VOICE_API_KEY are required when VOICE_PROVIDER=generic");
    if (e.STT_PROVIDER === "openai" && !e.OPENAI_API_KEY)
      fail("OPENAI_API_KEY is required when STT_PROVIDER=openai");
    if (e.TTS_PROVIDER === "openai" && !e.OPENAI_API_KEY)
      fail("OPENAI_API_KEY is required when TTS_PROVIDER=openai");
    if (e.EMBEDDING_PROVIDER === "openai" && !e.OPENAI_API_KEY)
      fail("OPENAI_API_KEY is required when EMBEDDING_PROVIDER=openai");
    if (e.STORAGE_PROVIDER === "s3" && (!e.S3_ENDPOINT || !e.S3_ACCESS_KEY_ID || !e.S3_SECRET_ACCESS_KEY))
      fail("S3_ENDPOINT, S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY are required when STORAGE_PROVIDER=s3");
  }

  return e;
}

let cached: AppEnv | null = null;

/** Validated environment (cached). Throws on invalid config. */
export function getEnv(): AppEnv {
  if (!cached) cached = loadEnv();
  return cached;
}

/** Test-only: reset cached env so process.env changes take effect. */
export function resetEnvCache(): void {
  cached = null;
}

/**
 * Backwards-compatible env export used across the codebase.
 * Prefer `getEnv()` in new code.
 */
export const env = {
  get jwtSecret() {
    return getEnv().JWT_SECRET || "dev-jwt-secret-change-me";
  },
  get jwtRefreshSecret() {
    return getEnv().JWT_REFRESH_SECRET || getEnv().JWT_SECRET || "dev-jwt-refresh-secret-change-me";
  },
  get jwtAccessExpireMinutes() {
    return getEnv().JWT_ACCESS_EXPIRE_MINUTES;
  },
  get jwtRefreshExpireDays() {
    return getEnv().JWT_REFRESH_EXPIRE_DAYS;
  },
  get webhookSecret() {
    return getEnv().VOICE_WEBHOOK_SECRET || "dev-webhook-secret";
  },
  get n8nWebhookSecret() {
    return getEnv().N8N_WEBHOOK_SECRET || "dev-webhook-secret";
  },
  get appName() {
    return getEnv().NEXT_PUBLIC_APP_NAME;
  },
};

export function describeProviderConfig(): Record<string, string> {
  const e = getEnv();
  return {
    llm: e.LLM_PROVIDER,
    embedding: e.EMBEDDING_PROVIDER,
    stt: e.STT_PROVIDER,
    tts: e.TTS_PROVIDER,
    voice: e.VOICE_PROVIDER,
    storage: e.STORAGE_PROVIDER,
  };
}
