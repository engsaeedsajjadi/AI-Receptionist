import { logInfo } from "@/lib/logger";
import { reapStuckTransfers } from "@/lib/services/calls";
import { reapStaleNotifications } from "@/lib/services/notifications";
import { pruneExpiredRefreshTokens } from "@/lib/auth";
import { drainOutbox } from "@/lib/services/outbox";
import { registerDefaultOutboxHandlers } from "@/lib/services/outbox-handlers";
import { purgeExpiredExports } from "@/lib/services/data-governance";
import { runWebhookDeliveryTick } from "@/lib/services/tenant-webhooks";

export interface MaintenanceOptions {
  transferStaleSeconds?: number;
  notificationStaleSeconds?: number;
  requestId?: string;
  outboxLimit?: number;
  webhookLimit?: number;
  purgeExports?: boolean;
}

export interface MaintenanceResult {
  reapedTransfers: number;
  reapedNotifications: number;
  prunedTokens: number;
  outbox: { processed: number; delivered: number; failed: number; dead: number };
  webhooks: { attempted: number; delivered: number; failed: number; dead: number };
  purgedExports: number;
}

/**
 * Periodic hygiene for lifecycle rows (safe for cron AND manual triggers):
 * stuck transfers, orphaned PENDING notifications, long-expired tokens.
 * Every sub-task is idempotent (conditional claims / cutoff deletes), so
 * overlapping runs are harmless. Called by scripts/maintenance.ts (cron)
 * and POST /api/v1/admin/maintenance (ADMIN-only manual trigger).
 */
export async function runMaintenance(opts: MaintenanceOptions = {}): Promise<MaintenanceResult> {
  registerDefaultOutboxHandlers();
  const [transfers, notifications, prunedTokens, outbox, webhooks, exportsPurged] = await Promise.all([
    reapStuckTransfers(opts.transferStaleSeconds ?? 300, { requestId: opts.requestId }),
    reapStaleNotifications(opts.notificationStaleSeconds ?? 600, { requestId: opts.requestId }),
    pruneExpiredRefreshTokens(),
    drainOutbox(opts.outboxLimit ?? 50),
    runWebhookDeliveryTick(opts.webhookLimit ?? 20),
    opts.purgeExports === false ? Promise.resolve({ purged: 0 }) : purgeExpiredExports(25),
  ]);
  const result = {
    reapedTransfers: transfers.reaped,
    reapedNotifications: notifications.reaped,
    prunedTokens,
    outbox,
    webhooks,
    purgedExports: exportsPurged.purged,
  };
  logInfo("Maintenance sweep completed", {
    requestId: opts.requestId,
    operation: "maintenance.sweep",
    status: "ok",
  });
  return result;
}
