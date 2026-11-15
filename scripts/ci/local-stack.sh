#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Local/CI test stack bootstrap.
#
# Provisions, inside the workspace, everything the automated suites need:
#   * PostgreSQL 16 with the pgvector extension (from the `pgserver` wheel)
#     plus pg_trgm built out-of-tree against those headers,
#   * Redis 7.2 (built from source),
#   * `.cache/ci-env.sh`, the environment file every test/migration command
#     sources.
#
# It is intentionally self-contained: no apt packages, no system services, no
# writes outside the workspace, and every step is idempotent so it can be
# re-run after a sandbox reset.
#
# Usage:  bash scripts/ci/local-stack.sh [--force]
# ---------------------------------------------------------------------------
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CACHE="${CACHE_DIR:-$HOME/.cache}"
PG_DIR="$CACHE/pgserver/pgserver/pginstall"
PGDATA="$CACHE/pgdata"
PG_PORT="${PG_PORT:-5432}"
REDIS_DIR="$CACHE/redis-7.2.5"
REDIS_PORT="${REDIS_PORT:-6379}"
DB_NAME="${DB_NAME:-ai_receptionist_test}"
DB_USER="${DB_USER:-ai_test}"
DB_PASS="${DB_PASS:-test-only-ci}"
FORCE="${1:-}"

log() { printf '[stack] %s\n' "$*" >&2; }

mkdir -p "$CACHE"

# ---------------------------------------------------------------------------
# 1. PostgreSQL (pgserver wheel: postgres 16 + pgvector)
# ---------------------------------------------------------------------------
if [[ ! -x "$PG_DIR/bin/postgres" ]]; then
  log "downloading pgserver wheel"
  mkdir -p "$CACHE/wheels"
  python3 - <<'PY'
import json, os, urllib.request, zipfile
cache = os.path.expanduser(os.environ.get("CACHE_DIR", "~/.cache"))
with urllib.request.urlopen("https://pypi.org/pypi/pgserver/json", timeout=60) as res:
    meta = json.load(res)
files = [f for f in meta["urls"] if f["filename"].endswith("manylinux_2_17_x86_64.manylinux2014_x86_64.whl")]
if not files:
    raise SystemExit("no manylinux wheel found for pgserver")
url = files[0]["url"]
target = os.path.join(cache, "wheels", os.path.basename(url))
if not os.path.exists(target):
    urllib.request.urlretrieve(url, target)
dest = os.path.join(cache, "pgserver")
os.makedirs(dest, exist_ok=True)
with zipfile.ZipFile(target) as archive:
    archive.extractall(dest)
