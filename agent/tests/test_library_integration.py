"""The regulation import against a real local stack: the import tables, record_regulation_version,
the `regulations` bucket and the paragraphs with their full-text search, through the API gateway
with the agent's secret key. Downloads still go to httpx.MockTransport; what is real here is
everything on the Supabase side.

Each test uses its own made-up regulation code and removes what it created.
"""

import hashlib
import os
from collections.abc import AsyncIterator
from pathlib import Path
from typing import Any, cast
from uuid import UUID, uuid4

import httpx
import pytest
from pydantic_ai.messages import ModelResponse, TextPart
from pydantic_ai.models.function import FunctionModel
from supabase import AsyncClient, acreate_client

from agent_service import metering, providers
from agent_service.domain import figures, regulations
from agent_service.domain.library_store import SupabaseLibraryStore
from agent_service.domain.paragraphs import (
    EXTRACTOR,
    Extraction,
    ExtractionProblem,
    Paragraph,
    extract,
)
from agent_service.domain.regulations import BUCKET, Splitter, slug_of
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


SAMPLE = (Path(__file__).parent / "fixtures" / "regulation" / "sample.pdf").read_bytes()
FIGURES = (Path(__file__).parent / "fixtures" / "regulation" / "figures.pdf").read_bytes()


def split_fake(data: bytes, _figures: object = None) -> Extraction:
    """The made-up bytes of the tests below are not PDFs: one paragraph holding them instead."""
    text = data.decode()
    paragraph = Paragraph(0, "1", None, None, None, "1", "", "paragraph", text, 1, 1)
    return Extraction(page_count=1, version_label=None, paragraphs=[paragraph])


