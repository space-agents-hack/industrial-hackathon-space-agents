#!/usr/bin/env bash
# Connect a repository made from this template to its own Vercel and Supabase projects, once.
# After it finishes, pushing to main deploys.
#
# Three ways to run it, same steps:
#   the Setup page under `make dev` ("Deploy to production"): three tokens and your email in one
#                                      form, everything else automatic. Needs `gh` signed in.
#   the Bootstrap workflow (.github/workflows/bootstrap.yml): the same from GitHub alone, for a
#                                      machine without the CLIs.
#   scripts/bootstrap.sh               asks each question in the terminal.
# The first two run this script with --from-json.
#
# What it does:
#   1. creates the Supabase project, unless you name an existing one, and waits until it is up
#   2. creates two Vercel projects (<name>-web, <name>-agent) and links web/ and agent/ to them
#   3. applies the migrations, reads the project's API keys, turns new sign-ups off
#   4. sets the production environment variables of both Vercel projects
#   5. sets the secrets and variables the GitHub workflows read
#   6. creates the users you name
#
# The Vercel and Supabase tokens are used through the environment, so neither CLI has to be signed
# in. Vercel does not let a CLI sign-in create tokens and Supabase has no API for it, so those two
# are pasted once (ADR-0005). The Supabase token is used here only: GitHub keeps the database
# password and the connection address instead, which reach this one project and nothing else.
#
# Secrets arrive on standard input and leave on standard input to the CLIs, or as curl headers and
# bodies read from a file descriptor; none is printed, passed as a command argument or written to
# disk. The only files it writes are the .vercel/ link folders and supabase/.temp/, all ignored.
# It stops at the first error and is safe to run again.
set -euo pipefail
cd "$(dirname "$0")/.."
# shellcheck source=scripts/lib.sh
source scripts/lib.sh

answers=""
if [[ "${1:-}" == "--from-json" ]]; then
  answers="$(cat)"
fi

say() { printf '\n== %s\n' "$*"; }
from_json() { # key -> value, or nothing
  printf '%s' "$answers" | python3 -c '
import json, sys
value = json.load(sys.stdin).get(sys.argv[1])
print("" if value is None else value, end="")
' "$1"
}
given() { # key -> its value from the form's answers; nothing in the terminal
  [[ -z "$answers" ]] || from_json "$1"
}
ask() { # key, prompt, default -> answer on stdout
  local answer
  if [[ -n "$answers" ]]; then
    answer="$(from_json "$1")"
  else
    read -r -p "$2 [${3:-}]: " answer
  fi
  printf '%s' "${answer:-${3:-}}"
}
ask_secret() { # key, prompt, optional -> answer on stdout, never echoed
  local answer
  if [[ -n "$answers" ]]; then
    answer="$(from_json "$1")"
  else
    read -r -s -p "$2: " answer
    printf '\n' >&2
  fi
  [[ -n "$answer" || "${3:-}" == optional ]] || { echo "Missing: $2. Stopping." >&2; exit 1; }
  printf '%s' "$answer"
}
json_field() { # file, field
  python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))[sys.argv[2]])' "$1" "$2"
}
supabase_api() { # method, path; for anything but GET, the JSON body on standard input
  local body=()
  [[ "$1" == GET ]] || body=(-H "content-type: application/json" --data-binary @-)
  curl -fsS -X "$1" "https://api.supabase.com$2" \
    -H @<(printf 'Authorization: Bearer %s' "$SUPABASE_ACCESS_TOKEN") ${body[@]+"${body[@]}"}
}

say "GitHub"
gh auth status >/dev/null 2>&1 || { echo "Run: gh auth login" >&2; exit 1; }
repo="$(gh repo view --json nameWithOwner --jq .nameWithOwner)" || {
  echo "This folder has no GitHub repository yet. Create it first (README.md)." >&2
  exit 1
}
echo "Repository: $repo"
name="$(ask name "Name for the projects (Vercel adds -web and -agent)" "$(basename "$repo")")"

