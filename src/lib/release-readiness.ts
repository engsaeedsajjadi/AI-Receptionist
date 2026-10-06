export type ReadinessItem = {
  provider: string;
  configured: boolean;
  requiredForVoiceGoLive: boolean;
  note: string;
};

export type RuntimeReadiness = {
  coreReady: boolean;
  providers: Record<string, ReadinessItem>;
  capabilities: Record<string, boolean>;
};

/**
 * Secret-safe configuration summary for UI/release gates.
 *
 * This deliberately reports configuration, not provider health. Live acceptance
 * stays a separate gate so a filled API key can never be mistaken for a tested
 * PSTN/payment/storage integration.
 */
export function runtimeReadiness(env: NodeJS.ProcessEnv = process.env): RuntimeReadiness {
  const value = (key: string) => (env[key] ?? "").trim();
  const enabled = (key: string, fallback = false) => {
    const raw = value(key);
    return raw ? raw === "true" : fallback;
  };
  const provider = (key: string, fallback = "dev") => value(key) || fallback;

  const llmProvider = provider("LLM_PROVIDER");
  const embeddingProvider = provider("EMBEDDING_PROVIDER");
  const sttProvider = provider("STT_PROVIDER");
  const ttsProvider = provider("TTS_PROVIDER");
  const voiceProvider = provider("VOICE_PROVIDER");
  const storageProvider = provider("STORAGE_PROVIDER", "local");
  const paymentProvider = provider("PAYMENT_PROVIDER", "disabled");
  const autoAnswer = enabled("VOICE_AUTO_ANSWER", true);

  const openAi = Boolean(value("OPENAI_API_KEY"));
  const compatible = Boolean(value("COMPATIBLE_LLM_BASE_URL"));
  const aiConfigured = (name: string) =>
    name === "openai" ? openAi : name === "compatible" ? compatible : false;

  const mediaConfigured = !autoAnswer || Boolean(value("VOICE_MEDIA_PUBLIC_URL") && value("VOICE_MEDIA_TOKEN"));
  const voiceConfigured =
    voiceProvider === "twilio"
      ? Boolean(value("TWILIO_ACCOUNT_SID") && value("TWILIO_AUTH_TOKEN")) && mediaConfigured
      : voiceProvider === "generic"
        ? Boolean(value("VOICE_API_BASE_URL") && value("VOICE_API_KEY")) && mediaConfigured
        : false;

  const storageConfigured =
    storageProvider === "s3"
      ? Boolean(value("S3_ENDPOINT") && value("S3_BUCKET") && value("S3_ACCESS_KEY_ID") && value("S3_SECRET_ACCESS_KEY"))
      : storageProvider === "local";

  const providers: Record<string, ReadinessItem> = {
    llm: {
      provider: llmProvider,
      configured: aiConfigured(llmProvider),
      requiredForVoiceGoLive: true,
      note: "مدل مکالمه",
    },
    embeddings: {
      provider: embeddingProvider,
      configured: aiConfigured(embeddingProvider),
      requiredForVoiceGoLive: true,
      note: "Embedding برای RAG",
    },
    stt: {
      provider: sttProvider,
      configured: aiConfigured(sttProvider),
      requiredForVoiceGoLive: true,
      note: "تبدیل گفتار به متن",
    },
    tts: {
      provider: ttsProvider,
      configured: aiConfigured(ttsProvider),
      requiredForVoiceGoLive: true,
      note: "تبدیل متن به گفتار",
    },
    telephony: {
      provider: voiceProvider,
      configured: voiceConfigured,
      requiredForVoiceGoLive: true,
      note: autoAnswer ? "Gateway + Media WebSocket" : "Gateway (auto-answer خاموش)",
    },
    storage: {
      provider: storageProvider,
      configured: storageConfigured,
      requiredForVoiceGoLive: true,
      note: storageProvider === "local" ? "Local storage؛ برای production S3 توصیه می‌شود" : "S3-compatible storage",
    },
    smtp: {
      provider: "smtp",
      configured: Boolean(value("SMTP_HOST") && value("SMTP_FROM")),
      requiredForVoiceGoLive: false,
      note: "ایمیل دعوت/اعلان",
    },
    whatsapp: {
      provider: "meta-cloud",
      configured: Boolean(value("WHATSAPP_ACCESS_TOKEN") && value("WHATSAPP_PHONE_NUMBER_ID")),
      requiredForVoiceGoLive: false,
      note: "WhatsApp notifications",
    },
    payment: {
      provider: paymentProvider,
      configured: paymentProvider === "disabled"
        ? false
        : paymentProvider === "test"
          ? env.NODE_ENV !== "production"
          : Boolean(value("PAYMENT_API_BASE_URL") && value("PAYMENT_API_KEY") && value("PAYMENT_WEBHOOK_SECRET")),
      requiredForVoiceGoLive: false,
      note: "پرداخت اشتراک؛ برای پذیرش تماس الزامی نیست",
    },
    oidcGoogle: {
      provider: "google",
      configured: Boolean(value("GOOGLE_CLIENT_ID") && value("GOOGLE_CLIENT_SECRET")),
      requiredForVoiceGoLive: false,
      note: "Google OIDC",
    },
    oidcMicrosoft: {
      provider: "microsoft",
      configured: Boolean(value("MICROSOFT_CLIENT_ID") && value("MICROSOFT_CLIENT_SECRET") && value("MICROSOFT_TENANT_ID")),
      requiredForVoiceGoLive: false,
      note: "Microsoft OIDC",
    },
    telemetry: {
      provider: value("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT") ? "otel" : value("SENTRY_DSN") ? "sentry" : "local-metrics",
      configured: Boolean(value("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT") || value("SENTRY_DSN")),
      requiredForVoiceGoLive: false,
      note: "External telemetry/Sentry",
    },
  };

  const coreReady = Object.values(providers)
    .filter((item) => item.requiredForVoiceGoLive)
    .every((item) => item.configured);

  return {
    coreReady,
    providers,
    capabilities: {
      transactionalOutbox: true,
      pwa: true,
      voiceLab: true,
      liveCallConsole: true,
      tenantIsolation: true,
      refreshRotation: true,
      ragAcl: true,
      billingLedger: true,
    },
  };
}
