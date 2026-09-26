#!/bin/sh
# PostgreSQL restore from a backup.sh dump.
# Usage: DATABASE_URL=... ./scripts/restore.sh <dump-file>
# WARNING: overwrites data in the target database. Refuses production-looking
# targets unless RESTORE_ALLOW_PROD=1 is set.
set -e

FILE="${1:-}"
if [ -z "$FILE" ] || [ ! -f "$FILE" ]; then
  echo "Usage: DATABASE_URL=... ./scripts/restore.sh <dump-file>" >&2
  exit 1
fi
if [ -z "$DATABASE_URL" ]; then
  echo "DATABASE_URL is required" >&2
  exit 1
fi

case "$DATABASE_URL" in
  *prod*|*amazonaws.com*|*neon.tech*|*supabase*)
    if [ "${RESTORE_ALLOW_PROD:-0}" != "1" ]; then
      echo "Refusing to restore into a production-looking database (set RESTORE_ALLOW_PROD=1 to override)" >&2
      exit 1
    fi
    ;;
esac

echo "[restore] restoring $FILE ..."
pg_restore --clean --if-exists --no-owner --no-privileges -d "$DATABASE_URL" "$FILE"
echo "[restore] done. Run 'npm run db:migrate' to ensure the schema is current."