say "Tokens"
[[ -n "$answers" ]] || echo "Vercel: https://vercel.com/account/tokens, scoped to the team that will own the projects."
VERCEL_TOKEN="$(ask_secret vercel_token "Vercel token")"
[[ -n "$answers" ]] || echo "Supabase: https://supabase.com/dashboard/account/tokens"
SUPABASE_ACCESS_TOKEN="$(ask_secret supabase_token "Supabase access token")"
export VERCEL_TOKEN SUPABASE_ACCESS_TOKEN
vercel_cli whoami >/dev/null 2>&1 || { echo "Vercel refused the token." >&2; exit 1; }
supabase projects list >/dev/null 2>&1 || { echo "Supabase refused the token." >&2; exit 1; }

# A Vercel token can reach several teams. The answer names one; otherwise the only one it reaches.
if [[ -z "${VERCEL_SCOPE:-}" ]]; then
  VERCEL_SCOPE="$(given vercel_team)"
  if [[ -z "$VERCEL_SCOPE" ]]; then
    teams="$(curl -fsS -H @<(printf 'Authorization: Bearer %s' "$VERCEL_TOKEN") https://api.vercel.com/v2/teams \
      | python3 -c 'import json,sys; print(" ".join(t["slug"] for t in json.load(sys.stdin).get("teams", [])))' || true)"
    if [[ "$teams" == *" "* ]]; then
      echo "The Vercel token reaches several teams ($teams). Name one, or scope the token to one." >&2
      exit 1
    fi
    VERCEL_SCOPE="$teams"
  fi
  export VERCEL_SCOPE
fi
echo "Vercel team: ${VERCEL_SCOPE:-your personal account}"

say "Supabase project"
project_ref="$(ask project_ref "Existing project reference (empty: create a new project)" "")"
db_password=""
created=false
if [[ -z "$project_ref" ]]; then
  orgs="$(supabase_api GET /v1/organizations \
    | python3 -c 'import json,sys; print(" ".join(o["slug"] for o in json.load(sys.stdin)))')"
  org="$(ask supabase_org "Supabase organisation for the new project ($orgs)" "")"
  if [[ -z "$org" ]]; then
    [[ "$orgs" != *" "* && -n "$orgs" ]] || { echo "Name the Supabase organisation: one of $orgs." >&2; exit 1; }
    org="$orgs"
  fi
  region="$(ask region "Region (eu-central-1 is Frankfurt, next to the Vercel functions)" "eu-central-1")"
  # Nobody types this password: GitHub keeps it for the migrations, and Supabase can reset it.
  db_password="$(openssl rand -base64 30 | tr -d '/+=\n' | head -c 32)"
  project_ref="$(NAME="$name" ORG="$org" REGION="$region" DB_PASS="$db_password" python3 -c '
import json, os
print(json.dumps({"name": os.environ["NAME"], "organization_slug": os.environ["ORG"], "db_pass": os.environ["DB_PASS"],
                  "region_selection": {"type": "specific", "code": os.environ["REGION"]}}))' \
    | supabase_api POST /v1/projects | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("ref") or d["id"])')"
  created=true
  echo "Created project $project_ref in $org ($region). Waiting until it is up (2 to 4 minutes)…"
  status=""
  for _ in $(seq 1 60); do
    status="$(supabase_api GET "/v1/projects/$project_ref" | python3 -c 'import json,sys; print(json.load(sys.stdin)["status"])' || true)"
    [[ "$status" == "ACTIVE_HEALTHY" ]] && break
    sleep 10
  done
  [[ "$status" == "ACTIVE_HEALTHY" ]] || { echo "Project $project_ref is still $status; run this again in a minute." >&2; exit 1; }
else
  # An existing project's password is needed only to apply migrations from here and to give it to
  # GitHub; without it, both are left to what GitHub already has.
  db_password="$(ask_secret db_password "Database password (empty: keep the one GitHub has)" optional)"
