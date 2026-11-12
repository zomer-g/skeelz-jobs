#!/bin/sh
# xhostd build step: runs once per deploy, as root, with NO env and NO database.
# The account is close to its memory limit and builds have been OOM-killed, so:
# few parallel downloads, a capped heap, and dev dependencies removed afterwards.
set -eu
cd "$(dirname "$0")"

# 1) React client -> client/dist (served by the API process).
cd client
npm ci --include=dev --no-audit --no-fund --maxsockets=4
NODE_OPTIONS="--max-old-space-size=1024" npx vite build
rm -rf node_modules          # not needed at runtime; keeps the image small
cd ..

# 2) API -> server/dist
cd server
npm ci --include=dev --no-audit --no-fund --maxsockets=4
NODE_OPTIONS="--max-old-space-size=768" npx tsc
npm prune --omit=dev --no-audit --no-fund
