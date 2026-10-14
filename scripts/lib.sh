#!/usr/bin/env bash
# Functions shared by the setup scripts. Sourced, not run.

# The API keys of a hosted Supabase project that start with a prefix (sb_publishable_ or
# sb_secret_), one per line. The search is by prefix rather than by field name because the shape
# of this output has changed before. Prints nothing if they cannot be read (not signed in, no
# access, wrong reference). Several lines mean several keys exist, e.g. during a rotation; the
# caller must not pick one at random.
find_supabase_keys() { # project ref, prefix
  supabase projects api-keys --project-ref "$1" --reveal --output-format json 2>/dev/null \
    | python3 -c '
import json, sys
prefix = sys.argv[1]
def walk(node):
    if isinstance(node, str):
        if node.startswith(prefix):
            yield node
    elif isinstance(node, dict):
        for value in node.values():
            yield from walk(value)
    elif isinstance(node, list):
        for value in node:
            yield from walk(value)
try:
    for key in dict.fromkeys(walk(json.load(sys.stdin))):
        print(key)
except Exception:
    pass
' "$2" || true
}

# The Vercel CLI version CI pins (.github/workflows/deploy.yml), so every script uses the same one.
vercel_cli() {
  local version
  version="$(grep -E '^\s*VERCEL_CLI_VERSION:' .github/workflows/deploy.yml | head -1 | cut -d'"' -f2)"
  npx --yes "vercel@${version:-latest}" "$@"
}

# Set KEY=VALUE in an env file, replacing the line if the key is already there. Other lines (a
# model, an API key someone added) are left alone.
set_env_line() { # file, key, value
  python3 - "$1" "$2" "$3" <<'PY'
import pathlib, sys
path, key, value = pathlib.Path(sys.argv[1]), sys.argv[2], sys.argv[3]
lines = path.read_text().splitlines() if path.exists() else []
for index, line in enumerate(lines):
    if line.startswith(f"{key}="):
        lines[index] = f"{key}={value}"
        break
else:
    lines.append(f"{key}={value}")
path.write_text("\n".join(lines) + "\n")
PY
}
