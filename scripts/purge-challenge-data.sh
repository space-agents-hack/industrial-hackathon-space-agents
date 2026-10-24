#!/usr/bin/env bash
# Delete challenge material from this machine.
#
# Why this exists: hackathon and client terms usually say partner data may be used only for the
# event and must not be kept afterwards. This removes what the template itself stores locally.
#
# What it does NOT reach (do these by hand, the script lists them again at the end):
#   - the hosted Supabase project and the Vercel projects, including their logs
#   - copies outside this repo: downloads, chat transcripts, coding-agent sessions
#   - the model provider's own request logs
set -euo pipefail
cd "$(dirname "$0")/.."

echo "This deletes everything in data/ and every run in the LOCAL database."
read -r -p "Type 'purge' to continue: " answer
[[ "$answer" == "purge" ]] || { echo "Nothing deleted."; exit 1; }

find data -mindepth 1 ! -name .gitkeep -delete 2>/dev/null || true
echo "Emptied data/"

if supabase status >/dev/null 2>&1; then
  # run_events, approvals and run_state go with their runs (on delete cascade).
  project="$(grep -E '^project_id' supabase/config.toml | cut -d'"' -f2)"
  docker exec -i "supabase_db_${project}" \
    psql -U postgres -d postgres -q -c "delete from public.runs; delete from public.certivity_reference;"
  echo "Deleted local runs and Certivity's reference files."
else
  echo "Local Supabase is not running; no local rows were deleted. Start it and run this again."
fi

cat <<'NEXT'

Still to do by hand:
  [ ] Hosted Supabase: delete the project, or its rows (runs, certivity_reference) and backups.
  [ ] Vercel: delete the projects, or at least their logs and environment variables.
  [ ] Model provider: check the data retention of the account that was used.
  [ ] Your machine: downloads, screenshots, coding-agent transcripts that quote the material.
  [ ] The repository: confirm nothing from the partner was committed (git log -p -- data/).
  [ ] The repository: Certivity's index.json and expected files were committed in agent/certivity/
      from ac791c2 until they moved to the database; they stay in git history until the repository
      is deleted or archived.
NEXT
