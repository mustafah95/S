#!/bin/sh
# Creates the least-privilege runtime role. The database owner (POSTGRES_USER) runs migrations and backups;
# the application connects as sofia_app (DML only, append-only audit log — grants applied by the migrator).
set -eu
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  -v app_password="$SOFIA_DB_APP_PASSWORD" -v db="$POSTGRES_DB" <<'SQL'
CREATE ROLE sofia_app LOGIN PASSWORD :'app_password';
GRANT CONNECT ON DATABASE :"db" TO sofia_app;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
SQL
