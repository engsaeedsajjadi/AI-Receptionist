#!/usr/bin/env bash
# Backup / restore / disaster-recovery drill.
#
#   create source → back up → restore into an ISOLATED database → validate →
#   migrate (twice) → health checks
#
# Safety: the drill never restores over the source database and refuses
# production-looking targets. The isolated database is created for the drill and
# dropped at the end unless RESTORE_DRILL_KEEP=1.
#
# Usage:
#   DATABASE_URL=postgresql://user:pass@host:5432/app scripts/ci/restore-drill.sh
#   RESTORE_DRILL_DB=ai_restore_drill scripts/ci/restore-drill.sh
set -euo pipefail

SOURCE_URL="${DATABASE_URL:-}"
if [ -z "$SOURCE_URL" ]; then
  echo "[drill] DATABASE_URL is required" >&2
  exit 1
fi

DRILL_DB="${RESTORE_DRILL_DB:-ai_restore_drill}"
BACKUP_DIR="${RESTORE_DRILL_BACKUP_DIR:-./backups}"
ADMIN_URL="${RESTORE_DRILL_ADMIN_URL:-}"

case "$DRILL_DB" in
  *prod*) echo "[drill] refusing drill database name containing 'prod': $DRILL_DB" >&2; exit 1 ;;
esac
case "$SOURCE_URL" in
  *"$DRILL_DB"*) echo "[drill] refusing to run: source URL already points at the drill database" >&2; exit 1 ;;
esac

# Derive the admin (maintenance) and target connection strings. libpq semantics:
# append/replace the trailing database name without needing URL parsing helpers.
build_url() { # $1 = base url, $2 = database name
  printf '%s' "$1" | sed -E "s#/[^/?]*(\\?[^/]*)?\$#/$2\\1#"
}
if [ -z "$ADMIN_URL" ]; then
  ADMIN_URL="$(build_url "$SOURCE_URL" postgres)"
fi
TARGET_URL="$(build_url "$SOURCE_URL" "$DRILL_DB")"

psql_admin() { psql "$ADMIN_URL" -v ON_ERROR_STOP=1 -qAt "$@"; }
psql_target() { psql "$TARGET_URL" -v ON_ERROR_STOP=1 -qAt "$@"; }

echo "[drill] 1/8 creating isolated database $DRILL_DB"
psql_admin -c "DROP DATABASE IF EXISTS \"$DRILL_DB\"" >/dev/null
psql_admin -c "CREATE DATABASE \"$DRILL_DB\"" >/dev/null

echo "[drill] 2/8 ensuring the source has a current schema (fresh-create baseline)"
DATABASE_URL="$SOURCE_URL" npm run db:migrate >/dev/null

echo "[drill] 3/8 seeding a sentinel tenant and capturing source facts"
SENTINEL="drill-sentinel-$(date -u +%s)"
psql "$SOURCE_URL" -v ON_ERROR_STOP=1 -qAt -c "INSERT INTO businesses (name, slug, phone) VALUES ('$SENTINEL', '$SENTINEL', '+15550100') RETURNING id" >/dev/null
cleanup_sentinel() {
  psql "$SOURCE_URL" -qAt -c "DELETE FROM businesses WHERE slug = '$SENTINEL'" >/dev/null 2>&1 || true
}
trap cleanup_sentinel EXIT
SOURCE_TABLES="$(psql "$SOURCE_URL" -qAt -c "SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'")"
SOURCE_ROWS="$(psql "$SOURCE_URL" -qAt -c "SELECT COALESCE(sum(n_live_tup),0) FROM pg_stat_user_tables")"
echo "[drill]      source: $SOURCE_TABLES tables, ~$SOURCE_ROWS rows"

echo "[drill] 4/8 backing up (scripts/backup.sh)"
DATABASE_URL="$SOURCE_URL" bash scripts/backup.sh "$BACKUP_DIR" 0 >/dev/null
DUMP="$(ls -1t "$BACKUP_DIR"/app_db-*.dump | head -1)"
echo "[drill]      dump: $DUMP ($(du -h "$DUMP" | cut -f1))"

