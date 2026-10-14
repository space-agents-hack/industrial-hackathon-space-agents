#!/usr/bin/env bash
# Connect a repository made from this template to its own Vercel and Supabase projects, once.
# After it finishes, pushing to main deploys.
#
# Two ways to run it, same steps:
#   the Bootstrap workflow (.github/workflows/bootstrap.yml), from GitHub alone: the usual way.
#                                      It runs this script with --from-json.
#   scripts/bootstrap.sh               asks each question in the terminal (needs the gh, vercel and
#                                      supabase CLIs signed in)
#
# What it does:
#   1. creates two Vercel projects (<name>-web, <name>-agent) and links web/ and agent/ to them
#   2. links the Supabase project you give it and, if you agree, applies the migrations
#   3. sets the production environment variables of both Vercel projects
#   4. sets the secrets and variables the GitHub workflows read, including the ones that let a
#      re-run keep what the last run chose (the web-agent secret, the model)
#   5. turns new sign-ups off in the Supabase project and creates the users you name
#
# What it does NOT do: create the Supabase project (do that in the dashboard first) or push.
#
# Secrets arrive on standard input and leave on standard input to the CLIs, or as curl headers read
# from a file descriptor; none is printed, passed as a command argument or written to disk. The only files it writes are the two .vercel/ link folders, which are ignored.
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
given() { # key -> its value from the Setup page's answers; nothing in the terminal
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
ask_secret() { # key, prompt -> answer on stdout, never echoed
  local answer
  if [[ -n "$answers" ]]; then
    answer="$(from_json "$1")"
  else
    read -r -s -p "$2: " answer
    printf '\n' >&2
  fi
  [[ -n "$answer" ]] || { echo "Missing: $2. Stopping." >&2; exit 1; }
  printf '%s' "$answer"
}
json_field() { # file, field
  python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))[sys.argv[2]])' "$1" "$2"
}

# In the Bootstrap workflow the CLIs sign in with tokens from the environment (GH_TOKEN,
# VERCEL_TOKEN, SUPABASE_ACCESS_TOKEN). A Vercel token can reach several teams; the workflow's
# input names one, otherwise the only team the token reaches is used.
if [[ -n "$answers" && -n "${VERCEL_TOKEN:-}" && -z "${VERCEL_SCOPE:-}" ]]; then
  VERCEL_SCOPE="$(given vercel_team)"
  if [[ -z "$VERCEL_SCOPE" ]]; then
    VERCEL_SCOPE="$(curl -fsS -H @<(printf 'Authorization: Bearer %s' "$VERCEL_TOKEN") https://api.vercel.com/v2/teams \
      | python3 -c 'import json,sys; t=json.load(sys.stdin).get("teams", []); print(t[0]["slug"] if len(t) == 1 else "")' || true)"
  fi
  export VERCEL_SCOPE
  [[ -z "$VERCEL_SCOPE" ]] || echo "Vercel team: $VERCEL_SCOPE"
fi

say "Checking that the three CLIs are signed in"
gh auth status >/dev/null 2>&1 || { echo "Run: gh auth login" >&2; exit 1; }
vercel_cli whoami >/dev/null 2>&1 || { echo "Run: vercel login" >&2; exit 1; }
supabase projects list >/dev/null 2>&1 || { echo "Run: supabase login" >&2; exit 1; }
repo="$(gh repo view --json nameWithOwner --jq .nameWithOwner)" || {
  echo "This folder has no GitHub repository yet. Create it first (README.md)." >&2
  exit 1
}
echo "GitHub repository: $repo"

name="$(ask name "Name for the Vercel projects (gets -web and -agent added)" "$(basename "$repo")")"

say "Vercel: creating and linking the two projects"
for unit in web agent; do
  vercel_cli project add "$name-$unit" >/dev/null 2>&1 || echo "$name-$unit already exists; using it."
  vercel_cli link --cwd "$unit" --yes --project "$name-$unit" >/dev/null
done
org_id="$(json_field web/.vercel/project.json orgId)"
web_id="$(json_field web/.vercel/project.json projectId)"
agent_id="$(json_field agent/.vercel/project.json projectId)"

[[ -n "$answers" ]] || echo "Create an access token at https://vercel.com/account/tokens (scope: the account or team above)."
vercel_token="$(ask_secret vercel_token "Vercel token")"

# The agent's address is needed by the web before anything is deployed. A project gets its
# production domain when it is created, so ask Vercel for it instead of guessing the name.
team_query=""
[[ "$org_id" == team_* ]] && team_query="?teamId=$org_id"
project_domain() { # project id -> its first production domain, or nothing
  curl -fsS -H @<(printf 'Authorization: Bearer %s' "$vercel_token") \
    "https://api.vercel.com/v9/projects/$1/domains$team_query" \
    | python3 -c 'import json,sys; d=json.load(sys.stdin).get("domains", []); print(d[0]["name"] if d else "")' \
    || true
}
agent_domain="$(project_domain "$agent_id")"
web_domain="$(project_domain "$web_id")"
agent_domain="$(ask agent_domain "Production domain of the agent project" "${agent_domain:-$name-agent.vercel.app}")"
echo "Agent: https://$agent_domain"

say "Supabase"
if [[ -z "$answers" ]]; then
  echo "Create the project at https://supabase.com/dashboard/new if you have not, then copy:"
  echo "  the project reference (Settings, General) and the database password you chose."
