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
  const db = drizzle(pool);
  try {
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
    console.log("[migrate] done");
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error("[migrate] failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
