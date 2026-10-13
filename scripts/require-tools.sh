#!/usr/bin/env bash
# Fail early, with the install command, instead of half-way through setup with a stack trace.
set -euo pipefail

missing=0
need() { # command, how to install
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing: $1  ->  $2"
    missing=1
  fi
}

need uv "curl -LsSf https://astral.sh/uv/install.sh | sh"
need node "https://nodejs.org (version 24 or newer)"
need npm "comes with Node.js"
need supabase "brew install supabase/tap/supabase"
need docker "https://docs.docker.com/get-docker/"

if command -v node >/dev/null 2>&1; then
  major="$(node -p 'process.versions.node.split(".")[0]')"
  if (( major < 24 )); then
    echo "Node $major found; version 24 or newer is required."
    missing=1
  fi
fi

if command -v docker >/dev/null 2>&1 && ! docker info >/dev/null 2>&1; then
  echo "Docker is installed but not running. Start Docker Desktop and try again."
  missing=1
fi

exit "$missing"