fi
echo "Project: $project_ref"

# The API keys are read straight from the project, so they are never typed or shown. A project
# without the new kind of keys gets them created.
publishable_key="$(find_supabase_keys "$project_ref" sb_publishable_ | head -1)"
secret_keys="$(find_supabase_keys "$project_ref" sb_secret_)"
if [[ -z "$publishable_key" ]]; then
  printf '{"type": "publishable", "name": "default"}' | supabase_api POST "/v1/projects/$project_ref/api-keys" >/dev/null
  publishable_key="$(find_supabase_keys "$project_ref" sb_publishable_ | head -1)"
  echo "Created a publishable key."
fi
if [[ -z "$secret_keys" ]]; then
  printf '{"type": "secret", "name": "default"}' | supabase_api POST "/v1/projects/$project_ref/api-keys" >/dev/null
  secret_keys="$(find_supabase_keys "$project_ref" sb_secret_)"
  echo "Created a secret key."
fi
secret_key="$(given secret_key)"
if [[ -n "$secret_key" ]]; then
  # Given explicitly: it must be one of this project's keys.
  printf '%s\n' "$secret_keys" | grep -qxF "$secret_key" \
    || { echo "That secret key does not belong to project $project_ref." >&2; exit 1; }
elif [[ "$(printf '%s\n' "$secret_keys" | grep -c .)" -gt 1 ]]; then
  # During a rotation the old and the new key both exist, and their order is not defined.
  echo "Project $project_ref has several secret keys. Give the one to use (secret_key)," >&2
  echo "or delete the old one in Supabase, Project Settings, API Keys." >&2
  exit 1
else
  secret_key="$secret_keys"
fi
[[ -n "$publishable_key" && -n "$secret_key" ]] || { echo "Could not read the API keys of $project_ref." >&2; exit 1; }
supabase_url="https://$project_ref.supabase.co"

SUPABASE_DB_PASSWORD="$db_password" supabase link --project-ref "$project_ref" >/dev/null
# The connection address without the password, which CI completes with SUPABASE_DB_PASSWORD.
pooler_url="$(cat supabase/.temp/pooler-url 2>/dev/null || true)"
if [[ -n "$db_password" ]]; then
  SUPABASE_DB_PASSWORD="$db_password" supabase db push --yes
  echo "Migrations applied."
elif [[ "$created" == false ]]; then
  echo "No database password given: the next release applies the migrations."
fi

say "Vercel projects"
for unit in web agent; do
  vercel_cli project add "$name-$unit" >/dev/null 2>&1 || echo "$name-$unit already exists; using it."
  vercel_cli link --cwd "$unit" --yes --project "$name-$unit" >/dev/null
done
org_id="$(json_field web/.vercel/project.json orgId)"
web_id="$(json_field web/.vercel/project.json projectId)"
agent_id="$(json_field agent/.vercel/project.json projectId)"

# The agent's address is needed by the web before anything is deployed. A project gets its
# production domain when it is created, so ask Vercel for it instead of guessing the name.
team_query=""
[[ "$org_id" == team_* ]] && team_query="?teamId=$org_id"
project_domain() { # project id -> its first production domain, or nothing
  curl -fsS -H @<(printf 'Authorization: Bearer %s' "$VERCEL_TOKEN") \
    "https://api.vercel.com/v9/projects/$1/domains$team_query" \
    | python3 -c 'import json,sys; d=json.load(sys.stdin).get("domains", []); print(d[0]["name"] if d else "")' \
    || true
}
agent_domain="$(project_domain "$agent_id")"
web_domain="$(project_domain "$web_id")"
agent_domain="$(ask agent_domain "Production domain of the agent project" "${agent_domain:-$name-agent.vercel.app}")"
web_domain="${web_domain:-$name-web.vercel.app}"
echo "Web: https://$web_domain  Agent: https://$agent_domain"

