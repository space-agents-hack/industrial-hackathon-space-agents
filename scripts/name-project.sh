#!/usr/bin/env bash
# Give a repository made from the template its own local Supabase identity.
#
# Why: the local stack names its Docker containers and volumes after `project_id`. A clone that
# keeps the template's id shares the template's local database, and whichever of the two starts
# second finds the other's data and users.
set -euo pipefail
cd "$(dirname "$0")/.."

template_id="industrial-agent-template"
current="$(grep -E '^project_id' supabase/config.toml | cut -d'"' -f2)"
wanted="$(basename "$PWD")"

if [[ "$current" == "$template_id" && "$wanted" != "$template_id" ]]; then
  sed -i.bak -E "s/^project_id = \".*\"/project_id = \"$wanted\"/" supabase/config.toml
  rm -f supabase/config.toml.bak
  echo "Local Supabase project renamed to '$wanted' (supabase/config.toml). Commit this change."
fi

# For .gitattributes: TODO.md and supabase/config.toml stay this project's own when the template is
# pulled. The driver is local git configuration, so each clone sets it once.
git config merge.ours.driver true
if ! git remote get-url template >/dev/null 2>&1 && [[ "$wanted" != "$template_id" ]]; then
  git remote add template https://github.com/clemenjuan/industrial-agent-template.git
  echo "Added the 'template' remote: 'git pull --no-rebase template main' brings template fixes."
fi
