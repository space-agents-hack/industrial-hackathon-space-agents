#!/usr/bin/env bash
# Fail early, with the install command, instead of half-way through setup with a stack trace.
# Usage: require-tools.sh [local|hosted]. Docker is only needed for a local database.
set -euo pipefail

db="${1:-local}"

missing=0
need() { # command, how to install
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing: $1  ->  $2"
    missing=1
  fi
}

wsl=""
grep -qi microsoft /proc/version 2>/dev/null && wsl=yes

# A clone on the Windows drive (/mnt/c/...) is slow under WSL and gets CRLF line endings from Git
# for Windows, which bash cannot run.
if [[ -n "$wsl" && "$PWD" == /mnt/* ]]; then
  echo "This clone is on the Windows drive ($PWD). Clone it inside WSL instead, e.g. under ~/."
  missing=1
fi

if [[ "$(uname -s)" == "Darwin" ]]; then
  supabase_hint="brew install supabase/tap/supabase"
else
  supabase_hint="the .deb or .rpm from https://github.com/supabase/cli/releases/latest, or Homebrew"
fi
if [[ -n "$wsl" ]]; then
  docker_hint="Docker Desktop for Windows, with WSL integration on for this distribution"
else
  docker_hint="https://docs.docker.com/get-docker/"
fi

need uv "curl -LsSf https://astral.sh/uv/install.sh | sh"
need node "https://nodejs.org (version 24 or newer)"
need npm "comes with Node.js"
need supabase "$supabase_hint"
need python3 "comes with macOS and most Linux; https://www.python.org"
need openssl "comes with macOS and most Linux"
[[ "$db" == "hosted" ]] || need docker "$docker_hint (or use: make setup DB=hosted)"

if command -v uv >/dev/null 2>&1; then
  uv_version="$(uv --version | awk '{print $2}')"
  # The same floor as agent/pyproject.toml, which Vercel's own uv must also meet.
  if [[ "$(printf '%s\n0.10.0\n' "$uv_version" | sort -V | head -1)" != "0.10.0" ]]; then
    echo "uv $uv_version found; 0.10 or newer is required. Run: uv self update"
    missing=1
  fi
fi

if command -v node >/dev/null 2>&1; then
  major="$(node -p 'process.versions.node.split(".")[0]')"
  if (( major < 24 )); then
    echo "Node $major found; version 24 or newer is required."
    missing=1
  fi
fi

if [[ "$db" != "hosted" ]] && command -v docker >/dev/null 2>&1 && ! docker info >/dev/null 2>&1; then
  echo "Docker is installed but not running. Start it, or use the hosted database: make setup DB=hosted"
  missing=1
fi

exit "$missing"