say "Model"
[[ -n "$answers" ]] || {
  echo "Examples: scripted (no key) | anthropic:claude-opus-5-5 | openai:gpt-5.2 |"
  echo "          openrouter:anthropic/claude-sonnet-4.6 | deepseek:deepseek-v4-flash"
}
agent_model="$(ask agent_model "AGENT_MODEL" "scripted")"
provider_key_name=""
provider_key=""
case "$agent_model" in
  anthropic:*) provider_key_name="ANTHROPIC_API_KEY" ;;
  openai:*|openai-chat:*|openai-responses:*) provider_key_name="OPENAI_API_KEY" ;;
  openrouter:*) provider_key_name="OPENROUTER_API_KEY" ;;
  deepseek:*) provider_key_name="DEEPSEEK_API_KEY" ;;
  scripted) ;;
  *) echo "Unknown provider prefix. Set its API key in the agent's Vercel project by hand." ;;
esac
[[ -z "$provider_key_name" ]] || provider_key="$(ask_secret provider_key "$provider_key_name")"
echo "Model: $agent_model"

# Kept between runs (the workflow passes the one stored in GitHub): a new secret on every run
# would make the old web and the new agent disagree between their promotions.
shared_secret="$(given shared_secret)"
[[ -n "$shared_secret" ]] || shared_secret="$(openssl rand -hex 32)"

# The token Admin > Deployment uses to change these values from production (ADR-0005).
github_token="$(ask_secret github_token "GitHub control token (empty: production cannot change settings)" optional)"

say "Vercel: production environment variables"
set_env() { # unit, name, value
  printf '%s' "$3" | vercel_cli env add "$2" production --cwd "$1" --force --yes >/dev/null
  echo "  $1: $2"
}
set_env web NEXT_PUBLIC_SUPABASE_URL "$supabase_url"
set_env web NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY "$publishable_key"
set_env web AGENT_URL "https://$agent_domain"
set_env web AGENT_SHARED_SECRET "$shared_secret"
set_env agent SUPABASE_URL "$supabase_url"
set_env agent SUPABASE_SECRET_KEY "$secret_key"
set_env agent AGENT_SHARED_SECRET "$shared_secret"
set_env agent AGENT_MODEL "$agent_model"
[[ -z "$provider_key_name" ]] || set_env agent "$provider_key_name" "$provider_key"
[[ -z "$github_token" ]] || set_env web GITHUB_CONTROL_TOKEN "$github_token"

say "GitHub: secrets and variables for the workflows"
# Only main may deploy: the environment holds the deployment's credentials, and without a branch
# rule any branch's workflow could ask for them. Setting the rule needs the Administration
# permission: your own `gh` has it, the Bootstrap workflow's token deliberately does not.
if gh api -X PUT "repos/$repo/environments/production" --input - >/dev/null 2>&1 <<'JSON'
{"deployment_branch_policy": {"protected_branches": false, "custom_branch_policies": true}}
JSON
then
  gh api -X POST "repos/$repo/environments/production/deployment-branch-policies" \
    -f name=main -f type=branch >/dev/null 2>&1 || true
  echo "  environment production: only main may use it"
else
  echo "  Could not restrict the production environment to main (the token lacks Administration)."
  echo "  Do it once: Settings, Environments, production, Deployment branches and tags, add 'main'."
fi
set_secret() { # name, value
  printf '%s' "$2" | gh secret set "$1" --repo "$repo" --env production
  echo "  secret $1"
}
set_secret VERCEL_TOKEN "$VERCEL_TOKEN"
set_secret VERCEL_ORG_ID "$org_id"
set_secret VERCEL_WEB_PROJECT_ID "$web_id"
set_secret VERCEL_AGENT_PROJECT_ID "$agent_id"
set_secret SUPABASE_PROJECT_REF "$project_ref"
[[ -z "$db_password" ]] || set_secret SUPABASE_DB_PASSWORD "$db_password"
set_secret AGENT_SHARED_SECRET "$shared_secret"
[[ -z "$github_token" ]] || set_secret GH_CONTROL_TOKEN "$github_token"
[[ -z "$provider_key_name" ]] || set_secret PROVIDER_API_KEY "$provider_key"
# The identity Vercel accepts as the author of a deployment: whoever owns the Vercel token. Read
# from Vercel, since a workflow runner has no git identity of its own.
author="$(curl -fsS -H @<(printf 'Authorization: Bearer %s' "$VERCEL_TOKEN") https://api.vercel.com/v2/user \
  | python3 -c 'import json,sys; u=json.load(sys.stdin)["user"]; print((u.get("name") or u.get("username") or "") + "\t" + (u.get("email") or ""))' || true)"
