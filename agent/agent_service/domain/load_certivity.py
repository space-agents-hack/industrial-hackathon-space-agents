"""Write Certivity's reference files (regulation index, answer files) to the database that
agent/.env points at, local or hosted: `make certivity-load CERTIVITY=<package clone>`.

Run it again after every `git pull` of the package: the held-out case arrives that way.

`--json` prints the rows instead of writing them, for the release workflow: it holds the
database password, not the API's secret key, so it writes them with psql
(scripts/load-certivity.sql)."""

import asyncio
import json
import sys
from pathlib import Path

from agent_service.domain import certivity
from agent_service.settings import get_settings
from agent_service.store import SupabaseRunStore


async def _load_command(root: Path) -> int:
    rows = certivity.read_package(root)
    if not rows:
        print(f"No reference files found under {root}.", file=sys.stderr)
        return 1
    settings = get_settings()
    if not settings.supabase_url or not settings.supabase_secret_key:
        print("SUPABASE_URL and SUPABASE_SECRET_KEY are not set (agent/.env).", file=sys.stderr)
        return 1
    store = await SupabaseRunStore.connect(settings.supabase_url, settings.supabase_secret_key)
    try:
        await store.replace_certivity_reference(rows)
    finally:
        await store.aclose()
    for r in rows:
        print(f"  {r['kind']:<17} {r['case_id'] or '-'}")
    print(
        f"Loaded {len(rows)} files (Certivity commit {rows[0]['certivity_commit']}) "
        f"into {settings.supabase_url}."
    )
    return 0


def _json_command(root: Path) -> int:
    rows = certivity.read_package(root)
    if not rows:
        print(f"No reference files found under {root}.", file=sys.stderr)
        return 1
    json.dump(rows, sys.stdout)
    return 0


if __name__ == "__main__":
    args = sys.argv[1:]
    if args[:1] == ["--json"] and len(args) == 2:
        raise SystemExit(_json_command(Path(args[1])))
    if len(args) != 1:
        print(
            "usage: python -m agent_service.domain.load_certivity [--json] <Certivity package>",
            file=sys.stderr,
        )
        raise SystemExit(2)
    raise SystemExit(asyncio.run(_load_command(Path(args[0]))))
