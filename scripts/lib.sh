#!/usr/bin/env bash
# Functions shared by the setup scripts. Sourced, not run.

# Read one API key of a hosted Supabase project by its prefix (sb_publishable_ or sb_secret_).
# The search is by prefix rather than by field name because the shape of this output has changed
# before. Prints nothing if the key cannot be read (not signed in, no access, wrong reference).
find_supabase_key() { # project ref, prefix
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
    print(next(walk(json.load(sys.stdin)), ""))
except Exception:
    print("")
' "$2" || true
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
