/**
 * Production migration runner: enables required Postgres extensions,
 * then applies every SQL migration in ./drizzle.
 *
 * Usage: npm run db:migrate   (requires DATABASE_URL)
 */
import "dotenv/config";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { sql } from "drizzle-orm";
import { Pool } from "pg";

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required");

  const pool = new Pool({ connectionString: databaseUrl });
  const connection = await pool.connect();
  const db = drizzle(connection);
  try {
    // Serialize concurrent boots (multi-replica deploys): only one migrator
    // runs DDL at a time; the lock releases automatically on disconnect.
    console.log("[migrate] acquiring advisory lock ...");
    await db.execute(sql`SELECT pg_advisory_lock(918273645)`);
    console.log("[migrate] enabling extensions (vector, pg_trgm) ...");
    await db.execute(sql`CREATE EXTENSION IF NOT EXISTS vector`);
    await db.execute(sql`CREATE EXTENSION IF NOT EXISTS pg_trgm`);
    console.log("[migrate] applying migrations from ./drizzle ...");
    await migrate(db, { migrationsFolder: "./drizzle" });
    console.log("[migrate] creating specialized indexes (vector + trigram) ...");
    await db.execute(
      sql`CREATE INDEX IF NOT EXISTS knowledge_chunks_embedding_hnsw_idx ON knowledge_chunks USING hnsw (embedding vector_cosine_ops)`,
    );
    await db.execute(
      sql`CREATE INDEX IF NOT EXISTS knowledge_chunks_content_trgm_idx ON knowledge_chunks USING gin (content gin_trgm_ops)`,
    );
    await db.execute(
      sql`CREATE INDEX IF NOT EXISTS properties_location_trgm_idx ON properties USING gin (location gin_trgm_ops)`,
    );
    // Cursor-pagination indexes. The keyset window orders and compares on
    // `date_trunc('milliseconds', created_at AT TIME ZONE 'UTC')` (cursors carry
    // milliseconds, Postgres stores microseconds), so the plain
    // `(business_id, created_at)` index cannot serve the ordering. These
    // expression indexes make the page boundaries index-backed: EXPLAIN shows an
    // Index Scan with the keyset condition as the index condition and no sort.
    console.log("[migrate] creating cursor-pagination indexes ...");
    const cursorTables = [
      "appointments",
      "calls",
      "customers",
      "knowledge_documents",
      "leads",
      "notifications",
      "properties",
      "usage_records",
      "users",
    ];
    for (const table of cursorTables) {
      await db.execute(sql.raw(
        `CREATE INDEX IF NOT EXISTS ${table}_business_cursor_idx ON ${table} ` +
        `(business_id, (date_trunc('milliseconds', created_at AT TIME ZONE 'UTC')) DESC, id DESC)`,
      ));
    }
    console.log("[migrate] done");
  } finally {
    try { await connection.query("SELECT pg_advisory_unlock(918273645)"); }
    finally { connection.release(); await pool.end(); }
  }
}

main().catch((err) => {
  console.error("[migrate] failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