fi
project_ref="$(ask project_ref "Project reference" "")"
[[ -n "$project_ref" ]] || { echo "A project reference is required." >&2; exit 1; }
db_password="$(ask_secret db_password "Database password")"
[[ -n "$answers" ]] || echo "Create a personal access token at https://supabase.com/dashboard/account/tokens"
supabase_token="$(ask_secret supabase_token "Supabase access token")"

# The API keys are read straight from the project, so they are never typed or shown.
publishable_key="$(find_supabase_keys "$project_ref" sb_publishable_ | head -1)"
secret_keys="$(find_supabase_keys "$project_ref" sb_secret_)"
secret_key="$(given secret_key)"
if [[ -n "$secret_key" ]]; then
  # Given explicitly: it must be one of this project's keys.
  printf '%s\n' "$secret_keys" | grep -qxF "$secret_key" \
    || { echo "That secret key does not belong to project $project_ref." >&2; exit 1; }
elif [[ "$(printf '%s\n' "$secret_keys" | grep -c .)" -gt 1 ]]; then
  # During a rotation the old and the new key both exist, and their order is not defined.
  echo "Project $project_ref has several secret keys. Give the one to use (Advanced, in the form)," >&2
  echo "or delete the old one in Supabase, Project Settings, API Keys." >&2
  exit 1
else
  secret_key="$secret_keys"
fi
if [[ -n "$publishable_key" && -n "$secret_key" ]]; then
  echo "Read the publishable and secret keys from the project."
elif [[ -n "$answers" ]]; then
  echo "Could not read the API keys of $project_ref. Check that 'supabase login' was done with an account that can open the project." >&2
  exit 1
else
  echo "Could not read the keys automatically. Copy them from Settings, API Keys."
  publishable_key="$(ask publishable_key "Publishable key (sb_publishable_...)" "")"
  secret_key="$(ask_secret secret_key_typed "Secret key (sb_secret_...)")"
fi
supabase_url="https://$project_ref.supabase.co"

SUPABASE_DB_PASSWORD="$db_password" supabase link --project-ref "$project_ref"
if [[ "$(ask apply_migrations "Apply the migrations to $project_ref now? This cannot be undone (y/n)" "y")" == "y" ]]; then
  SUPABASE_DB_PASSWORD="$db_password" supabase db push --yes
  echo "Migrations applied."
fi

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

# The token Admin > Deployment uses to change these values from production (ADR-0005). Optional
# on a laptop; the Bootstrap workflow always has it.
github_token="$(given github_token)"

say "Vercel: setting production environment variables"
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

say "GitHub: setting secrets and variables for the workflow"
# Only main may deploy: the environment holds account-wide tokens, and without a branch rule any
# branch's workflow could ask for them.
# Setting that rule needs the Administration permission, which the Bootstrap workflow's token
# deliberately lacks: then it says where to click instead.
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
set_secret VERCEL_TOKEN "$vercel_token"
set_secret VERCEL_ORG_ID "$org_id"
set_secret VERCEL_WEB_PROJECT_ID "$web_id"
set_secret VERCEL_AGENT_PROJECT_ID "$agent_id"
set_secret SUPABASE_ACCESS_TOKEN "$supabase_token"
set_secret SUPABASE_PROJECT_REF "$project_ref"
set_secret SUPABASE_DB_PASSWORD "$db_password"
set_secret AGENT_SHARED_SECRET "$shared_secret"
[[ -z "$github_token" ]] || set_secret GH_CONTROL_TOKEN "$github_token"
[[ -z "$provider_key_name" ]] || set_secret PROVIDER_API_KEY "$provider_key"
# The identity Vercel accepts as the author of a deployment: whoever owns the Vercel token. Read
# from Vercel, since a workflow runner has no git identity of its own.
author="$(curl -fsS -H @<(printf 'Authorization: Bearer %s' "$vercel_token") https://api.vercel.com/v2/user \
  | python3 -c 'import json,sys; u=json.load(sys.stdin)["user"]; print((u.get("name") or u.get("username") or "") + "\t" + (u.get("email") or ""))' || true)"
author_name="${author%%$'\t'*}"
author_email="${author#*$'\t'}"
[[ -n "$author_name" ]] || author_name="$(git config user.name || true)"
[[ -n "$author_email" ]] || author_email="$(git config user.email || true)"
gh variable set VERCEL_AUTHOR_NAME --repo "$repo" --body "$author_name"
gh variable set VERCEL_AUTHOR_EMAIL --repo "$repo" --body "$author_email"
gh variable set PRODUCTION_URL --repo "$repo" --body "https://${web_domain:-$name-web.vercel.app}"
gh variable set AGENT_MODEL --repo "$repo" --body "$agent_model"
echo "  variables VERCEL_AUTHOR_NAME, VERCEL_AUTHOR_EMAIL, PRODUCTION_URL, AGENT_MODEL"

say "Supabase: closing sign-ups, setting the site address"
# Every signed-in user can see every run and spend model credits, so an open sign-up page is an
# open door. The site address is where Auth sends people back to. Best effort: if the API refuses,
# the message says where to do it by hand.
if curl -fsS -o /dev/null -X PATCH "https://api.supabase.com/v1/projects/$project_ref/config/auth" \
  -H @<(printf 'Authorization: Bearer %s' "$supabase_token") -H "content-type: application/json" \
  --data-binary @<(printf '{"disable_signup": true, "site_url": "https://%s"}' "${web_domain:-$name-web.vercel.app}"); then
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

cat <<NEXT

Done. Next:
  1. Start the first release: git push, or 'gh workflow run deploy.yml --ref main'.
  2. Open https://${web_domain:-$name-web.vercel.app}, sign in, start the example run and approve
     the step.
NEXT
