#!/usr/bin/env bash
# Point the local agent and web at the HOSTED Supabase project instead of a database on this
# machine. This is the setup without Docker (`make setup DB=hosted`).
#
# What changes for you: runs you start locally are stored in the hosted database, where everyone
# with an account sees them, and local work needs a network connection.
#
# Needs: the Supabase CLI signed in (`supabase login`) with access to the project, and the
# project reference, either from an earlier `supabase link` or as PROJECT_REF=<ref>.
set -euo pipefail
cd "$(dirname "$0")/.."
# shellcheck source=scripts/lib.sh
source scripts/lib.sh

ref="${PROJECT_REF:-}"
if [[ -z "$ref" && -f supabase/.temp/project-ref ]]; then
  ref="$(tr -d '[:space:]' < supabase/.temp/project-ref)"
fi
if [[ -z "$ref" ]]; then
  cat >&2 <<'MSG'
No hosted Supabase project is known for this repository.
  - If the project exists:  make setup DB=hosted PROJECT_REF=<ref>
    (the reference is the subdomain of the project's URL, <ref>.supabase.co)
  - If it does not exist yet: run make dev and use Setup, Deploy to production (see
    docs/deploy.md), then run this again.
MSG
  exit 1
fi

publishable_key="$(find_supabase_keys "$ref" sb_publishable_ | head -1)"
secret_keys="$(find_supabase_keys "$ref" sb_secret_)"
if [[ "$(printf '%s\n' "$secret_keys" | grep -c .)" -gt 1 ]]; then
  echo "Project $ref has several secret keys. Set SUPABASE_SECRET_KEY in agent/.env by hand." >&2
  exit 1
fi
secret_key="$secret_keys"
if [[ -z "$publishable_key" || -z "$secret_key" ]]; then
  cat >&2 <<MSG
Could not read the API keys of project $ref.
Check that 'supabase login' has been run and that your account can open the project in the
Supabase dashboard (ask its owner to invite you to the organisation).
MSG
  exit 1
fi

# Both sides must hold the same secret. Reuse one that exists so a running setup keeps working.
secret=""
for file in agent/.env web/.env.local; do
  if [[ -f "$file" ]]; then
    found="$(grep -E '^AGENT_SHARED_SECRET=' "$file" | head -1 | cut -d= -f2- || true)"
    [[ -n "$found" ]] && secret="$found"
  fi
done
[[ -n "$secret" ]] || secret="$(openssl rand -hex 32)"

url="https://$ref.supabase.co"
[[ -f agent/.env ]] || printf '# Local development against the hosted database. Not committed.\nAGENT_MODEL=scripted\n' > agent/.env
[[ -f web/.env.local ]] || printf '# Local development against the hosted database. Not committed.\n' > web/.env.local

set_env_line agent/.env AGENT_SHARED_SECRET "$secret"
set_env_line agent/.env SUPABASE_URL "$url"
set_env_line agent/.env SUPABASE_SECRET_KEY "$secret_key"
set_env_line web/.env.local NEXT_PUBLIC_SUPABASE_URL "$url"
set_env_line web/.env.local NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY "$publishable_key"
set_env_line web/.env.local AGENT_URL "http://127.0.0.1:8000"
set_env_line web/.env.local AGENT_SHARED_SECRET "$secret"

# agent/.env now holds the hosted secret key, which bypasses row-level security.
chmod 600 agent/.env web/.env.local

cat <<MSG
agent/.env and web/.env.local now point at the hosted project $ref. agent/.env holds its secret
key, which bypasses row-level security: it is readable by your user only.
Sign in with your own account (the owner creates it with scripts/create-user.sh).
Runs you start locally are visible to everyone who can sign in.
MSG