async def run_import(
    db: AsyncClient,
    org: UUID,
    raw: list[dict[str, Any]],
    bodies: dict[str, bytes],
    split: Splitter = split_fake,
    describe: bool = False,
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
    meter = metering.Meter(org)
    step = figures.FigureStep(store, settings, org, meter) if describe else None
    try:
        job = await regulations.prepare(store, settings, import_id)
        async with httpx.AsyncClient(transport=httpx.MockTransport(serve)) as http:
            await regulations.execute(
                store, http, settings, job, resolve=public, split=split, figures=step
            )
        await meter.flush(store)
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


async def test_an_import_splits_its_pdfs_into_searchable_paragraphs(
    db: AsyncClient, code: str, org: UUID
) -> None:
    import_id = await run_import(
        db, org, index(code, ("2.1.0", "base", SAMPLE)), {"/2.1.0.pdf": SAMPLE}, split=extract
    )

    job = rows(
        await db.table("regulation_imports")
        .select("status, error")
        .eq("id", str(import_id))
        .execute()
    )
    assert job == [{"status": "succeeded", "error": None}]
    [version] = rows(
        await db.table("regulation_versions")
        .select(
            "id, page_count, paragraph_count, extracted_with, extraction_error,"
            " regulations!inner(code)"
        )
        .eq("regulations.code", code)
        .execute()
    )
    assert (version["page_count"], version["paragraph_count"]) == (3, 25)
    assert (version["extracted_with"], version["extraction_error"]) == (EXTRACTOR, None)

    found = rows(
        await db.table("regulation_paragraphs")
        .select("label, page_start, page_end, organization_id")
        .eq("version_id", version["id"])
        .text_search("fts", "'heat' & 'kept'")
        .execute()
    )
    assert found == [
        {"label": "Annex 2 Part 1 1.1", "page_start": 2, "page_end": 2, "organization_id": str(org)}
    ]
    spanning = rows(
        await db.table("regulation_paragraphs")
        .select("page_start, page_end")
        .eq("version_id", version["id"])
        .eq("label", "5.1.2")
        .execute()
    )
    assert spanning == [{"page_start": 1, "page_end": 2}]


async def test_a_new_file_under_the_same_version_supersedes_the_old_paragraphs(
    db: AsyncClient, code: str, org: UUID
) -> None:
    first, second = b"%PDF-1.7 first", b"%PDF-1.7 second"
    await run_import(db, org, index(code, ("1.0.0", "base", first)), {"/1.0.0.pdf": first})

    def refuse(_data: bytes, _figures: object = None) -> Extraction:
        raise ExtractionProblem("Not a PDF this time.")

    import_id = await run_import(
        db, org, index(code, ("1.0.0", "base", second)), {"/1.0.0.pdf": second}, split=refuse
    )

    [version] = rows(
        await db.table("regulation_versions")
        .select("id, paragraph_count, extraction_error, regulations!inner(code)")
        .eq("regulations.code", code)
        .execute()
    )
    assert (version["paragraph_count"], version["extraction_error"]) == (
        None,
        "Not a PDF this time.",
    )
    left = rows(
        await db.table("regulation_paragraphs")
        .select("text, superseded_at")
        .eq("version_id", version["id"])
        .execute()
    )
    # Kept for the requirements written from it (SYS-34), and no longer current.
    assert [r["text"] for r in left] == ["%PDF-1.7 first"]
    assert left[0]["superseded_at"] is not None
    job = rows(
        await db.table("regulation_imports")
        .select("status, error")
        .eq("id", str(import_id))
        .execute()
    )
    assert job[0]["status"] == "succeeded"
    assert "could not be split" in job[0]["error"]


async def test_keys_are_added_in_batches_until_every_current_paragraph_has_one(
    db: AsyncClient, org: UUID, code: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    # One statement over the whole library hit the hosted database's 8 s timeout (#37): the store
    # now asks for keys in batches until a batch comes back short.
    from agent_service.domain import search_store

    monkeypatch.setattr(search_store, "_KEY_BATCH", 2)
    reg = rows(
        await db.table("regulations")
        .insert({"organization_id": str(org), "code": code, "slug": slug_of(code), "kind": "UN R"})
        .execute()
    )[0]
    version = rows(
        await db.table("regulation_versions")
        .insert(
            {
                "regulation_id": reg["id"],
                "organization_id": str(org),
                "version_label": "00",
                "file_name": "x.pdf",
                "sha256": "a" * 64,
                "size_bytes": 1,
                "pdf_path": f"{org}/{slug_of(code)}/00/x.pdf",
            }
        )
        .execute()
    )[0]
    await (
        db.table("regulation_paragraphs")
        .insert(
            [
                {
                    "version_id": version["id"],
                    "organization_id": str(org),
                    "position": i,
                    "label": f"5.{i}",
                    "kind": "paragraph",
                    "text": f"Paragraph {i}.",
                    "page_start": 1,
                    "page_end": 1,
                    "content_hash": hashlib.sha256(f"{i}".encode()).hexdigest(),
                }
                for i in range(5)
            ]
        )
        .execute()
    )
    store = await search_store.SupabaseSearchStore.connect(URL, KEY)
    try:
        assert await store.refresh_keys(org) == 5
        assert await store.refresh_keys(org) == 0
    finally:
        await store.aclose()


async def test_vectors_without_a_paragraph_are_pruned_in_batches(
    db: AsyncClient, org: UUID, monkeypatch: pytest.MonkeyPatch
) -> None:
    # After a library was cleared and imported again, nearly every vector had lost its paragraph,
    # and one delete of them all passed the hosted database's 8 s timeout (#57).
    from agent_service.domain import search_store

    monkeypatch.setattr(search_store, "_PRUNE_BATCH", 2)
    model = "test-prune@1024"
    vector = search_store.vector_literal([0.5] * 1024)
    await (
        db.table("regulation_embeddings")
        .insert(
            [
                {
                    "organization_id": str(org),
                    "model": model,
                    "input_sha256": hashlib.sha256(f"orphan {i}".encode()).hexdigest(),
                    "embedding": vector,
                }
                for i in range(5)
            ]
        )
        .execute()
    )
    store = await search_store.SupabaseSearchStore.connect(URL, KEY)
    try:
        assert await store.prune_embeddings(org, model) == 5
        assert await store.prune_embeddings(org, model) == 0
    finally:
        await store.aclose()
    left = await (
        db.table("regulation_embeddings")
        .select("input_sha256")
        .eq("organization_id", str(org))
        .eq("model", model)
        .execute()
    )
    assert rows(left) == []


async def test_an_import_describes_the_pictures_and_keeps_them_with_the_model(
    db: AsyncClient, code: str, org: UUID, monkeypatch: pytest.MonkeyPatch
) -> None:
    # The organisation's figure model from Admin (organization_models), answered by a fake.
    await (
        db.table("organization_models")
        .insert(
            {"organization_id": str(org), "process": "figures", "model": "anthropic:claude-test"}
        )
        .execute()
    )
    monkeypatch.setattr(
        providers,
        "build_model",
        lambda *_: FunctionModel(lambda _m, _i: ModelResponse(parts=[TextPart("A 0.5 m set-up.")])),
    )

    await run_import(
        db,
        org,
        index(code, ("2.1.0", "base", FIGURES)),
        {"/2.1.0.pdf": FIGURES},
        split=extract,
        describe=True,
    )

    [version] = rows(
        await db.table("regulation_versions")
        .select("id, figures_missing, regulations!inner(code)")
        .eq("regulations.code", code)
        .execute()
    )
    assert version["figures_missing"] == 0
    placed = rows(
        await db.table("regulation_figures")
        .select("page, position, image_sha256")
        .eq("version_id", version["id"])
        .order("page")
        .order("position")
        .execute()
    )
    assert [(f["page"], f["position"]) for f in placed] == [(1, 0), (2, 0), (2, 1)]
    described = rows(
        await db.table("regulation_figure_descriptions")
        .select("image_sha256, description, model")
        .eq("organization_id", str(org))
        .execute()
    )
    assert {d["image_sha256"] for d in described} == {f["image_sha256"] for f in placed}
    assert {(d["description"], d["model"]) for d in described} == {
        ("A 0.5 m set-up.", "anthropic:claude-test")
    }
    [paragraph] = rows(
        await db.table("regulation_paragraphs")
        .select("text")
        .eq("version_id", version["id"])
        .eq("label", "7.1")
        .is_("superseded_at", "null")
        .execute()
    )
    assert paragraph["text"].endswith("[Figure: A 0.5 m set-up.]")
    usage = rows(
        await db.table("model_usage")
        .select("process, requests")
        .eq("organization_id", str(org))
        .execute()
    )
    assert usage == [{"process": "figures", "requests": 2}]
