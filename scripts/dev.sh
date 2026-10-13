#!/usr/bin/env bash
# The one command (`make dev`). It starts whatever this clone is ready for:
#   nothing set up yet  -> the web only, which shows the setup steps
#   set up              -> the database (if local), the agent and the web
# Ctrl-C stops everything it started.
set -euo pipefail
cd "$(dirname "$0")/.."

[[ -d web/node_modules ]] || (cd web && npm ci)

# `kill 0` signals every process in this script's group, so no server is left holding its port.
trap 'trap - INT TERM EXIT; kill 0' INT TERM EXIT

if [[ ! -f agent/.env || ! -f web/.env.local ]]; then
  echo
  echo "Not set up yet. Open http://localhost:3000 for the steps."
  echo
  (cd web && npm run dev) &
  wait
  exit 0
fi

if grep -q '^SUPABASE_URL=http://127.0.0.1' agent/.env; then
  if ! docker info >/dev/null 2>&1; then
    echo "This clone uses a local database and Docker is not running. Start Docker and run 'make dev' again." >&2
    exit 1
  fi
  make --no-print-directory db-start
fi

echo
echo "Open http://localhost:3000"
echo
(cd agent && uv run uvicorn main:app --reload --port 8000) &
(cd web && npm run dev) &
wait
