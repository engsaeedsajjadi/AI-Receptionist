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
  "audit_logs",
  "webhook_events",
  "usage_records",
  "automation_dispatches",
  "notifications",
  "appointments",
  "call_messages",
  "calls",
  "knowledge_chunks",
  "knowledge_documents",
  "lead_notes",
  "leads",
  "properties",
  "refresh_tokens",
  "agents",
  "customers",
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
