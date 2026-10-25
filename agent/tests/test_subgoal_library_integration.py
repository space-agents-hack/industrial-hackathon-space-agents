"""The sub-goal's library reads and writes against a real local stack (domain/subgoal_library.py):
the lookup by sha256, a version recorded from a case without a role or an import, its split by
the import's own step, the stored paragraphs, and the case's link to the versions it compared.
The library is filled the way the app fills it, by an import (tests/test_library_integration.py).
"""

import hashlib
from typing import Any
from uuid import UUID

import pytest
from supabase import AsyncClient

from agent_service.domain import paragraphs, subgoal_library
from agent_service.domain.paragraphs import Extraction, Paragraph
from agent_service.domain.subgoal_library import SupabaseSubgoalLibrary
from tests import test_library_integration as library_tests
from tests.test_library_integration import KEY, URL, index, rows, run_import

# The library tests' fixtures: a fresh organisation and regulation code, removed afterwards.
db = library_tests.db
code = library_tests.code
org = library_tests.org

pytestmark = [
    pytest.mark.anyio,
    pytest.mark.integration,
    pytest.mark.skipif(not (URL and KEY), reason="no local Supabase stack configured"),
    pytest.mark.skipif(
        bool(URL) and "127.0.0.1" not in URL and "localhost" not in URL,
        reason="refusing to run against a non-local Supabase project",
    ),
]


def split_labelled(data: bytes, _figures: object = None) -> Extraction:
    """The made-up bytes are not PDFs: one paragraph holding them, and the version they name, as a
    footer would print it."""
    text = data.decode()
    paragraph = Paragraph(0, "1", None, None, None, "1", "", "paragraph", text, 1, 1)
    return Extraction(page_count=1, version_label=text.split()[-1], paragraphs=[paragraph])


async def test_a_pdf_the_library_lacks_is_ingested_beside_base_and_latest_and_linked(
    db: AsyncClient, code: str, org: UUID, monkeypatch: pytest.MonkeyPatch
) -> None:
    base, latest, newer = b"%PDF-1.7 1.0.0", b"%PDF-1.7 1.1.0", b"%PDF-1.7 2.0.0"
    await run_import(
        db,
        org,
        index(code, ("1.0.0", "base", base), ("1.1.0", "latest", latest)),
        {"/1.0.0.pdf": base, "/1.1.0.pdf": latest},
        split=split_labelled,
    )
    monkeypatch.setattr(paragraphs, "extract", split_labelled)
    project = rows(
        await db.table("projects").insert({"organization_id": str(org), "name": "p"}).execute()
    )[0]["id"]
    case_id = UUID(
        rows(
            await db.table("cases")
            .insert(
                {"project_id": project, "organization_id": str(org), "name": "s", "kind": "subgoal"}
            )
            .execute()
        )[0]["id"]
    )

    library = SupabaseSubgoalLibrary(db)
    found = await library.version_by_sha256(org, hashlib.sha256(latest).hexdigest())
    assert found is not None
    assert (found.regulation_code, found.version_label, found.role) == (code, "1.1.0", "latest")
    assert found.split

    old = await subgoal_library.read_version(
        library, None, org, latest, "old.pdf", code, float("inf")
    )
    new = await subgoal_library.read_version(
        library, None, org, newer, "new.pdf", code, float("inf")
    )

    assert (old.source, new.source) == ("library", "library, ingested now")
    assert [p.text for p in new.paragraphs] == [newer.decode()]
    versions: list[dict[str, Any]] = rows(
        await db.table("regulation_versions")
        .select("version_label, role, last_import_id, extracted_with, regulations!inner(code)")
        .eq("regulations.code", code)
        .order("version_label")
        .execute()
    )
    # The roles the main goal cites by did not move.
    assert [(v["version_label"], v["role"]) for v in versions] == [
        ("1.0.0", "base"),
        ("1.1.0", "latest"),
        ("2.0.0", None),
    ]
    assert versions[2]["last_import_id"] is None
    assert versions[2]["extracted_with"] == paragraphs.EXTRACTOR

    await library.link_case(case_id, old.version_id, new.version_id)
    [linked] = rows(
        await db.table("cases")
        .select("old_version_id, new_version_id")
        .eq("id", str(case_id))
        .execute()
    )
    assert (linked["old_version_id"], linked["new_version_id"]) == (
        str(old.version_id),
        str(new.version_id),
    )
    assert len(await library.regulation_versions(org, code)) == 3
