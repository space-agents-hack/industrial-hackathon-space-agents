#!/usr/bin/env bash
# Fail if this branch breaks the two migration rules (supabase/README.md):
#   1. a migration already on the base branch is never edited, renamed or deleted: the hosted
#      database will not run it again, so the edit would silently never happen there;
#   2. a new migration is newer than every migration on the base branch: `supabase db push`
#      refuses to insert one before the last applied, which turns main red at release time.
#      This is what happens when two people add migrations at the same time.
#
#   scripts/check-migrations.sh [base]     base defaults to origin/main
set -euo pipefail
cd "$(dirname "$0")/.."

base="${1:-origin/main}"
if ! git rev-parse --verify --quiet "$base^{commit}" >/dev/null; then
  echo "No base '$base' to compare with; skipping the migration check."
  exit 0
fi

status=0
while IFS=$'\t' read -r change path _; do
  [[ -n "$change" ]] || continue
  if [[ "$change" != "A" ]]; then
    echo "::error file=$path::A migration already on $base was changed ($change). Write a new migration instead."
    status=1
  fi
done < <(git diff --name-status --no-renames "$base" HEAD -- supabase/migrations)

newest_base="$(git ls-tree --name-only "$base" supabase/migrations/ | xargs -n1 basename 2>/dev/null | sort | tail -1)"
while IFS= read -r path; do
  [[ -n "$path" ]] || continue
  name="$(basename "$path")"
  if [[ -n "$newest_base" && ! "$name" > "$newest_base" ]]; then
    echo "::error file=$path::$name is older than $newest_base, already on $base. Recreate it with 'supabase migration new' so it sorts last."
    status=1
  fi
done < <(git diff --name-only --diff-filter=A "$base" HEAD -- supabase/migrations)

[[ $status -eq 0 ]] && echo "Migrations: ok against $base."
exit $status
