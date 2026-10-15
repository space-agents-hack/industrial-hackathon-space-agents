#!/usr/bin/env bash
# Connect a repository made from this template to its own Vercel and Supabase projects, once.
# After it finishes, pushing to main deploys.
#
# Two ways to run it, same steps:
#   the Setup page under `make dev` ("Deploy to production"): two tokens and your email in one
#                                      form, everything else automatic. Needs `gh` signed in. It
#                                      runs this script with --from-json.
#   scripts/bootstrap.sh               asks each question in the terminal.
# Production's own access to GitHub is a GitHub App, created from the same page (lib/github-app.ts);
# the release this script starts copies its key to the web.
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
# are pasted (ADR-0005). The Supabase token is used here only: GitHub keeps the database
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
# Vercel project names are lowercase letters, digits and dashes; a repository name may not be.
default_name="$(basename "$repo" | tr '[:upper:]' '[:lower:]' | tr -c 'a-z0-9-\n' '-' | sed -e 's/--*/-/g' -e 's/^-//' -e 's/-$//')"
name="$(ask name "Name for the projects (Vercel adds -web and -agent)" "$default_name")"

# What GitHub already holds for production, by name: a run repeated on a connected repository
# keeps what it can instead of replacing it. (No environment yet: nothing.)
github_secrets="$(gh api "repos/$repo/environments/production/secrets" --jq '.secrets[].name' 2>/dev/null || true)"
github_has() { printf '%s\n' "$github_secrets" | grep -qx "$1"; }
# `gh variable get`, not `gh api`: on a 404 `gh api` prints GitHub's error body to stdout, which
# would read as the value. This prints nothing for a variable that does not exist.
github_variable() { gh variable get "$1" --repo "$repo" 2>/dev/null || true; }
connected=false
github_has VERCEL_WEB_PROJECT_ID && connected=true
set_secret() { # name, value
  printf '%s' "$2" | gh secret set "$1" --repo "$repo" --env production
  echo "  secret $1"
}

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
known_ref="$(github_variable SUPABASE_PROJECT_REF)"
# In a terminal, Enter keeps the project setup used last time; the form always says which it wants.
default_ref=""
[[ -n "$answers" ]] || default_ref="$known_ref"
project_ref="$(ask project_ref "Existing project reference (empty: create a new project)" "$default_ref")"
db_password=""
# GitHub keeps it for the migrations and Supabase can reset it, so nobody has to type or keep it.
new_password() { openssl rand -base64 30 | tr -d '/+=\n' | head -c 32; }
# Repeating setup must not quietly point production at a new, empty database: a repository that
# already has one (connected, or made by a run that stopped half-way) needs it asked for.
if [[ -z "$project_ref" ]] && { [[ "$connected" == true ]] || [[ -n "$known_ref" ]]; }; then
  replace="$(ask replace_database "This repository already has a Supabase project${known_ref:+ ($known_ref)}. Create a new, empty one and move production to it? (y/n)" "n")"
  if [[ "$replace" != "y" ]]; then
    echo "Stopped: choose the existing project${known_ref:+ $known_ref}, or ask for a new one (Replace the database)." >&2
    exit 1
  fi
fi
wait_until_up() { # project ref
  local status=""
  for _ in $(seq 1 60); do
    status="$(supabase_api GET "/v1/projects/$1" | python3 -c 'import json,sys; print(json.load(sys.stdin)["status"])' || true)"
    [[ "$status" == "ACTIVE_HEALTHY" ]] && return 0
    sleep 10
  done
  echo "Project $1 is still ${status:-not answering}; press the button again in a minute." >&2
  return 1
}
migrate=true
if [[ -z "$project_ref" ]]; then
  orgs="$(supabase_api GET /v1/organizations \
    | python3 -c 'import json,sys; print(" ".join(o["slug"] for o in json.load(sys.stdin)))')"
  org="$(ask supabase_org "Supabase organisation for the new project ($orgs)" "")"
  if [[ -z "$org" ]]; then
    [[ "$orgs" != *" "* && -n "$orgs" ]] || { echo "Name the Supabase organisation: one of $orgs." >&2; exit 1; }
    org="$orgs"
  fi
  region="$(ask region "Region (eu-central-1 is Frankfurt, next to the Vercel functions)" "eu-central-1")"
  db_password="$(new_password)"
  project_ref="$(NAME="$name" ORG="$org" REGION="$region" DB_PASS="$db_password" python3 -c '
