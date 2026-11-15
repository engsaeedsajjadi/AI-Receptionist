import { sql } from "drizzle-orm";
import { it } from "vitest";
import { db } from "@/db";

if (process.env.TEST_DATABASE_URL && !process.env.DATABASE_URL) {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
}

/** True when integration tests can run against a REAL database. */
export function hasTestDatabase(): boolean {
  if (process.env.VITEST_DUMMY_DB === "1" && !process.env.TEST_DATABASE_URL) return false;
  return Boolean(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
}

const TABLES = [
  // Billing ledgers (append-only, tenant-scoped).
  "credit_notes",
  "refund_records",
  "payment_transactions",
  "payment_attempts",
  "subscription_events",
  "payment_events",
  "payment_providers",
  "billing_invoices",
  "subscriptions",
  "quota_reservations",
  "quota_buckets",
  "quota_overrides",
  // Metering, metered AI and usage-driven quota state.
  "usage_records",
  "retrieval_events",
  "storage_objects",
  "provider_events",
  "outbox_events",
  // Tenant-scoped operational tables.
  "audit_logs",
  "webhook_events",
  "webhook_deliveries",
  "webhook_endpoints",
  "automation_dispatches",
  "automation_jobs",
  "notifications",
  "appointments",
  "call_messages",
  "calls",
  "knowledge_documents",
  "knowledge_chunks",
  "lead_notes",
  "leads",
  "properties",
  "refresh_tokens",
  "identity_tokens",
  "oauth_accounts",
  "api_keys",
  "service_accounts",
  "invitations",
  "support_sessions",
  "data_exports",
  "agent_versions",
  "crm_tasks",
  "crm_opportunities",
  "crm_pipelines",
  "agents",
  "customers",
  "user_roles",
  "role_permissions",
  "roles",
  "users",
  "businesses",
];

/** Truncate all tenant tables (order-safe via CASCADE). */
export async function truncateAll(): Promise<void> {
  await db.execute(sql.raw(`TRUNCATE ${TABLES.join(", ")} RESTART IDENTITY CASCADE`));
}

export async function canConnect(): Promise<boolean> {
  try {
    await db.execute(sql`select 1`);
    return true;
  } catch {
    return false;
  }
}

let dbReady: boolean | null = null;

/** Check real DB reachability once and cache the result. */
export async function ensureDbReady(): Promise<boolean> {
  if (dbReady !== null) return dbReady;
  dbReady = hasTestDatabase() && (await canConnect());
  if (!dbReady && process.env.REQUIRE_INTEGRATION_TESTS === "1") throw new Error("Required test database is unavailable");
  return dbReady;
}

type TestFn = () => Promise<void> | void;

/**
 * DB-gated test: skips at runtime when no real database is reachable.
 * Use inside describe.skipIf(!hasTestDatabase()) suites for a fast path.
 */
export function itDb(name: string, fn: TestFn, timeout?: number): void {
  it(
    name,
    async (ctx) => {
      if (!(await ensureDbReady())) {
        ctx.skip();
        return;
      }
      await fn();
    },
    timeout,
  );
}
