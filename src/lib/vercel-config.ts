/** Hosting-specific checks. No network access and no credential values in errors. */
export function vercelConfigurationIssues(env: Record<string, string | undefined>): string[] {
  const issues: string[] = [];
  if (env.STORAGE_PROVIDER !== 's3') issues.push('STORAGE_PROVIDER must be s3 on Vercel; local files are not durable');
  for (const key of ['S3_ENDPOINT', 'S3_BUCKET', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY']) {
    if (!env[key]?.trim()) issues.push(`${key} is required on Vercel`);
  }
  for (const [key, protocols] of [
    ['APP_URL', ['https:']], ['DATABASE_URL', ['postgres:', 'postgresql:']],
    ['REDIS_URL', ['rediss:']], ['S3_ENDPOINT', ['https:']],
  ] as const) {
    try {
      const url = new URL(env[key] ?? '');
      if (!(protocols as readonly string[]).includes(url.protocol)) issues.push(`${key} has an unsupported protocol`);
      if (['localhost', '127.0.0.1', '[::1]', 'postgres', 'redis', 'minio'].includes(url.hostname)) {
        issues.push(`${key} must reference a remote service, not a local Docker hostname`);
      }
      if (key === 'APP_URL' && (url.username || url.password || url.search || url.hash || url.pathname !== '/')) {
        issues.push('APP_URL must be an HTTPS origin without credentials, path, query or fragment');
      }
    } catch { issues.push(`${key} must be a valid URL`); }
  }
  const maxUpload = Number(env.MAX_UPLOAD_BYTES ?? 25 * 1024 * 1024);
  if (!Number.isInteger(maxUpload) || maxUpload < 1 || maxUpload > 4 * 1024 * 1024) {
    issues.push('MAX_UPLOAD_BYTES must be between 1 and 4194304 on Vercel (multipart overhead needs headroom)');
  }
  const pool = Number(env.DB_POOL_MAX ?? 2);
  if (!Number.isInteger(pool) || pool < 1 || pool > 5) issues.push('DB_POOL_MAX must be between 1 and 5 on Vercel; use a managed pooler');
  if (env.TRUST_PROXY !== 'true') issues.push('TRUST_PROXY must be true behind Vercel');
  for (const kind of ['LLM', 'EMBEDDING', 'STT', 'TTS']) {
    const provider = env[`${kind}_PROVIDER`];
    if (provider === 'compatible' || provider === 'gemini') {
      if (!env.COMPATIBLE_LLM_API_KEY?.trim()) issues.push(`COMPATIBLE_LLM_API_KEY is required for ${kind}_PROVIDER`);
    }
  }
  if (env.LLM_PROVIDER === 'compatible' && !env.COMPATIBLE_LLM_MODEL?.trim()) issues.push('COMPATIBLE_LLM_MODEL is required');
  return issues;
}