import json, os
print(json.dumps({"name": os.environ["NAME"], "organization_slug": os.environ["ORG"], "db_pass": os.environ["DB_PASS"],
                  "region_selection": {"type": "specific", "code": os.environ["REGION"]}}))' \
    | supabase_api POST /v1/projects | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("ref") or d["id"])')"
  # Kept in GitHub at once: if anything below fails, running this again finds the project and its
  # password instead of creating a second one.
  gh api -X PUT "repos/$repo/environments/production" --input - >/dev/null <<'JSON' || true
{"deployment_branch_policy": {"protected_branches": false, "custom_branch_policies": true}}
JSON
  gh variable set SUPABASE_PROJECT_REF --repo "$repo" --body "$project_ref"
  set_secret SUPABASE_PROJECT_REF "$project_ref"
  set_secret SUPABASE_DB_PASSWORD "$db_password"
  echo "Created project $project_ref in $org ($region). Waiting until it is up (2 to 4 minutes)…"
  wait_until_up "$project_ref" || exit 1
else
  # A run that stopped half-way may have left it still coming up.
  wait_until_up "$project_ref" || exit 1
  db_password="$(ask_secret db_password "Database password (empty: keep GitHub's, or set a new one)" optional)"
  if [[ -z "$db_password" && "$project_ref" == "$known_ref" ]] && github_has SUPABASE_DB_PASSWORD; then
    # The project this repository already uses: GitHub's password stays, and releases migrate.
    migrate=false
  elif [[ -z "$db_password" ]]; then
    # Supabase lets the token set a new one; stored in GitHub at once, so a run that stops later
    # does not leave releases with the old password.
    db_password="$(new_password)"
    DB_PASS="$db_password" python3 -c 'import json, os; print(json.dumps({"password": os.environ["DB_PASS"]}))' \
      | supabase_api PATCH "/v1/projects/$project_ref/database/password" >/dev/null
    set_secret SUPABASE_DB_PASSWORD "$db_password"
    set_secret SUPABASE_PROJECT_REF "$project_ref"
    gh variable set SUPABASE_PROJECT_REF --repo "$repo" --body "$project_ref"
    echo "Set a new database password for $project_ref (anything else using the old one stops working)."
  fi
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
  echo "Project $project_ref has several secret keys, and setup cannot tell which one is current." >&2
  echo "Delete the old one in Supabase, Project Settings, API Keys, then press the button again." >&2
  exit 1
else
  secret_key="$secret_keys"
fi
[[ -n "$publishable_key" && -n "$secret_key" ]] || { echo "Could not read the API keys of $project_ref." >&2; exit 1; }
supabase_url="https://$project_ref.supabase.co"

if [[ "$migrate" == true ]]; then
  SUPABASE_DB_PASSWORD="$db_password" supabase link --project-ref "$project_ref" >/dev/null
  SUPABASE_DB_PASSWORD="$db_password" supabase db push --yes
  echo "Migrations applied."
else
  echo "Migrations: the release applies any new ones, with the password GitHub has."
fi
# The connection address without the password (session mode, port 5432), which releases complete
# with SUPABASE_DB_PASSWORD. Asked of Supabase, and checked to be this project's.
pooler_url="$(supabase_api GET "/v1/projects/$project_ref/config/database/pooler" | REF="$project_ref" python3 -c '
import json, os, sys
entries = json.load(sys.stdin)
entries = entries if isinstance(entries, list) else [entries]
for e in entries:
    if e.get("database_type", "PRIMARY") == "PRIMARY" and e.get("db_host", "").endswith(".pooler.supabase.com") \
            and e.get("db_user") == "postgres." + os.environ["REF"]:
        print("postgresql://%s@%s:5432/%s" % (e["db_user"], e["db_host"], e.get("db_name") or "postgres"))
        break
' || true)"
[[ -n "$pooler_url" ]] || { echo "Supabase did not give the connection address of $project_ref." >&2; exit 1; }

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
# Empty keeps the model production already has (GitHub's AGENT_MODEL), so repeating setup does not
# quietly switch it back to the scripted one.
current_model="$(github_variable AGENT_MODEL)"
agent_model="$(ask agent_model "AGENT_MODEL (empty: keep the current one)" "")"
if [[ -z "$agent_model" ]]; then
  agent_model="$current_model"
  # Connected before the model was kept in GitHub: Vercel has it, and it stays there untouched.
  [[ -n "$agent_model" || "$connected" == true ]] || agent_model="scripted"
fi
provider_key_name=""
provider_key=""
case "$agent_model" in
  anthropic:*) provider_key_name="ANTHROPIC_API_KEY" ;;
  openai:*|openai-chat:*|openai-responses:*) provider_key_name="OPENAI_API_KEY" ;;
  openrouter:*) provider_key_name="OPENROUTER_API_KEY" ;;
  deepseek:*) provider_key_name="DEEPSEEK_API_KEY" ;;
  scripted|"") ;;
  *) echo "Unknown provider prefix. Set its API key in the agent's Vercel project by hand." ;;