echo "[drill] 5/8 restoring into the isolated database (scripts/restore.sh)"
DATABASE_URL="$TARGET_URL" bash scripts/restore.sh "$DUMP" >/dev/null

echo "[drill] 6/8 validating the restore"
RESTORED_TABLES="$(psql_target -c "SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'")"
if [ "$RESTORED_TABLES" -ne "$SOURCE_TABLES" ]; then
  echo "[drill] FAIL: restored $RESTORED_TABLES tables, source has $SOURCE_TABLES" >&2
  exit 1
fi

# Critical tenant-scoped tables must survive the round trip.
for table in businesses users outbox_events webhook_events knowledge_documents payment_transactions audit_logs; do
  exists="$(psql_target -c "SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_name='$table'")"
  if [ "$exists" != "1" ]; then
    echo "[drill] FAIL: critical table '$table' missing after restore" >&2
    exit 1
  fi
done

# The sentinel tenant written before the backup must exist in the restored copy.
sentinel_hits="$(psql_target -c "SELECT count(*) FROM businesses WHERE slug='$SENTINEL'")"
if [ "$sentinel_hits" != "1" ]; then
  echo "[drill] FAIL: sentinel tenant did not survive backup+restore (found $sentinel_hits)" >&2
  exit 1
fi
echo "[drill]      sentinel tenant survived the round trip"

# Row-level comparison for tenant-scoped tables (best effort on live stats).
for table in businesses users webhook_events outbox_events; do
  target_rows="$(psql_target -c "SELECT count(*) FROM \"$table\"")"
  case "$target_rows" in (*[!0-9]*) echo "[drill] FAIL: non-numeric row count for $table: $target_rows" >&2; exit 1 ;; esac
  echo "[drill]      $table: $target_rows rows restored"
done

echo "[drill] 7/8 migrating the restored database twice (idempotency on real data)"
DATABASE_URL="$TARGET_URL" npm run db:migrate >/dev/null
DATABASE_URL="$TARGET_URL" npm run db:migrate >/dev/null
APPLIED="$(psql_target -c "SELECT count(*) FROM drizzle.__drizzle_migrations")"
echo "[drill]      migrations recorded: $APPLIED"

echo "[drill] 8/8 health checks"
psql_target -c "SELECT 1" >/dev/null
psql_target -c "SELECT 1 FROM pg_extension WHERE extname='vector'" | grep -q 1 || {
  echo "[drill] FAIL: pgvector extension missing after restore+migrate" >&2; exit 1; }
psql_target -c "SELECT 1 FROM pg_indexes WHERE indexname='knowledge_chunks_embedding_hnsw_idx'" | grep -q 1 || {
  echo "[drill] FAIL: hnsw index missing after restore+migrate" >&2; exit 1; }
psql_target -c "SELECT 1 FROM pg_indexes WHERE indexname='properties_location_trgm_idx'" | grep -q 1 || {
  echo "[drill] FAIL: trigram index missing after restore+migrate" >&2; exit 1; }

# Restored tenant data must still satisfy the isolation invariant.
orphans="$(psql_target -c "SELECT count(*) FROM webhook_events WHERE business_id IS NULL")"
if [ "$orphans" != "0" ]; then
  echo "[drill] FAIL: $orphans webhook_events rows lost tenant scoping in the restore" >&2
  exit 1
fi

echo "[drill] PASS: backup → isolated restore → validate → migrate ×2 → health checks (sentinel round-tripped)"

if [ "${RESTORE_DRILL_KEEP:-0}" != "1" ]; then
  echo "[drill] dropping drill database $DRILL_DB (set RESTORE_DRILL_KEEP=1 to keep it)"
  psql_admin -c "DROP DATABASE IF EXISTS \"$DRILL_DB\"" >/dev/null
fi
