#!/usr/bin/env bash
# Create a user who can sign in. Sign-ups are off, so this is how people get access.
#
#   scripts/create-user.sh                    local stack, demo user (see the defaults below)
#   scripts/create-user.sh ana@example.com    local stack, that email, same local password
#
# Hosted project: set SUPABASE_URL and SUPABASE_SECRET_KEY in your shell first. The script then
# asks for a password and refuses the local default.
set -euo pipefail
cd "$(dirname "$0")/.."

# Local only. Printed below on purpose: it opens nothing but a database on this machine.
LOCAL_EMAIL="demo@example.test"
LOCAL_PASSWORD="local-demo-only"

email="${1:-$LOCAL_EMAIL}"

if [[ -n "${SUPABASE_URL:-}" && -n "${SUPABASE_SECRET_KEY:-}" ]]; then
  url="$SUPABASE_URL"
  key="$SUPABASE_SECRET_KEY"
else
  eval "$(supabase status -o env 2>/dev/null | grep -E '^(API_URL|SECRET_KEY)=')"
  url="${API_URL:?The local Supabase stack is not running. Run: make db-start}"
  key="$SECRET_KEY"
fi

if [[ "$url" == *127.0.0.1* || "$url" == *localhost* ]]; then
  password="$LOCAL_PASSWORD"
  local_stack=1
else
  local_stack=0
  read -r -s -p "Password for $email on $url: " password
  echo
  if [[ ${#password} -lt 12 || "$password" == "$LOCAL_PASSWORD" ]]; then
    echo "Use a password of at least 12 characters that is not the local default." >&2
    exit 1
  fi
fi

body="$(python3 -c 'import json,sys; print(json.dumps({"email": sys.argv[1], "password": sys.argv[2], "email_confirm": True}))' "$email" "$password")"
out="$(mktemp)"
response="$(curl -sS -o "$out" -w '%{http_code}' -X POST "$url/auth/v1/admin/users" \
  -H "apikey: $key" -H "Authorization: Bearer $key" -H "content-type: application/json" \
  -d "$body")"
detail="$(cat "$out")"
rm -f "$out"

case "$response" in
  200|201) echo "Created $email." ;;
  422) if [[ "$detail" == *exist* || "$detail" == *registered* ]]; then
         echo "$email already exists."
       else
         echo "Could not create $email: $detail" >&2; exit 1
       fi ;;
  *) echo "Could not create $email (HTTP $response): $detail" >&2; exit 1 ;;
esac

if (( local_stack )); then
  echo "Sign in locally with $email / $LOCAL_PASSWORD"
fi