esac
if [[ -n "$provider_key_name" ]]; then
  # A kept model already has its key in GitHub and Vercel; a new one needs it now.
  provider_key="$(ask_secret provider_key "$provider_key_name (empty: keep the one stored)" optional)"
  if [[ -z "$provider_key" && "$agent_model" != "$current_model" ]]; then
    echo "The model $agent_model needs its $provider_key_name." >&2
    exit 1
  fi
fi
echo "Model: ${agent_model:-unchanged (the one in Vercel)}"

# Kept between runs: a new secret on every run would make the old web and the new agent disagree
# between their promotions. A new one only if GitHub has none, or when asked to renew it; the
# release copies it to both projects ("Carry settings to Vercel").
shared_secret=""
if ! github_has AGENT_SHARED_SECRET || [[ "$(given renew_shared_secret)" == "y" ]]; then
  shared_secret="$(openssl rand -hex 32)"
fi

say "Vercel: production environment variables"
set_env() { # unit, name, value
  printf '%s' "$3" | vercel_cli env add "$2" production --cwd "$1" --force --yes >/dev/null
  echo "  $1: $2"
}
set_env web NEXT_PUBLIC_SUPABASE_URL "$supabase_url"
set_env web NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY "$publishable_key"
set_env web AGENT_URL "https://$agent_domain"
set_env agent SUPABASE_URL "$supabase_url"
set_env agent SUPABASE_SECRET_KEY "$secret_key"
[[ -z "$agent_model" ]] || set_env agent AGENT_MODEL "$agent_model"
[[ -z "$provider_key" ]] || set_env agent "$provider_key_name" "$provider_key"
# The shared secret goes to GitHub only; the release copies it to both projects at once.

say "GitHub: secrets and variables for the workflows"
# Only main may deploy: the environment holds the deployment's credentials, and without a branch
# rule any branch's workflow could ask for them. Setting the rule needs the Administration
# permission, which your own `gh` has as the repository's owner.
if gh api -X PUT "repos/$repo/environments/production" --input - >/dev/null 2>&1 <<'JSON'
{"deployment_branch_policy": {"protected_branches": false, "custom_branch_policies": true}}
JSON
then
  gh api -X POST "repos/$repo/environments/production/deployment-branch-policies" \
    -f name=main -f type=branch >/dev/null 2>&1 || true
  echo "  environment production: only main may use it"
else
  echo "  Could not restrict the production environment to main (your gh lacks admin rights here)."
  echo "  Do it once: Settings, Environments, production, Deployment branches and tags, add 'main'."
fi
set_secret VERCEL_TOKEN "$VERCEL_TOKEN"
set_secret VERCEL_ORG_ID "$org_id"
set_secret VERCEL_WEB_PROJECT_ID "$web_id"
set_secret VERCEL_AGENT_PROJECT_ID "$agent_id"
set_secret SUPABASE_PROJECT_REF "$project_ref"
set_secret SUPABASE_DB_PASSWORD "$db_password"
[[ -z "$shared_secret" ]] || set_secret AGENT_SHARED_SECRET "$shared_secret"
[[ -z "$provider_key" ]] || set_secret PROVIDER_API_KEY "$provider_key"
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
[[ -z "$agent_model" ]] || gh variable set AGENT_MODEL --repo "$repo" --body "$agent_model"
gh variable set SUPABASE_PROJECT_REF --repo "$repo" --body "$project_ref"
gh variable set SUPABASE_POOLER_URL --repo "$repo" --body "$pooler_url"
echo "  variables VERCEL_AUTHOR_NAME, VERCEL_AUTHOR_EMAIL, PRODUCTION_URL, AGENT_MODEL, SUPABASE_PROJECT_REF, SUPABASE_POOLER_URL"
# Releases no longer need an account-wide Supabase token (they use the address above and the
# password). One left by an earlier setup is removed; revoke it in Supabase too.
if github_has SUPABASE_ACCESS_TOKEN; then
  gh secret delete SUPABASE_ACCESS_TOKEN --env production --repo "$repo"
  echo "  removed SUPABASE_ACCESS_TOKEN (no longer used; revoke it at supabase.com/dashboard/account/tokens)"
fi


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
  # Every release copies what GitHub holds (the shared secret, the model, the GitHub App's key)
  # to Vercel before deploying.
  gh workflow run deploy.yml --repo "$repo" --ref main
  echo "Started: follow it on the Setup page, in Admin › Releases, or in the Actions tab."
else
  cat <<NEXT

Done. Next:
  1. Start the first release: git push, or 'gh workflow run deploy.yml --ref main'.
  2. Open https://$web_domain, sign in, start the example run and approve the step.
NEXT
fi
