#!/usr/bin/env bash
# Write agent/.env and web/.env.local for the LOCAL Supabase stack. Never overwrites a file that
# exists: your own edits (a real model, an API key) survive running `make setup` again.
set -euo pipefail
cd "$(dirname "$0")/.."

eval "$(supabase status -o env 2>/dev/null | grep -E '^(API_URL|PUBLISHABLE_KEY|SECRET_KEY)=')"
: "${API_URL:?The local Supabase stack is not running. Run: make db-start}"

# Both sides must hold the same secret. If one file already exists, reuse its value.
secret=""
for file in agent/.env web/.env.local; do
  if [[ -f "$file" ]]; then
    found="$(grep -E '^AGENT_SHARED_SECRET=' "$file" | head -1 | cut -d= -f2- || true)"
    [[ -n "$found" ]] && secret="$found"
  fi
done
[[ -n "$secret" ]] || secret="$(openssl rand -hex 32)"

if [[ -f agent/.env ]]; then
  echo "agent/.env exists, left as it is."
else
  cat > agent/.env <<ENV
# Local development. Not committed.
# "scripted" needs no API key. For a real model set e.g. AGENT_MODEL=anthropic:claude-opus-5-5
# and the matching key below (see agent/.env.example).
AGENT_MODEL=scripted
AGENT_SHARED_SECRET=$secret
SUPABASE_URL=$API_URL
SUPABASE_SECRET_KEY=$SECRET_KEY
# ANTHROPIC_API_KEY=
# OPENAI_API_KEY=
# OPENROUTER_API_KEY=
# DEEPSEEK_API_KEY=
ENV
  echo "Wrote agent/.env"
fi

if [[ -f web/.env.local ]]; then
  echo "web/.env.local exists, left as it is."
else
  cat > web/.env.local <<ENV
# Local development. Not committed.
NEXT_PUBLIC_SUPABASE_URL=$API_URL
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=$PUBLISHABLE_KEY
AGENT_URL=http://127.0.0.1:8000
AGENT_SHARED_SECRET=$secret
ENV
  echo "Wrote web/.env.local"
fi
