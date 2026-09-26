import { logInfo } from "@/lib/logger";
import { reapStuckTransfers } from "@/lib/services/calls";
import { reapStaleNotifications } from "@/lib/services/notifications";
import { pruneExpiredRefreshTokens } from "@/lib/auth";

export interface MaintenanceOptions {
  transferStaleSeconds?: number;
  notificationStaleSeconds?: number;
  requestId?: string;
}

export interface MaintenanceResult {
  reapedTransfers: number;
  reapedNotifications: number;
  prunedTokens: number;
}

/**
 * Periodic hygiene for lifecycle rows (safe for cron AND manual triggers):
 * stuck transfers, orphaned PENDING notifications, long-expired tokens.
 * Every sub-task is idempotent (conditional claims / cutoff deletes), so
 * overlapping runs are harmless. Called by scripts/maintenance.ts (cron)
 * and POST /api/v1/admin/maintenance (ADMIN-only manual trigger).
 */
export async function runMaintenance(opts: MaintenanceOptions = {}): Promise<MaintenanceResult> {
  const [transfers, notifications, prunedTokens] = await Promise.all([
    reapStuckTransfers(opts.transferStaleSeconds ?? 300, { requestId: opts.requestId }),
    reapStaleNotifications(opts.notificationStaleSeconds ?? 600, { requestId: opts.requestId }),
    pruneExpiredRefreshTokens(),
  ]);
  const result = {
    reapedTransfers: transfers.reaped,
    reapedNotifications: notifications.reaped,
    prunedTokens,
  };
  logInfo("Maintenance sweep completed", {
    requestId: opts.requestId,
    operation: "maintenance.sweep",
    status: "ok",
  });
  return result;
}
