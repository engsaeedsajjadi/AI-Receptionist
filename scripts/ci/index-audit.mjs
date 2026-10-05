#!/usr/bin/env node
/**
 * Index audit (CI gate).
 *
 * Rules enforced against the live schema:
 *   1. Every tenant-scoped table (a table with a `business_id` column) must have
 *      an index whose LEADING column is `business_id` — otherwise tenant
 *      filtering degrades to a sequential scan as data grows.
 *   2. Required hot-path indexes must exist: pgvector HNSW + trigram search on
 *      knowledge chunks, trigram location search on properties, the webhook
 *      idempotency ledger, the outbox lease queue and the quota reservation map.
 *   3. Reports the plan for representative tenant queries (EXPLAIN, without
 *      ANALYZE — safe on production data) so a regression in index usage is
 *      visible in CI logs.
 *
 * Usage: DATABASE_URL=... node scripts/ci/index-audit.mjs
 */
import { Pool } from "pg";

const databaseUrl = process.env.DATABASE_URL ?? process.env.TEST_DATABASE_URL;
if (!databaseUrl) {
  console.error("index-audit: DATABASE_URL (or TEST_DATABASE_URL) is required");
  process.exit(2);
}

const REQUIRED_INDEXES = [
  ["api_keys", "api_keys_hash_idx", "API key lookup is by secret hash on every authenticated request"],
  ["api_keys", "api_keys_prefix_idx", "API key prefix lookup during authentication"],
  ["knowledge_chunks", "knowledge_chunks_embedding_hnsw_idx", "pgvector cosine search over knowledge chunks"],
  ["knowledge_chunks", "knowledge_chunks_content_trgm_idx", "trigram keyword search over knowledge chunks"],
  ["properties", "properties_location_trgm_idx", "trigram location search over properties"],
  ["webhook_events", "webhook_events_tenant_idx", "webhook idempotency ledger is read per tenant"],
  ["outbox_events", "outbox_events_pending_idx", "outbox worker claims pending events by lease"],
  ["quota_reservations", "quota_reservations_pending", "quota reservation expiry sweep"],
  ["refresh_tokens", "refresh_tokens_jti_idx", "refresh-token rotation looks tokens up by jti"],
  ["calls", "calls_business_created_idx", "call list is tenant-scoped and created_at ordered"],
];

/** [label, sql, table whose sequential scan would be a regression] */
const PLAN_QUERIES = [
  [
    "calls by tenant",
    "SELECT id FROM calls WHERE business_id = (SELECT id FROM businesses LIMIT 1) ORDER BY created_at DESC LIMIT 20",
    "calls",
  ],
  [
    "outbox lease",
    "SELECT id FROM outbox_events WHERE status = 'pending' ORDER BY available_at LIMIT 10",
    "outbox_events",
  ],
  [
    "knowledge by tenant",
    "SELECT kc.id FROM knowledge_chunks kc WHERE kc.business_id = (SELECT id FROM businesses LIMIT 1) LIMIT 10",
    "knowledge_chunks",
  ],
];

const pool = new Pool({ connectionString: databaseUrl });
const problems = [];

try {
  // --- 1 · tenant-leading index coverage -----------------------------------
  const tenantGaps = await pool.query(`
    WITH tenant_tables AS (
      SELECT DISTINCT t.table_name
      FROM information_schema.tables t
      JOIN information_schema.columns c
        ON c.table_name = t.table_name AND c.table_schema = t.table_schema
      WHERE t.table_schema = 'public' AND t.table_type = 'BASE TABLE' AND c.column_name = 'business_id'
    )
    SELECT tt.table_name,
      (SELECT count(*) FROM pg_index i
        JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = i.indkey[0]
        WHERE i.indrelid::regclass::text = tt.table_name AND a.attname = 'business_id') AS leading
    FROM tenant_tables tt
    ORDER BY tt.table_name
  `);
  const tenantTables = tenantGaps.rows.length;
  for (const row of tenantGaps.rows) {
    if (Number(row.leading) === 0) {
      problems.push(`tenant table "${row.table_name}" has no index whose leading column is business_id`);
    }
  }

  // --- 2 · required hot-path indexes ---------------------------------------
  for (const [table, index, why] of REQUIRED_INDEXES) {
    const found = await pool.query(
      `SELECT 1 FROM pg_indexes WHERE schemaname='public' AND tablename=$1 AND indexname=$2 LIMIT 1`,
      [table, index],
    );
    if (found.rowCount === 0) problems.push(`missing index ${index} on ${table} (${why})`);
  }

  // --- 3 · plan report (EXPLAIN only: safe on live data) -------------------
  console.log("index audit: representative query plans");
  const client = await pool.connect();
  try {
    for (const [label, sql, table] of PLAN_QUERIES) {
      try {
        const natural = await pool.query(`EXPLAIN ${sql}`);
        const naturalText = natural.rows.map((r) => r["QUERY PLAN"]).join(" | ");

        // Structural assertion on a (potentially empty) CI database: with
        // sequential scans disabled the planner MUST be able to use an index on
        // the tenant-scoped table, otherwise the index is missing or unusable.
        await client.query("BEGIN");
        await client.query("SET LOCAL enable_seqscan = off");
        const forced = await client.query(`EXPLAIN ${sql}`);
        await client.query("ROLLBACK");
        const forcedText = forced.rows.map((r) => r["QUERY PLAN"]).join(" | ");
        const usable = !new RegExp(`Seq Scan on ${table}\\b`).test(forcedText);
        if (!usable) problems.push(`query "${label}" has no usable index on ${table}`);
        console.log(`  - ${label}: ${usable ? "index available" : "NO USABLE INDEX"} — ${naturalText.slice(0, 180)}`);
      } catch (error) {
        problems.push(`could not explain "${label}": ${error instanceof Error ? error.message : error}`);
      }
    }
  } finally {
    client.release();
  }

  const indexCount = await pool.query(`SELECT count(*)::int AS n FROM pg_indexes WHERE schemaname='public'`);
  console.log(`index audit: ${tenantTables} tenant tables checked, ${indexCount.rows[0].n} public indexes present`);

  if (problems.length) {
    console.error("index audit FAILED:");
    for (const problem of problems) console.error(` - ${problem}`);
    process.exitCode = 1;
  } else {
    console.log("index audit passed: every tenant table is tenant-indexed and all hot-path indexes exist.");
  }
} catch (error) {
  console.error(`index audit FAILED: ${error instanceof Error ? error.message : error}`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
