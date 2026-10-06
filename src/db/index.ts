import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

/**
 * Lazy database client. The pool is created on first use (not at import
 * time) so `next build` / lint / typecheck work without DATABASE_URL.
 * Any actual query without DATABASE_URL throws a clear error.
 */
type GlobalDb = typeof globalThis & {
  __aiReceptionistPool?: Pool;
  __aiReceptionistDb?: NodePgDatabase;
};

function getPool(): Pool {
  const g = globalThis as GlobalDb;
  if (g.__aiReceptionistPool) return g.__aiReceptionistPool;
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required");
  }
  const pool = new Pool({
    connectionString: databaseUrl,
    max: Number(process.env.DB_POOL_MAX ?? 10),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  });
  pool.on("error", (err) => {
    // Prevent unhandled 'error' events from crashing the process; queries
    // will surface their own errors.
    console.error("[db] pool error", err instanceof Error ? err.message : err);
  });
  g.__aiReceptionistPool = pool;
  return pool;
}

function getDb(): NodePgDatabase {
  const g = globalThis as GlobalDb;
  if (!g.__aiReceptionistDb) {
    g.__aiReceptionistDb = drizzle(getPool());
  }
  return g.__aiReceptionistDb;
}

/** Lazily-initialized pool (getter keeps old `pool` import working). */
export const pool: Pool = new Proxy({} as Pool, {
  get(_t, prop, receiver) {
    return Reflect.get(getPool(), prop, receiver);
  },
});

/** Lazily-initialized drizzle client. */
export const db: NodePgDatabase = new Proxy({} as NodePgDatabase, {
  get(_t, prop, receiver) {
    return Reflect.get(getDb(), prop, receiver);
  },
});

export async function checkDbHealth(): Promise<{ ok: boolean; latencyMs?: number; error?: string }> {
  try {
    const { sql } = await import("drizzle-orm");
    const start = Date.now();
    await getDb().execute(sql`select 1`);
    return { ok: true, latencyMs: Date.now() - start };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "db_unreachable" };
  }
}

/**
 * Migration compatibility: number of migration files shipped with this build
 * versus the migrations recorded as applied in the database. A mismatch means
 * the app is running against a schema it was not built for.
 */
export async function checkMigrationsHealth(): Promise<{ ok: boolean; expected: number; applied: number; pending: number; error?: string }> {
  try {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const journalPath = join(process.cwd(), "drizzle", "meta", "_journal.json");
    const journal = JSON.parse(readFileSync(journalPath, "utf8")) as { entries?: unknown[] };
    const expected = journal.entries?.length ?? 0;
    const { sql } = await import("drizzle-orm");
    const result = await getDb().execute(sql`SELECT count(*)::int AS count FROM drizzle.__drizzle_migrations`);
    const applied = Number((result.rows[0] as { count?: number } | undefined)?.count ?? 0);
    return { ok: applied >= expected, expected, applied, pending: Math.max(0, expected - applied) };
  } catch (err) {
    return { ok: false, expected: 0, applied: 0, pending: 0, error: err instanceof Error ? err.message : "migrations_unreadable" };
  }
}

/** Test-only: close pool. */
export async function closeDb(): Promise<void> {
  const g = globalThis as GlobalDb;
  if (g.__aiReceptionistPool) {
    await g.__aiReceptionistPool.end().catch(() => undefined);
    g.__aiReceptionistPool = undefined;
    g.__aiReceptionistDb = undefined;
  }
}
