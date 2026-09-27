/**
 * Cron maintenance sweep: reap stuck transfers, fail orphaned PENDING
 * notifications, prune long-expired refresh tokens. Idempotent — safe to
 * run every 5-15 minutes, and overlapping runs are harmless.
 *
 * Usage: npm run maintenance   (requires DATABASE_URL)
 * Cron:  *\/10 * * * * cd /app && npm run maintenance >> /var/log/ai-receptionist/maintenance.log 2>&1
 */
import "dotenv/config";
import { runMaintenance } from "../src/lib/services/maintenance";
import { closeDb } from "../src/db";

async function main() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
  const result = await runMaintenance({ requestId: `cron-${Date.now()}` });
  console.log(JSON.stringify({ ok: true, at: new Date().toISOString(), ...result }));
}

main()
  .catch((err) => {
    console.error(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }));
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDb().catch(() => undefined);
  });
