import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { automationJobs } from "@/db/schema";
import { getEnv } from "@/lib/env";
import { AppError } from "@/lib/errors";
import { requestContext } from "@/lib/request-context";
import { requireTenantFeature } from "@/lib/tenant-config";
import { emitAutomationEvent, type AutomationEvent, type EmitOptions, type AutomationResult } from "@/lib/services/n8n";
const events = new Set<AutomationEvent>(["new-lead", "call-completed", "appointment", "human-handoff", "notification"]);
export async function prepareAutomationEvent(event: AutomationEvent, payload: Record<string, unknown>, options: EmitOptions = {}): Promise<typeof automationJobs.$inferInsert | null> {
  if (!getEnv().N8N_ENABLED) return null;
  if (typeof payload.businessId !== "string" || !events.has(event)) throw new AppError(400, "VALIDATION_ERROR", "Valid tenant and event required");
  await requireTenantFeature(payload.businessId, "automation");
  const idempotencyKey = options.idempotencyKey ?? `${event}:${String(payload.id ?? crypto.randomUUID())}`;
  return { businessId: payload.businessId, event, payload, idempotencyKey };
}
export async function enqueueAutomationEvent(event: AutomationEvent, payload: Record<string, unknown>, options: EmitOptions = {}): Promise<AutomationResult> {
  const values = await prepareAutomationEvent(event, payload, options);
  if (!values) return { ok: true, skipped: true, attempts: 0 };
  await db.insert(automationJobs).values(values).onConflictDoNothing({ target: [automationJobs.businessId, automationJobs.idempotencyKey] });
  return { ok: true, attempts: 0 }; // Accepted into the durable queue, not yet delivered.
}
export function retryDelaySeconds(attempt: number): number { return Math.min(3600, 5 * 2 ** Math.min(attempt, 10)); }
/** One leased job at a time. Provider calls are outside transactions. */
export async function processNextJob(): Promise<boolean> {
  const claimId = crypto.randomUUID();
  const job = await db.transaction(async (tx) => {
    await tx.execute(sql`UPDATE automation_jobs SET status = 'dead', claim_id = NULL, lease_until = NULL, updated_at = now()
      WHERE status = 'running' AND lease_until < now() AND attempts >= 8`);
    const selected = await tx.execute<{ id: string }>(sql`SELECT id FROM automation_jobs
      WHERE attempts < 8 AND ((status = 'pending' AND available_at <= now()) OR (status = 'running' AND lease_until < now()))
      ORDER BY available_at FOR UPDATE SKIP LOCKED LIMIT 1`);
    if (!selected.rows[0]) return null;
    const [row] = await tx.update(automationJobs).set({ status: "running", claimId,
      attempts: sql`${automationJobs.attempts} + 1`, leaseUntil: new Date(Date.now() + 120_000), updatedAt: new Date() })
      .where(eq(automationJobs.id, selected.rows[0].id)).returning();
    return row;
  });
  if (!job) return false;
  let error: string | null = null;
  try {
    if (!events.has(job.event as AutomationEvent)) throw new Error("Unknown automation event");
    await requestContext.run({ requestId: job.id, traceId: job.id.replaceAll("-", ""), businessId: job.businessId }, async () => {
      const result = await emitAutomationEvent(job.event as AutomationEvent, { ...job.payload, businessId: job.businessId },
        { idempotencyKey: job.idempotencyKey, requestId: job.id, maxRetries: 0 });
      if (!result.ok || result.skipped) throw new Error(result.error ?? "Automation provider is disabled");
    });
  } catch (err) { error = err instanceof Error ? err.message.slice(0, 1000) : "delivery_failed"; }
  await db.update(automationJobs).set({ status: error ? (job.attempts >= 8 ? "dead" : "pending") : "completed",
    availableAt: new Date(Date.now() + retryDelaySeconds(job.attempts) * 1000), lastError: error,
    claimId: null, leaseUntil: null, updatedAt: new Date() }).where(and(eq(automationJobs.id, job.id), eq(automationJobs.claimId, claimId)));
  return true;
}
