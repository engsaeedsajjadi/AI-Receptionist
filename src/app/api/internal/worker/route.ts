import { timingSafeEqual } from 'node:crypto';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/** Infrastructure endpoint, not a tenant API. Never accepts user JWTs or URL tokens. */
export async function GET(req: Request): Promise<Response> {
  const secret = process.env.CRON_SECRET;
  const headers = { 'Cache-Control': 'no-store' };
  if (!secret || secret.length < 32) {
    return Response.json({ success: false, error: { code: 'WORKER_NOT_CONFIGURED' } }, { status: 503, headers });
  }
  const actual = Buffer.from(req.headers.get('authorization') ?? '');
  const expected = Buffer.from(`Bearer ${secret}`);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    return Response.json({ success: false, error: { code: 'UNAUTHORIZED' } }, { status: 401, headers });
  }
  try {
    const { registerDefaultOutboxHandlers } = await import('@/lib/services/outbox-handlers');
    const { processNextOutboxEvent } = await import('@/lib/services/outbox');
    const { processNextJob } = await import('@/lib/services/jobs');
    registerDefaultOutboxHandlers();
    // No daemon / unbounded loop. Existing database leases protect concurrent ticks.
    // Each call handles at most one event and one automation job; retries stay in DB.
    const outboxAttempted = await processNextOutboxEvent();
    const automationAttempted = await processNextJob();
    return Response.json({ success: true, data: { outboxAttempted, automationAttempted } }, { headers });
  } catch {
    // Avoid returning provider credentials, tenant payloads or database URLs.
    return Response.json({ success: false, error: { code: 'WORKER_TICK_FAILED' } }, { status: 500, headers });
  }
}

export const POST = GET;
