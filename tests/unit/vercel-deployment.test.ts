import { afterEach, describe, expect, it, vi } from 'vitest';
import { vercelConfigurationIssues } from '../../src/lib/vercel-config';
const valid = {
  APP_URL: 'https://demo.example.com', DATABASE_URL: 'postgresql://user:pass@db.example.com/app?sslmode=require',
  REDIS_URL: 'rediss://user:pass@redis.example.com:6379', STORAGE_PROVIDER: 's3',
  S3_ENDPOINT: 'https://storage.example.com', S3_BUCKET: 'demo', S3_ACCESS_KEY_ID: 'key',
  S3_SECRET_ACCESS_KEY: 'secret', MAX_UPLOAD_BYTES: '4194304', DB_POOL_MAX: '2', TRUST_PROXY: 'true',
};
describe('Vercel deployment guards', () => {
  it('accepts remote durable services without attempting connections', () => {
    expect(vercelConfigurationIssues(valid)).toEqual([]);
  });
  it('rejects local storage, Docker hosts and oversized uploads', () => {
    const errors = vercelConfigurationIssues({ ...valid, STORAGE_PROVIDER: 'local', DATABASE_URL: 'postgresql://postgres/app', REDIS_URL: 'redis://redis:6379', MAX_UPLOAD_BYTES: '26214400' });
    expect(errors.join(' ')).toMatch(/not durable/);
    expect(errors.join(' ')).toMatch(/Docker hostname/);
    expect(errors.join(' ')).toMatch(/unsupported protocol/);
    expect(errors.join(' ')).toMatch(/MAX_UPLOAD_BYTES/);
  });
  it('rejects malformed origins and pool sizes without exposing credentials', () => {
    const errors = vercelConfigurationIssues({ ...valid, APP_URL: 'https://user:DO_NOT_PRINT@example.com/path', DB_POOL_MAX: 'NaN' });
    expect(errors.join(' ')).toMatch(/APP_URL/);
    expect(errors.join(' ')).toMatch(/DB_POOL_MAX/);
    expect(errors.join(' ')).not.toContain('DO_NOT_PRINT');
    expect(vercelConfigurationIssues({ ...valid, S3_ENDPOINT: 'invalid' }).join(' ')).toMatch(/valid URL/);
  });
  it('requires actual compatible-provider settings and all storage keys', () => {
    const errors = vercelConfigurationIssues({ ...valid, LLM_PROVIDER: 'compatible', STT_PROVIDER: 'gemini', S3_BUCKET: '', TRUST_PROXY: 'false' });
    for (const key of ['S3_BUCKET', 'TRUST_PROXY', 'COMPATIBLE_LLM_MODEL', 'COMPATIBLE_LLM_API_KEY']) expect(errors.join(' ')).toContain(key);
  });
});
const mocks = vi.hoisted(() => ({ register: vi.fn(), outbox: vi.fn(), job: vi.fn() }));
vi.mock('@/lib/services/outbox-handlers', () => ({ registerDefaultOutboxHandlers: mocks.register }));
vi.mock('@/lib/services/outbox', () => ({ processNextOutboxEvent: mocks.outbox }));
vi.mock('@/lib/services/jobs', () => ({ processNextJob: mocks.job }));
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });
describe('bounded operator worker endpoint', () => {
  const secret = 'x'.repeat(40);
  it('fails closed with no scheduler secret', async () => {
    vi.stubEnv('CRON_SECRET', '');
    const { GET } = await import('../../src/app/api/internal/worker/route');
    expect((await GET(new Request('https://demo/api/internal/worker'))).status).toBe(503);
    expect(mocks.register).not.toHaveBeenCalled();
  });
  it('rejects missing, same-length wrong and query-string tokens before work', async () => {
    vi.stubEnv('CRON_SECRET', secret);
    const { GET } = await import('../../src/app/api/internal/worker/route');
    for (const authorization of ['', `Bearer ${'z'.repeat(40)}`]) {
      const r = await GET(new Request(`https://demo/api/internal/worker?token=${secret}`, { headers: { authorization } }));
      expect(r.status).toBe(401);
    }
    expect(mocks.outbox).not.toHaveBeenCalled();
  });
  it('attempts only one event and one job without claiming provider success', async () => {
    vi.stubEnv('CRON_SECRET', secret); mocks.outbox.mockResolvedValue(true); mocks.job.mockResolvedValue(false);
    const { POST } = await import('../../src/app/api/internal/worker/route');
    const r = await POST(new Request('https://demo/api/internal/worker', { method: 'POST', headers: { authorization: `Bearer ${secret}` } }));
    expect(r.status).toBe(200);
    expect((await r.json()).data).toEqual({ outboxAttempted: true, automationAttempted: false });
    expect(mocks.outbox).toHaveBeenCalledTimes(1); expect(mocks.job).toHaveBeenCalledTimes(1);
  });
  it('returns a redacted error when infrastructure fails', async () => {
    vi.stubEnv('CRON_SECRET', secret); mocks.outbox.mockRejectedValueOnce(new Error('private-db-password'));
    const { GET } = await import('../../src/app/api/internal/worker/route');
    const r = await GET(new Request('https://demo/api/internal/worker', { headers: { authorization: `Bearer ${secret}` } }));
    expect(r.status).toBe(500); expect(await r.text()).not.toContain('private-db-password');
    expect(mocks.job).not.toHaveBeenCalled();
  });
});
