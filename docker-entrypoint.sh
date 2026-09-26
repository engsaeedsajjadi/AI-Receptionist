#!/bin/sh
set -e

if [ "${RUN_MIGRATIONS:-true}" = "true" ]; then
  echo "[entrypoint] running database migrations..."
  npm run db:migrate
fi

echo "[entrypoint] starting: $@"
exec "$@"
