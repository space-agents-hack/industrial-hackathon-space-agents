"""The sub-goal's reads against a real local stack: a version row with its regulation's code, and
the PDF from the `regulations` bucket, with the agent's secret key (domain/changes.py). The
library is filled the way the app fills it, by an import (tests/test_library_integration.py)."""

from collections.abc import AsyncIterator
from typing import Any, cast
from uuid import UUID, uuid4

import pytest
from supabase import AsyncClient, acreate_client

from agent_service.domain.changes import SupabaseVersionStore
from agent_service.domain.regulations import BUCKET
from tests.test_library_integration import KEY, URL, index, run_import

pytestmark = [
    pytest.mark.anyio,
    pytest.mark.integration,
    pytest.mark.skipif(not (URL and KEY), reason="no local Supabase stack configured"),
    pytest.mark.skipif(
        bool(URL) and "127.0.0.1" not in URL and "localhost" not in URL,
        reason="refusing to run against a non-local Supabase project",
    ),
]


@pytest.fixture
async def db() -> AsyncIterator[AsyncClient]:
    client = await acreate_client(URL, KEY)
    yield client
    await client.postgrest.aclose()


@pytest.fixture
async def org(db: AsyncClient) -> AsyncIterator[UUID]:
    res = (
        await db.table("organizations")
        .insert({"name": f"changes test {uuid4().hex[:8]}"})
        .execute()
    )
    org_id = UUID(cast(list[dict[str, Any]], res.data)[0]["id"])
    yield org_id
    paths = cast(
        list[dict[str, Any]],
        (
            await db.table("regulation_versions")
            .select("pdf_path")
            .eq("organization_id", str(org_id))
            .execute()
        ).data,
    )
    if paths:
        await db.storage.from_(BUCKET).remove([p["pdf_path"] for p in paths])
    await db.table("organizations").delete().eq("id", str(org_id)).execute()


async def test_a_stored_version_reads_with_its_code_and_its_file(
    db: AsyncClient, org: UUID
) -> None:
    code = f"TEST R{uuid4().hex[:8]}"
    base, latest = b"%PDF-1.7 base", b"%PDF-1.7 latest"
    await run_import(
        db,
        org,
        index(code, ("1.0.0", "base", base), ("1.1.0", "latest", latest)),
        {"/1.0.0.pdf": base, "/1.1.0.pdf": latest},
    )
    res = await (
        db.table("regulation_versions")
        .select("id, regulations!inner(code)")
        .eq("regulations.code", code)
        .eq("version_label", "1.1.0")
        .execute()
    )
    version_id = UUID(cast(list[dict[str, Any]], res.data)[0]["id"])

    store = await SupabaseVersionStore.connect(URL, KEY)
    try:
        version = await store.version(version_id)
        assert version is not None
        assert (version.organization_id, version.regulation, version.version_label) == (
            org,
            code,
            "1.1.0",
        )
        assert await store.download(version.pdf_path) == latest
        assert await store.version(uuid4()) is None
    finally:
        await store.aclose()
