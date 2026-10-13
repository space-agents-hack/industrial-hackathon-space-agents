#!/usr/bin/env bash
# Connect a repository made from this template to its own Vercel and Supabase projects, once.
# After it finishes, pushing to main deploys.
#
# STATUS: written from the CLIs' documentation and not yet run end to end against real accounts
# (docs/deploy.md, "Not yet verified"). It stops at the first error and is safe to run again.
#
# What it does:
#   1. creates two Vercel projects (<name>-web, <name>-agent) and links web/ and agent/ to them
#   2. links the Supabase project you give it and, if you agree, applies the migrations
#   3. sets the production environment variables of both Vercel projects
#   4. sets the secrets and variables the GitHub workflow reads
#
# What it does NOT do: create the Supabase project (do that in the dashboard first), create users,
# turn sign-ups off (supabase/README.md), or push.
#
# Every secret is typed into a hidden prompt and passed on standard input. Nothing is written to
# disk except the two .vercel/ link folders, which are git-ignored.
set -euo pipefail
cd "$(dirname "$0")/.."

say() { printf '\n== %s\n' "$*"; }
ask() { # prompt, default -> answer on stdout
  local answer
  read -r -p "$1 [${2:-}]: " answer
  printf '%s' "${answer:-${2:-}}"
}
ask_secret() { # prompt -> answer on stdout, not echoed
  local answer
  read -r -s -p "$1: " answer
  printf '\n' >&2
  [[ -n "$answer" ]] || { echo "Empty value; stopping." >&2; exit 1; }
  printf '%s' "$answer"
}
json_field() { # file, field
  python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))[sys.argv[2]])' "$1" "$2"
}

say "Checking that the three CLIs are signed in"
gh auth status >/dev/null 2>&1 || { echo "Run: gh auth login" >&2; exit 1; }
vercel whoami >/dev/null 2>&1 || { echo "Run: vercel login" >&2; exit 1; }
supabase projects list >/dev/null 2>&1 || { echo "Run: supabase login" >&2; exit 1; }
repo="$(gh repo view --json nameWithOwner --jq .nameWithOwner)" || {
  echo "This folder has no GitHub repository yet. Create it first (README.md)." >&2
  exit 1
}
echo "GitHub repository: $repo"

name="$(ask "Name for the Vercel projects (gets -web and -agent added)" "$(basename "$repo")")"

say "Vercel: creating and linking the two projects"
for unit in web agent; do
  vercel project add "$name-$unit" >/dev/null 2>&1 || echo "$name-$unit already exists; using it."
  vercel link --cwd "$unit" --yes --project "$name-$unit" >/dev/null
done
org_id="$(json_field web/.vercel/project.json orgId)"
web_id="$(json_field web/.vercel/project.json projectId)"
agent_id="$(json_field agent/.vercel/project.json projectId)"

echo "Create an access token at https://vercel.com/account/tokens (scope: the account or team above)."
vercel_token="$(ask_secret "Vercel token")"

# The agent's address is needed by the web before anything is deployed. A project gets its
# production domain when it is created, so ask Vercel for it instead of guessing the name.
team_query=""
[[ "$org_id" == team_* ]] && team_query="?teamId=$org_id"
agent_domain="$(curl -fsS -H "Authorization: Bearer $vercel_token" \
  "https://api.vercel.com/v9/projects/$agent_id/domains$team_query" \
  | python3 -c 'import json,sys; d=json.load(sys.stdin).get("domains", []); print(d[0]["name"] if d else "")' \
  || true)"
agent_domain="$(ask "Production domain of the agent project" "${agent_domain:-$name-agent.vercel.app}")"

say "Supabase"
echo "Create the project at https://supabase.com/dashboard/new if you have not, then copy:"
echo "  the project reference (Settings, General), and the keys (Settings, API Keys)."
project_ref="$(ask "Project reference" "")"
[[ -n "$project_ref" ]] || { echo "A project reference is required." >&2; exit 1; }
db_password="$(ask_secret "Database password")"
publishable_key="$(ask "Publishable key (sb_publishable_...)" "")"
secret_key="$(ask_secret "Secret key (sb_secret_...)")"
echo "Create a personal access token at https://supabase.com/dashboard/account/tokens"
supabase_token="$(ask_secret "Supabase access token")"
supabase_url="https://$project_ref.supabase.co"

SUPABASE_DB_PASSWORD="$db_password" supabase link --project-ref "$project_ref"
if [[ "$(ask "Apply the migrations to $project_ref now? This cannot be undone (y/n)" "n")" == "y" ]]; then
  SUPABASE_DB_PASSWORD="$db_password" supabase db push
fi

say "Model"
echo "Examples: scripted (no key) | anthropic:claude-opus-5-5 | openai:gpt-5.2 |"
echo "          openrouter:anthropic/claude-sonnet-4.6 | deepseek:deepseek-v4-flash"
agent_model="$(ask "AGENT_MODEL" "scripted")"
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
[[ -z "$provider_key_name" ]] || provider_key="$(ask_secret "$provider_key_name")"

shared_secret="$(openssl rand -hex 32)"

say "Vercel: setting production environment variables"
set_env() { # unit, name, value
  printf '%s' "$3" | vercel env add "$2" production --cwd "$1" --force --yes >/dev/null
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

say "GitHub: setting secrets and variables for the workflow"
gh api -X PUT "repos/$repo/environments/production" >/dev/null
set_secret() { # name, value
  printf '%s' "$2" | gh secret set "$1" --repo "$repo" --env production
}
set_secret VERCEL_TOKEN "$vercel_token"
set_secret VERCEL_ORG_ID "$org_id"
set_secret VERCEL_WEB_PROJECT_ID "$web_id"
set_secret VERCEL_AGENT_PROJECT_ID "$agent_id"
set_secret SUPABASE_ACCESS_TOKEN "$supabase_token"
set_secret SUPABASE_PROJECT_REF "$project_ref"
set_secret SUPABASE_DB_PASSWORD "$db_password"
# The identity Vercel accepts as the author of a deployment: whoever owns the projects, which is
# whoever is running this script.
gh variable set VERCEL_AUTHOR_NAME --repo "$repo" --body "$(git config user.name)"
gh variable set VERCEL_AUTHOR_EMAIL --repo "$repo" --body "$(git config user.email)"

cat <<NEXT

Done. Still by hand, in this order:
  1. Supabase dashboard: turn off new sign-ups and set the Site URL (supabase/README.md).
  2. Create your users:
       SUPABASE_URL=$supabase_url SUPABASE_SECRET_KEY=<secret key> scripts/create-user.sh you@example.com
  3. git push. Watch the run in the Actions tab; the first release is the real test of this setup.
  4. Open the site, start the example run and approve the step.
NEXT
