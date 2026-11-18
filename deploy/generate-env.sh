#!/bin/sh
# Prints a .env with freshly generated secrets:  ./generate-env.sh > .env && chmod 600 .env
set -eu
rand() { head -c "$1" /dev/urandom | od -An -tx1 | tr -d ' \n'; }
cat <<ENV
# --- Sofia's Resto-Lounge (generated $(date -u +%Y-%m-%dT%H:%M:%SZ)) — keep this file secret ---
NODE_ENV=production
SOFIA_SITE_ADDRESS=:80
SOFIA_PUBLIC_URL=
SOFIA_ACME_EMAIL=admin@example.com
SOFIA_DB_OWNER_PASSWORD=$(rand 24)
SOFIA_DB_APP_PASSWORD=$(rand 24)
SOFIA_JWT_SECRET=$(rand 48)
SOFIA_ENCRYPTION_KEY=$(head -c 32 /dev/urandom | base64)
SOFIA_SETUP_TOKEN=$(rand 12)
SOFIA_UPDATE_FEED_URL=
SOFIA_UPDATE_CHANNEL=stable
ENV