author_name="${author%%$'\t'*}"
author_email="${author#*$'\t'}"
[[ -n "$author_name" ]] || author_name="$(git config user.name || true)"
[[ -n "$author_email" ]] || author_email="$(git config user.email || true)"
gh variable set VERCEL_AUTHOR_NAME --repo "$repo" --body "$author_name"
gh variable set VERCEL_AUTHOR_EMAIL --repo "$repo" --body "$author_email"
gh variable set PRODUCTION_URL --repo "$repo" --body "https://$web_domain"
gh variable set AGENT_MODEL --repo "$repo" --body "$agent_model"
[[ -z "$pooler_url" ]] || gh variable set SUPABASE_POOLER_URL --repo "$repo" --body "$pooler_url"
echo "  variables VERCEL_AUTHOR_NAME, VERCEL_AUTHOR_EMAIL, PRODUCTION_URL, AGENT_MODEL, SUPABASE_POOLER_URL"

say "Supabase: closing sign-ups, setting the site address"
# A stranger who signs up belongs to no organisation and sees nothing, but would still get an
# account and make the project send emails. The site address is where Auth sends people back to.
if printf '{"disable_signup": true, "site_url": "https://%s"}' "$web_domain" \
  | supabase_api PATCH "/v1/projects/$project_ref/config/auth" >/dev/null; then
  echo "New sign-ups are off; the site address is set."
else
  echo "Could NOT turn sign-ups off automatically. Do it in the dashboard:"
  echo "  Authentication, Sign In / Providers, 'Allow new users to sign up'."
fi

say "Users"
# Everyone created here administers the first organisation; the first person is also a platform
# admin (manages every organisation). Others get finer roles later from Admin, People.
first_user=true
create() { # email, password
  local flags=(--role admin)
  if [[ "$first_user" == true ]]; then flags+=(--platform-admin); first_user=false; fi
  printf '%s\n' "$2" \
    | SUPABASE_URL="$supabase_url" SUPABASE_SECRET_KEY="$secret_key" scripts/create-user.sh "$1" "${flags[@]}" \
    || echo "$1 was not created; retry later with scripts/create-user.sh."
}
if [[ -n "$answers" ]]; then
  # One "email<TAB>password" line per user.
  while IFS=$'\t' read -r user_email user_password; do
    [[ -n "$user_email" ]] && create "$user_email" "$user_password"
  done < <(printf '%s' "$answers" | python3 -c '
import json, sys
for user in json.load(sys.stdin).get("users") or []:
    print(str(user.get("email") or "") + "\t" + str(user.get("password") or ""))
')
else
  while true; do
    user_email="$(ask user_email "Email of a user to create (empty to finish)" "")"
    [[ -n "$user_email" ]] || break
    read -r -s -p "Password for $user_email: " user_password
    printf '\n' >&2
    create "$user_email" "$user_password"
  done
fi

if [[ "$(given release)" == "y" ]]; then
  say "Release"
  gh workflow run deploy.yml --repo "$repo" --ref main
  echo "Started: follow it on the Setup page, in Admin › Releases, or in the Actions tab."
else
  cat <<NEXT

Done. Next:
  1. Start the first release: git push, or 'gh workflow run deploy.yml --ref main'.
  2. Open https://$web_domain, sign in, start the example run and approve the step.
NEXT
fi
