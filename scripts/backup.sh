#!/bin/sh
# PostgreSQL backup: timestamped custom-format dump + retention pruning.
# Usage: DATABASE_URL=... ./scripts/backup.sh [backup-dir] [retention-days]
# Can also run against the compose stack:
#   docker compose exec -T postgres pg_dump -U postgres -Fc app_db > backup.dump
set -e

BACKUP_DIR="${1:-./backups}"
RETENTION_DAYS="${2:-14}"

if [ -z "$DATABASE_URL" ]; then
  echo "DATABASE_URL is required" >&2
  exit 1
fi

mkdir -p "$BACKUP_DIR"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
FILE="$BACKUP_DIR/app_db-$STAMP.dump"

echo "[backup] writing $FILE ..."
pg_dump "$DATABASE_URL" -Fc -f "$FILE"
echo "[backup] done: $FILE ($(du -h "$FILE" | cut -f1))"

echo "[backup] pruning dumps older than $RETENTION_DAYS days ..."
find "$BACKUP_DIR" -name 'app_db-*.dump' -mtime "+$RETENTION_DAYS" -delete || true
echo "[backup] retention cleanup done"
