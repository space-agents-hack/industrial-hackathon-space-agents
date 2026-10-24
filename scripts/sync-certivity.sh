#!/usr/bin/env bash
# Copy Certivity's checking code into agent/certivity/. Only the code: their data (the regulation
# index, the answer files) is licensed for the hackathon only and goes to the database instead,
# with `make certivity-load CERTIVITY=<same path>`.
#
#   scripts/sync-certivity.sh ../industrial-ai-hackathon
#
# Run it again after every `git pull` of the Certivity package (the held-out case arrives that way
# on Sunday morning, and Certivity may fix validate.py during the event). The copy is byte for byte
# on purpose: Certivity's platform runs this same validate.py, so an unchanged copy is what makes
# "valid on our web" mean "accepted on upload".
#
# What it copies: tools/validate.py and tools/score_local.py, schemas/ and the two licence files.
set -euo pipefail
cd "$(dirname "$0")/.."

src="${1:?usage: scripts/sync-certivity.sh <path to the Certivity package clone>}"
[[ -f "$src/tools/validate.py" && -f "$src/regulations/index.json" ]] \
  || { echo "$src does not look like the Certivity package (no tools/validate.py)." >&2; exit 1; }

dest=agent/certivity
find "$dest" -mindepth 1 ! -name README.md -delete 2>/dev/null || true
mkdir -p "$dest"

files=(LICENSE LICENSE-DATA.md tools/validate.py tools/score_local.py)
while IFS= read -r f; do files+=("$f"); done < <(cd "$src" && find schemas -name '*.json')

for f in "${files[@]}"; do
  mkdir -p "$dest/$(dirname "$f")"
  cp "$src/$f" "$dest/$f"
done

commit="$(git -C "$src" rev-parse --short HEAD 2>/dev/null || echo unknown)"
{
  echo "# Copied by scripts/sync-certivity.sh from the Certivity package at commit $commit."
  echo "# agent/tests/test_certivity.py fails if a file below differs from its hash: edit upstream, not here."
  (cd "$dest" && find . -type f ! -name README.md ! -name SOURCE ! -path '*/__pycache__/*' | sed 's|^\./||' | sort | xargs sha256sum)
} > "$dest/SOURCE"

echo "Copied ${#files[@]} files from $src ($commit) to $dest."
