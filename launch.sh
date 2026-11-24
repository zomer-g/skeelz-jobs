#!/bin/sh
# xhostd runtime step: runs at boot as user `app` with the full env. Must answer
# GET / on $XHOST_HTTP_PORT within 120 seconds; exec so the server gets signals.
set -eu
cd "$(dirname "$0")/server"

# Schema migrations also run inside the server at startup (idempotent).
node dist/scripts/migrate.js

# Sandbox channel: never talk to real outside systems. Its data is static across
# deploys and restarts: only an EMPTY sandbox copies prod's (anonymized) data at
# boot; after that, a copy happens only when an admin presses "refresh".
if [ "${SANDBOX:-false}" = "true" ]; then
  export ENABLE_SALESFORCE=false ENABLE_SMOOVE=false SEND_EMAIL_ENABLED=false ALLOW_INDEXING=false GTM_ID= GA_ID=
  node dist/scripts/importFromProd.js --if-empty || echo "[sandbox] import failed, continuing"
fi
# No automatic copy of the existing site's jobs any more (owner, 17.11.2026): SEED_FROM_LIVE is ignored.
# scripts/importFromLive.ts stays a local-development seed only.

# First admin from ADMIN_EMAIL (signs in with "Continue with Google"; no password needed).
node dist/scripts/bootstrapAdmin.js || echo "[admin] bootstrap failed, continuing"

export NODE_ENV=production
export CLIENT_DIST="$(pwd)/../client/dist"
exec node --max-old-space-size="${WEB_HEAP_MB:-192}" dist/index.js
