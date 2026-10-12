#!/bin/sh
set -e

if [ "${RUN_MIGRATIONS:-true}" = "true" ]; then
  echo "[entrypoint] running database migrations..."
  # Pre-compiled at image build time; the runtime image has no npm/tsx.
  node runtime/migrate.js
fi

echo "[entrypoint] starting: $@"
exec "$@"