print(target)
PY
  chmod +x "$PG_DIR"/bin/* "$PG_DIR"/lib/postgresql/* 2>/dev/null || true
fi
export PATH="$PG_DIR/bin:$PATH"

# pg_trgm is not shipped in the wheel; build the contrib module out-of-tree
# against the wheel's headers. (bison is not needed for contrib modules.)
if [[ ! -f "$PG_DIR/share/postgresql/extension/pg_trgm.control" ]]; then
  log "building pg_trgm"
  SRC="$CACHE/postgres-src"
  if [[ ! -d "$SRC/contrib/pg_trgm" ]]; then
    rm -rf "$SRC"
    mkdir -p "$SRC"
    curl -fsSL "https://ftp.postgresql.org/pub/source/v16.6/postgresql-16.6.tar.bz2" -o "$CACHE/postgresql-16.6.tar.bz2" 2>/dev/null \
      || curl -fsSL "https://github.com/postgres/postgres/archive/refs/tags/REL_16_6.tar.gz" -o "$CACHE/REL_16_6.tar.gz"
    if [[ -f "$CACHE/REL_16_6.tar.gz" ]]; then
      tar -xzf "$CACHE/REL_16_6.tar.gz" -C "$SRC" --strip-components=1
    else
      tar -xjf "$CACHE/postgresql-16.6.tar.bz2" -C "$SRC" --strip-components=1
    fi
  fi
  # The full source tree needs bison for a top-level configure; configure only
  # the contrib subtree against the shipped headers instead.
  ( cd "$SRC/contrib/pg_trgm" && make USE_PGXS=1 PG_CONFIG="$PG_DIR/bin/pg_config" && make USE_PGXS=1 PG_CONFIG="$PG_DIR/bin/pg_config" install )
fi

# ---------------------------------------------------------------------------
# 2. Start PostgreSQL (idempotent)
# ---------------------------------------------------------------------------
if [[ ! -f "$PGDATA/PG_VERSION" ]]; then
  log "initdb"
  rm -rf "$PGDATA"
  "$PG_DIR/bin/initdb" -D "$PGDATA" -U "$DB_USER" --auth=trust --encoding=UTF8 --locale=C >/dev/null
fi

if ! "$PG_DIR/bin/pg_ctl" -D "$PGDATA" status >/dev/null 2>&1; then
  log "starting postgres on 127.0.0.1:$PG_PORT"
  "$PG_DIR/bin/pg_ctl" -D "$PGDATA" -o "-p $PG_PORT -c unix_socket_directories=/tmp" -l "$CACHE/pg.log" start >/dev/null
  for _ in $(seq 1 30); do
    "$PG_DIR/bin/pg_isready" -h 127.0.0.1 -p "$PG_PORT" >/dev/null 2>&1 && break
    sleep 1
  done
fi

psql_cmd() { "$PG_DIR/bin/psql" -h 127.0.0.1 -p "$PG_PORT" -U "$DB_USER" -tAc "$1" postgres; }
[[ "$(psql_cmd "SELECT 1 FROM pg_roles WHERE rolname='$DB_USER'")" == "1" ]] || psql_cmd "CREATE ROLE $DB_USER LOGIN PASSWORD '$DB_PASS' SUPERUSER"
for db in "$DB_NAME" ai_receptionist_restore ai_receptionist_fresh; do
  [[ "$(psql_cmd "SELECT 1 FROM pg_database WHERE datname='$db'")" == "1" ]] || psql_cmd "CREATE DATABASE $db OWNER $DB_USER"
done
for db in "$DB_NAME" ai_receptionist_restore ai_receptionist_fresh; do
  "$PG_DIR/bin/psql" -h 127.0.0.1 -p "$PG_PORT" -U "$DB_USER" -d "$db" -q -c "CREATE EXTENSION IF NOT EXISTS vector; CREATE EXTENSION IF NOT EXISTS pg_trgm;" >/dev/null
done

# ---------------------------------------------------------------------------
# 3. Redis (from source)
# ---------------------------------------------------------------------------
if [[ ! -x "$REDIS_DIR/src/redis-server" ]]; then
  log "building redis"
  mkdir -p "$CACHE"
  if [[ ! -d "$REDIS_DIR" ]]; then
    curl -fsSL "https://github.com/redis/redis/archive/refs/tags/7.2.5.tar.gz" -o "$CACHE/redis.tar.gz"
    tar -xzf "$CACHE/redis.tar.gz" -C "$CACHE"
  fi
  ( cd "$REDIS_DIR" && make -j"$(nproc)" MALLOC=libc >/dev/null )
fi

if ! "$REDIS_DIR/src/redis-cli" -p "$REDIS_PORT" ping >/dev/null 2>&1; then
  log "starting redis on 127.0.0.1:$REDIS_PORT"
  "$REDIS_DIR/src/redis-server" --port "$REDIS_PORT" --save '' --daemonize yes --bind 127.0.0.1 >/dev/null
  for _ in $(seq 1 20); do
    "$REDIS_DIR/src/redis-cli" -p "$REDIS_PORT" ping >/dev/null 2>&1 && break
    sleep 1
  done
fi

# ---------------------------------------------------------------------------
# 4. Test environment file
# ---------------------------------------------------------------------------
ENV_FILE="$CACHE/ci-env.sh"
log "writing $ENV_FILE"
cat > "$ENV_FILE" <<ENV
# Sourced by every test/migration command in this workspace.
# Keep this file OUT of the repository: it is environment-specific.
export PATH="$PG_DIR/bin:\$PATH"
export PGHOST=127.0.0.1
export PGPORT=$PG_PORT
export PGUSER=$DB_USER
export PGPASSWORD=$DB_PASS
export DATABASE_URL="postgresql://$DB_USER:$DB_PASS@127.0.0.1:$PG_PORT/$DB_NAME"
export TEST_DATABASE_URL="\$DATABASE_URL"
export REDIS_URL="redis://127.0.0.1:$REDIS_PORT/0"
export TEST_REDIS_URL="\$REDIS_URL"
export APP_URL="http://localhost:3000"
export NODE_ENV=test
export REQUIRE_INTEGRATION_TESTS=1
export METRICS_TOKEN="test-metrics-token"
# Secrets intentionally unset: suites that require them must fail loudly
# instead of silently passing with a development default.
unset VOICE_WEBHOOK_SECRET VOICE_WEBHOOK_PREVIOUS_SECRET LOG_LEVEL IDENTITY_ENCRYPTION_KEY VOICE_MEDIA_TOKEN N8N_WEBHOOK_SECRET
ENV

log "ready: postgres $PG_PORT, redis $REDIS_PORT, env $ENV_FILE"
[[ "$FORCE" == "--force" ]] && log "force flag ignored (all steps idempotent)"
