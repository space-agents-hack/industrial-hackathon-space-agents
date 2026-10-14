#!/usr/bin/env bash
# Create a user who can sign in, and give them a role in the first organisation. Sign-ups are
# off, so this (or Admin, People in the app) is how people get access.
#
#   scripts/create-user.sh                          local stack, demo user (defaults below)
#   scripts/create-user.sh ana@example.com          local stack, that email, local password
#   scripts/create-user.sh ana@x.com --role member  admin (default), member or viewer
#   scripts/create-user.sh ana@x.com --platform-admin
#                                                   also manages every organisation
#
# Hosted project: set SUPABASE_URL and SUPABASE_SECRET_KEY in your shell first. The script then
# asks for a password and refuses the local default. Running it for an existing user sets the
# new password and role.
set -euo pipefail
cd "$(dirname "$0")/.."

email=""
role="admin"
platform_admin=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    --role) role="${2:-}"; shift 2 ;;
    --platform-admin) platform_admin=true; shift ;;
    -*) echo "Unknown option $1" >&2; exit 2 ;;
    *) email="$1"; shift ;;
  esac
done
case "$role" in
  admin|member|viewer) ;;
  *) echo "--role must be admin, member or viewer." >&2; exit 2 ;;
esac

# Local only. Printed below on purpose: it opens nothing but a database on this machine.
# The login page shows the same two values (web/lib/config.ts); change both together.
LOCAL_EMAIL="demo@example.test"
LOCAL_PASSWORD="local-demo-only"

email="${email:-$LOCAL_EMAIL}"

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
  # From a terminal this prompts; from the Setup page's form the password arrives on stdin.
  read -r -s -p "Password for $email on $url: " password
  [[ -t 0 ]] && echo
  if [[ ${#password} -lt 12 || "$password" == "$LOCAL_PASSWORD" ]]; then
    echo "Use a password of at least 12 characters that is not the local default." >&2
    exit 1
  fi
fi

# Built from stdin, not from arguments: a password in a command line is visible to `ps`.
body="$(printf '%s\n%s' "$email" "$password" | python3 -c '
import json, sys
email, password = sys.stdin.read().split("\n", 1)
print(json.dumps({"email": email, "password": password, "email_confirm": True}))
')"
out="$(mktemp)"
response="$(curl -sS -o "$out" -w '%{http_code}' -X POST "$url/auth/v1/admin/users" \
  -H @<(printf 'apikey: %s\nAuthorization: Bearer %s\n' "$key" "$key") -H "content-type: application/json" \
  --data-binary @<(printf '%s' "$body"))"
detail="$(cat "$out")"
rm -f "$out"

# An existing user gets the password given here: running this again is how a password is changed
# from a terminal (Admin, People does it from the app).
find_user_id() { # email -> id, or nothing
  curl -sS "$url/auth/v1/admin/users?per_page=1000" \
    -H @<(printf 'apikey: %s\nAuthorization: Bearer %s\n' "$key" "$key") \
    | python3 -c '
import json, sys
email = sys.argv[1]
users = json.load(sys.stdin).get("users", [])
print(next((u["id"] for u in users if (u.get("email") or "").lower() == email), ""))
' "$1"
}

update_password() { # email, password -> 0 if updated
  local id
  id="$(find_user_id "$1")"
  [[ -n "$id" ]] || return 1
  printf '%s' "$2" | python3 -c 'import json,sys; print(json.dumps({"password": sys.stdin.read()}))' \
    | curl -fsS -o /dev/null -X PUT "$url/auth/v1/admin/users/$id" \
      -H @<(printf 'apikey: %s\nAuthorization: Bearer %s\n' "$key" "$key") \
      -H "content-type: application/json" --data-binary @-
}

case "$response" in
  200|201) echo "Created $email." ;;
  422) if [[ "$detail" == *exist* || "$detail" == *registered* ]]; then
         if update_password "$(printf '%s' "$email" | tr '[:upper:]' '[:lower:]')" "$password"; then
           echo "$email already exists; its password was updated."
         else
           echo "$email already exists, but its password could not be updated." >&2
           exit 1
         fi
       else
         echo "Could not create $email: $detail" >&2; exit 1
       fi ;;
  *) echo "Could not create $email (HTTP $response): $detail" >&2; exit 1 ;;
esac

# A place in the first organisation (created if there is none), with the role asked for.
user_id="$(find_user_id "$(printf '%s' "$email" | tr '[:upper:]' '[:lower:]')")"
if [[ -z "$user_id" ]]; then
  echo "Could not find $email after creating it." >&2
  exit 1
fi
placed="$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$url/rest/v1/rpc/bootstrap_member" \
  -H @<(printf 'apikey: %s\nAuthorization: Bearer %s\n' "$key" "$key") \
  -H "content-type: application/json" \
  -d "{\"member\": \"$user_id\", \"member_role\": \"$role\", \"make_platform_admin\": $platform_admin}")"
if [[ "$placed" != "200" ]]; then
  echo "$email exists but could not be given a role (HTTP $placed). Are the migrations applied?" >&2
  exit 1
fi
if [[ "$platform_admin" == true ]]; then
  echo "  $role of the first organisation, and platform admin."
else
  echo "  $role of the first organisation."
fi

if (( local_stack )); then
  echo "Sign in locally with $email / $LOCAL_PASSWORD"
fi
