"""Index a regulation library for search, or query it, against the database that agent/.env points
at, local or hosted.

    make regulations-index                      # vectors and summaries, slice after slice
    make regulations-search Q="rear position lamp luminous intensity" [MODE=text] [K=10]

ORG=<uuid> picks the organisation; without it the database must have exactly one. The provider keys
come from the organisation's settings or from OPENAI_API_KEY (vectors) and the summary model's
own variable, as in a run.
"""

import argparse
import asyncio
import sys
import textwrap
from uuid import UUID

import httpx

from agent_service.domain import regulation_search
from agent_service.domain.search_store import SupabaseSearchStore
from agent_service.settings import get_settings


async def _organization(store: SupabaseSearchStore, given: str | None) -> UUID:
    if given:
        return UUID(given)
    found = await store.organizations(limit=2)
    if len(found) != 1:
        raise SystemExit("The database does not have exactly one organisation: pass ORG=<uuid>.")
    return found[0]


async def _index(store: SupabaseSearchStore, org: UUID) -> int:
    settings = get_settings()
    async with httpx.AsyncClient() as http:
        while True:
            p = await regulation_search.index_library(store, http, settings, org)
            print(
                f"  keys changed {p.keys_changed}, embedded {p.embedded}, pruned {p.pruned}, "
                f"summarised {p.summarized}"
            )
            for note in p.notes:
                print(f"  note: {note}")
            if p.done:
                print("Indexed.")
                return 0
            if not (p.embedded or p.summarized):
                # Nothing moved: a missing key or model (see the notes). Looping would not help.
                print("Stopped: this slice made no progress.", file=sys.stderr)
                return 1


async def _search(
    store: SupabaseSearchStore, org: UUID, query: str, mode: regulation_search.SearchMode, k: int
) -> int:
    async with httpx.AsyncClient() as http:
        hits = await regulation_search.search(
            store, http, get_settings(), org, query, k=k, mode=mode
        )
    for i, h in enumerate(hits, start=1):
        pages = str(h.page_start) if h.page_start == h.page_end else f"{h.page_start}-{h.page_end}"
        ranks = f"text {h.text_rank or '-'}, vector {h.vector_rank or '-'}"
        print(f"{i:>2}. {h.regulation_code} {h.version_label} {h.label}  p.{pages}  ({ranks})")
        print(textwrap.indent(textwrap.shorten(h.text, 300), "    "))
    if not hits:
        print("Nothing found.")
    return 0


async def _main(args: argparse.Namespace) -> int:
    settings = get_settings()
    if not settings.supabase_url or not settings.supabase_secret_key:
        print("SUPABASE_URL and SUPABASE_SECRET_KEY are not set (agent/.env).", file=sys.stderr)
        return 1
    store = await SupabaseSearchStore.connect(settings.supabase_url, settings.supabase_secret_key)
    try:
        org = await _organization(store, args.org)
        if args.command == "index":
            return await _index(store, org)
        return await _search(store, org, args.query, args.mode, args.k)
    finally:
        await store.aclose()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(prog="python -m agent_service.domain.index_regulations")
    parser.add_argument("--org", default=None)
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("index")
    search = commands.add_parser("search")
    search.add_argument("query")
    search.add_argument("--mode", choices=["hybrid", "text", "vector"], default="hybrid")
    search.add_argument("--k", type=int, default=10)
    raise SystemExit(asyncio.run(_main(parser.parse_args())))
