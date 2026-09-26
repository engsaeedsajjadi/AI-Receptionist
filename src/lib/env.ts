export const env = {
  jwtSecret: process.env.JWT_SECRET ?? "dev-jwt-secret-change-me",
  jwtAccessExpireMinutes: Number(process.env.JWT_ACCESS_EXPIRE_MINUTES ?? 30),
  jwtRefreshExpireDays: Number(process.env.JWT_REFRESH_EXPIRE_DAYS ?? 30),
  webhookSecret: process.env.N8N_WEBHOOK_SECRET ?? process.env.VOICE_API_KEY ?? "dev-webhook-secret",
  appName: process.env.NEXT_PUBLIC_APP_NAME ?? "AI Receptionist",
};
