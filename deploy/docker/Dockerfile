# Sofia's Resto-Lounge — production image (one image, roles: api | worker | updater)
FROM node:22-bookworm-slim AS build
WORKDIR /src
RUN corepack enable && corepack prepare pnpm@10.28.0 --activate
COPY . .
RUN pnpm install --frozen-lockfile && node scripts/build-release.mjs

FROM node:22-bookworm-slim AS runtime
# PostgreSQL 16 client tools (pg_dump / pg_restore) — the client major version must match the server.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl gnupg tini \
 && install -d /usr/share/postgresql-common/pgdg \
 && curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc \
 && echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt bookworm-pgdg main" > /etc/apt/sources.list.d/pgdg.list \
 && apt-get update && apt-get install -y --no-install-recommends postgresql-client-16 \
 && apt-get purge -y gnupg && apt-get autoremove -y && rm -rf /var/lib/apt/lists/*
RUN useradd --system --uid 10001 --home-dir /opt/sofia sofia && mkdir -p /opt/sofia /opt/sofia-image && chown sofia /opt/sofia
COPY --from=build /src/release/sofia-*.tar.gz /opt/sofia-image/
COPY deploy/docker/entrypoint.sh /usr/local/bin/sofia-entrypoint
RUN chmod 0755 /usr/local/bin/sofia-entrypoint
USER sofia
ENV NODE_ENV=production \
    SOFIA_INSTALL_ROOT=/opt/sofia \
    SOFIA_DATA_DIR=/opt/sofia/data \
    SOFIA_BACKUP_DIR=/opt/sofia/backups \
    SOFIA_SERVICE_CONTROLLER=launcher \
    HOST=0.0.0.0 \
    PORT=8080
VOLUME ["/opt/sofia"]
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s CMD curl -fsS http://127.0.0.1:8080/health/live || exit 1
ENTRYPOINT ["tini", "--", "sofia-entrypoint"]
CMD ["api"]
