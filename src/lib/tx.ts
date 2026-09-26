import { sql, type SQL } from "drizzle-orm";

type ExecutableTx = {
  execute: (query: SQL<unknown>) => Promise<unknown>;
};

/**
 * Take a transaction-scoped Postgres advisory lock for `key`.
 * Serializes concurrent writers for the same logical entity (call transcript,
 * tool execution, lead upsert) inside a `db.transaction` block.
 * The lock is released automatically at transaction end; no holder cleanup.
 */
export async function advisoryXactLock(tx: ExecutableTx, key: string): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${key}))`);
}
