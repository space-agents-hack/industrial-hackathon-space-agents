#!/usr/bin/env bash
# Run the agent and the web together. Ctrl-C stops both.
set -euo pipefail
cd "$(dirname "$0")/.."

[[ -f agent/.env && -f web/.env.local ]] || {
  echo "Env files are missing. Run: make setup" >&2
  exit 1
}

# `kill 0` signals every process in this script's group, so neither server is left holding its
# port after Ctrl-C.
trap 'trap - INT TERM EXIT; kill 0' INT TERM EXIT

(cd agent && uv run uvicorn main:app --reload --port 8000) &
(cd web && npm run dev) &
wait
