#!/usr/bin/env bash
# Local PostgreSQL 16 cluster for development and integration tests (never used in production).
# Usage: scripts/test-db.sh start|stop|status|reset
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PGBIN="${PGBIN:-$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1)}"
DATA="${SOFIA_TEST_PGDATA:-$ROOT/.data/pg}"
PORT="${SOFIA_TEST_PGPORT:-54329}"
RUN_AS=()
if [ "$(id -u)" = "0" ]; then RUN_AS=(runuser -u postgres --); fi

init() {
  mkdir -p "$DATA"
  if [ "$(id -u)" = "0" ]; then chown -R postgres:postgres "$(dirname "$DATA")"; fi
  if [ ! -f "$DATA/PG_VERSION" ]; then
    "${RUN_AS[@]}" "$PGBIN/initdb" -D "$DATA" -U postgres --auth=trust -E UTF8 --locale=C.UTF-8 >/dev/null
    {
      echo "listen_addresses = '127.0.0.1'"
      echo "port = $PORT"
      echo "unix_socket_directories = '/tmp'"
      echo "fsync = off"
      echo "synchronous_commit = off"
      echo "max_connections = 200"
    } >> "$DATA/postgresql.conf"
  fi
}

case "${1:-start}" in
  start)
    init
    if ! "$PGBIN/pg_isready" -h 127.0.0.1 -p "$PORT" -q; then
      "${RUN_AS[@]}" "$PGBIN/pg_ctl" -D "$DATA" -l "$DATA/server.log" -w start >/dev/null
    fi
    echo "PostgreSQL ready on 127.0.0.1:$PORT (user postgres)"
    ;;
  stop) "${RUN_AS[@]}" "$PGBIN/pg_ctl" -D "$DATA" -m fast stop || true ;;
  status) "$PGBIN/pg_isready" -h 127.0.0.1 -p "$PORT" ;;
  reset) "$0" stop; rm -rf "$DATA"; "$0" start ;;
  *) echo "usage: $0 start|stop|status|reset"; exit 1 ;;
esac
