"""The regulation import against a real local stack: the import tables, record_regulation_version
and the `regulations` bucket, through the API gateway with the agent's secret key. Downloads still
go to httpx.MockTransport; what is real here is everything on the Supabase side.

Each test uses its own made-up regulation code and removes what it created.
"""

import hashlib
import os
from collections.abc import AsyncIterator
from typing import Any, cast
from uuid import UUID, uuid4

import httpx
import pytest
from supabase import AsyncClient, acreate_client

from agent_service.domain import regulations
from agent_service.domain.library_store import SupabaseLibraryStore
from agent_service.domain.regulations import BUCKET, slug_of
from agent_service.settings import Settings

URL = os.environ.get("SUPABASE_URL", "")
KEY = os.environ.get("SUPABASE_SECRET_KEY", "")

pytestmark = [
    pytest.mark.anyio,
    pytest.mark.integration,
    pytest.mark.skipif(not (URL and KEY), reason="no local Supabase stack configured"),
    pytest.mark.skipif(
        bool(URL) and "127.0.0.1" not in URL and "localhost" not in URL,
        reason="refusing to run against a non-local Supabase project",
    ),
]


def rows(response: Any) -> list[dict[str, Any]]:
    return cast(list[dict[str, Any]], response.data)


@pytest.fixture
async def db() -> AsyncIterator[AsyncClient]:
    client = await acreate_client(URL, KEY)
    yield client
    await client.postgrest.aclose()


@pytest.fixture
def code() -> str:
    return f"TEST R{uuid4().hex[:8]}"


@pytest.fixture
async def org(db: AsyncClient, code: str) -> AsyncIterator[UUID]:
    """A fresh organisation; deleting it at the end removes its library and imports (cascade)."""
    res = await db.table("organizations").insert({"name": f"library test {code}"}).execute()
    org_id = UUID(rows(res)[0]["id"])
    yield org_id
    prefix = f"{org_id}/{slug_of(code)}"
    for folder in await db.storage.from_(BUCKET).list(prefix):
        files = await db.storage.from_(BUCKET).list(f"{prefix}/{folder['name']}")
        await db.storage.from_(BUCKET).remove(
            [f"{prefix}/{folder['name']}/{f['name']}" for f in files]
        )
    await db.table("organizations").delete().eq("id", str(org_id)).execute()


def index(code: str, *versions: tuple[str, str, bytes]) -> list[dict[str, Any]]:
    return [
        {
            "regulation": code,
            "title": "Integration test regulation",
            "versions": [
                {
                    "version_label": label,
                    "role": role,
                    "files": [
                        {
                            "name": f"{role}.pdf",
                            "pdf_url": f"https://files.example.org/{label}.pdf",
                            "sha256": hashlib.sha256(data).hexdigest(),
                        }
                    ],
                }
                for label, role, data in versions
            ],
        }
    ]


async def run_import(
    db: AsyncClient, org: UUID, raw: list[dict[str, Any]], bodies: dict[str, bytes]
) -> UUID:
    res = (
        await db.table("regulation_imports")
        .insert({"organization_id": str(org), "source_name": "t.json", "index": raw})
        .execute()
    )
    import_id = UUID(rows(res)[0]["id"])

    def serve(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, content=bodies[request.url.path])

    async def public(_host: str, _port: int) -> list[str]:
        return ["93.184.216.34"]

    store = await SupabaseLibraryStore.connect(URL, KEY)
    settings = Settings(_env_file=None)  # pyright: ignore[reportCallIssue]
    try:
        job = await regulations.prepare(store, settings, import_id)
        async with httpx.AsyncClient(transport=httpx.MockTransport(serve)) as http:
            await regulations.execute(store, http, settings, job, resolve=public)
    finally:
        await store.aclose()
    return import_id


async def test_an_import_fills_the_bucket_and_the_catalogue(
    db: AsyncClient, code: str, org: UUID
) -> None:
    base, latest = b"%PDF-1.7 base", b"%PDF-1.7 latest"
    raw = index(code, ("1.0.0", "base", base), ("1.1.0", "latest", latest))

    import_id = await run_import(db, org, raw, {"/1.0.0.pdf": base, "/1.1.0.pdf": latest})

    job = rows(
        await db.table("regulation_imports")
        .select("status, error")
        .eq("id", str(import_id))
        .execute()
    )
    assert job == [{"status": "succeeded", "error": None}]
    versions = rows(
        await db.table("regulation_versions")
        .select("version_label, role, size_bytes, pdf_path, regulations!inner(code, kind)")
        .eq("regulations.code", code)
        .order("version_label")
        .execute()
    )
    assert [(v["version_label"], v["role"], v["size_bytes"]) for v in versions] == [
        ("1.0.0", "base", len(base)),
        ("1.1.0", "latest", len(latest)),
    ]
    assert versions[0]["regulations"]["kind"] == "other"
    stored = await db.storage.from_(BUCKET).download(versions[1]["pdf_path"])
    assert stored == latest


async def test_a_second_import_moves_the_role_and_skips_unchanged_files(
    db: AsyncClient, code: str, org: UUID
) -> None:
    base, latest, newer = b"%PDF-1.7 base", b"%PDF-1.7 latest", b"%PDF-1.7 newer"
    await run_import(
        db,
        org,
        index(code, ("1.0.0", "base", base), ("1.1.0", "latest", latest)),
        {"/1.0.0.pdf": base, "/1.1.0.pdf": latest},
    )

    second = await run_import(
        db,
        org,
        index(code, ("1.0.0", "base", base), ("1.2.0", "latest", newer)),
        {"/1.2.0.pdf": newer},
    )

    files = rows(
        await db.table("regulation_import_files")
        .select("version_label, status")
        .eq("import_id", str(second))
        .order("position")
        .execute()
    )
    assert files == [
        {"version_label": "1.0.0", "status": "unchanged"},
        {"version_label": "1.2.0", "status": "stored"},
    ]
    roles = rows(
        await db.table("regulation_versions")
        .select("version_label, role, regulations!inner(code)")
        .eq("regulations.code", code)
        .order("version_label")
        .execute()
    )
    assert [(r["version_label"], r["role"]) for r in roles] == [
        ("1.0.0", "base"),
        ("1.1.0", None),
        ("1.2.0", "latest"),
    ]
