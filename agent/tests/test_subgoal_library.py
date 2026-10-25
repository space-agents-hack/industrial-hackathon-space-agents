"""A sub-goal run reads both versions from the organisation's regulation library (#42, SYS-45,
SYS-16, SYS-24): found by sha256, split by the library's own step when it is stale, ingested when
it is missing, and read in memory only when the guards or the library say no. Every regulation,
requirement and PDF here is made up; `paragraphs.extract` is replaced so a "PDF" is a key to its
paragraphs."""

import hashlib
import json
from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Any, cast
from uuid import UUID

import pytest

from agent_service.domain import paragraphs, subgoal, subgoal_library
from agent_service.domain.figures import Outcome
from agent_service.domain.regulations import storage_path
from agent_service.domain.subgoal_library import LibraryVersion, StoredParagraph
from agent_service.settings import Settings
from tests.fakes import ORG, InMemoryRunStore
from tests.library_fakes import InMemoryLibraryStore, StoredVersion
from tests.test_subgoal import (
    NEW,
    VERSIONS,
    advance,
    requirements_file,
    rules_file,
    subgoal_case,
    tools,
)

pytestmark = pytest.mark.anyio

FIGURE = "[Figure: A test set-up: the lamp 3 m from the screen.]"


@dataclass(frozen=True)
class Split:
    paragraphs: list[Any]
    version_label: str | None
    page_count: int = 3
    warnings: list[str] = field(default_factory=list)
    figures: list[Any] = field(default_factory=list)


extracted: list[bytes] = []


@pytest.fixture(autouse=True)
def fake_pdfs(monkeypatch: pytest.MonkeyPatch) -> None:
    extracted.clear()

    def extract(pdf: bytes, descriptions: Mapping[str, str] | None = None) -> Any:
        extracted.append(pdf)
        return Split(VERSIONS[pdf].paragraphs, VERSIONS[pdf].version_label)

    monkeypatch.setattr(paragraphs, "extract", extract)


def sha(pdf: bytes) -> str:
    return hashlib.sha256(pdf).hexdigest()


@dataclass
class FakeSubgoalLibrary(InMemoryLibraryStore):
    links: dict[UUID, tuple[UUID | None, UUID | None]] = field(default_factory=dict)
    broken: bool = False

    def add(
        self,
        pdf: bytes,
        label: str,
        role: str | None,
        *,
        code: str = "UN R999",
        extracted_with: str | None = paragraphs.EXTRACTOR,
        text: list[Any] | None = None,
    ) -> StoredVersion:
        path = storage_path(ORG, code, label)
        version = StoredVersion(ORG, code, label, role, sha(pdf), len(pdf), path, None)
        version.extracted_with = extracted_with
        if extracted_with is not None:
            version.paragraphs = cast(Any, text if text is not None else VERSIONS[pdf].paragraphs)
        self.versions.append(version)
        self.objects[path] = pdf
        return version

    async def version_by_sha256(self, org: UUID, sha256: str) -> LibraryVersion | None:
        if self.broken:
            raise ConnectionError("the database did not answer")
        for v in self.versions:
            if v.organization_id == org and v.sha256 == sha256:
                return self._lib(v)
        return None

    async def regulation_versions(self, org: UUID, code: str) -> list[LibraryVersion]:
        return [self._lib(v) for v in self.versions if v.organization_id == org and v.code == code]

    async def stored_paragraphs(self, version_id: UUID) -> list[StoredParagraph]:
        v = next(v for v in self.versions if v.id == version_id)
        return [StoredParagraph(p.label, p.text, p.page_start) for p in v.paragraphs if p.label]

    async def record_case_version(
        self, org: UUID, code: str, version_label: str, sha256: str, size: int, file_name: str
    ) -> None:
        path = storage_path(org, code, version_label)
        self.versions.append(
            StoredVersion(org, code, version_label, None, sha256, size, path, None)
        )

    async def link_case(self, case_id: UUID, old: UUID | None, new: UUID | None) -> None:
        self.links[case_id] = (old, new)

    @staticmethod
    def _lib(v: StoredVersion) -> LibraryVersion:
        return LibraryVersion(
            v.id,
            v.code,
            v.version_label,
            v.role,
            v.sha256,
            v.path,
            v.extracted_with,
            v.extraction_error,
            v.figures_missing,
        )


async def read(
    library: FakeSubgoalLibrary | None, pdf: bytes, figures: Any = None
) -> subgoal_library.Read:
    return await subgoal_library.read_version(
        library, figures, ORG, pdf, "new.pdf", "UN R999", deadline=float("inf")
    )


# ------------------------------------------------------------------------------------------
# One version
# ------------------------------------------------------------------------------------------


async def test_a_version_the_library_has_split_is_read_from_it_without_reading_the_pdf() -> None:
    library = FakeSubgoalLibrary()
    stored = library.add(b"new-pdf", "2.0.0", "latest", code="UN R999")

    got = await read(library, b"new-pdf")

    assert got.source == "library"
    assert (got.regulation, got.version_label, got.version_id) == ("UN R999", "2.0.0", stored.id)
    assert [p.label for p in got.paragraphs] == ["5", "5.1"]
    assert extracted == []


async def test_a_version_split_by_an_older_extractor_is_split_again_by_the_librarys_step() -> None:
    library = FakeSubgoalLibrary()
    stored = library.add(b"new-pdf", "2.0.0", "latest", extracted_with="paragraphs-1")

    got = await read(library, b"new-pdf")

    assert got.source == "library, split now"
    assert stored.extracted_with == paragraphs.EXTRACTOR
    assert [p.label for p in got.paragraphs] == ["5", "5.1"]


async def test_the_split_passes_the_figure_descriptions_and_the_diff_leaves_them_out() -> None:
    library = FakeSubgoalLibrary()
    library.add(b"new-pdf", "2.0.0", "latest", extracted_with=None)
    seen: list[Mapping[str, str]] = []

    class Figures:
        unusable: str | None = None
        described = 0

        async def __call__(self, label: str, pdf: bytes, deadline: float) -> Outcome:
            return Outcome(descriptions={"abc": "A test set-up."})

    def split(pdf: bytes, descriptions: Mapping[str, str] | None = None) -> Any:
        seen.append(descriptions or {})
        p = NEW[1]
        return Split([NEW[0], type(p)(p.label, f"{p.text}\n{FIGURE}", p.page_start)], "2.0.0")

    with pytest.MonkeyPatch.context() as m:
        m.setattr(paragraphs, "extract", split)
        got = await read(library, b"new-pdf", Figures())

    assert seen == [{"abc": "A test set-up."}]
    assert FIGURE in subgoal_library.with_figures(got)[1].text
    assert FIGURE not in subgoal_library.for_diff(got)[1].text
    assert subgoal_library.for_diff(got)[1].text == NEW[1].text
    assert got.described()["figure_lines"] == 1


async def test_a_pdf_the_library_lacks_is_stored_recorded_without_a_role_and_split() -> None:
    library = FakeSubgoalLibrary()
    base = library.add(b"old-pdf", "1.0.0", "base")

    got = await read(library, b"new-pdf")

    assert got.source == "library, ingested now"
    new = library.version("UN R999", "2.0.0")
    assert (new.role, new.sha256, new.extracted_with) == (None, sha(b"new-pdf"), "paragraphs-3")
    assert library.objects[storage_path(ORG, "UN R999", "2.0.0")] == b"new-pdf"
    # The main goal still cites the same version.
    assert base.role == "base"
    assert got.version_id == new.id


@pytest.mark.parametrize(
    ("setup", "why"),
    [
        # The library has 2.0.0 as another file: recording would replace it.
        (lambda lib: lib.add(b"other-pdf", "2.0.0", "latest", text=[]), "as another file"),
        # One version without a role: a second would stop the main goal citing it.
        (lambda lib: lib.add(b"old-pdf", "1.0.0", None), "one version and no base"),
    ],
)
async def test_a_pdf_the_guards_refuse_is_read_in_memory_and_nothing_is_recorded(
    setup: Any, why: str
) -> None:
    library = FakeSubgoalLibrary()
    setup(library)
    before = [(v.version_label, v.sha256, v.role) for v in library.versions]

    got = await read(library, b"new-pdf")

    assert got.source.startswith("in memory: ") and why in got.source
    assert [(v.version_label, v.sha256, v.role) for v in library.versions] == before
    assert [p.label for p in got.paragraphs] == ["5", "5.1"]


async def test_a_library_that_does_not_answer_leaves_the_run_in_memory() -> None:
    library = FakeSubgoalLibrary(broken=True)

    got = await read(library, b"new-pdf")

    assert got.source == "in memory: the library could not be read (ConnectionError)"
    assert got.version_label == "2.0.0"


# ------------------------------------------------------------------------------------------
# The run
# ------------------------------------------------------------------------------------------


async def test_a_run_reads_both_versions_from_the_library_and_links_them_to_the_case(
    store: InMemoryRunStore, settings: Settings
) -> None:
    library = FakeSubgoalLibrary()
    old = library.add(b"old-pdf", "1.0.0", "base")
    # The new version carries a figure line: the diff leaves it out, so the file is the same.
    figure_new = [NEW[0], type(NEW[1])(NEW[1].label, f"{NEW[1].text}\n{FIGURE}", 3)]
    new = library.add(b"new-pdf", "2.0.0", "latest", text=figure_new)
    store.subgoal = library
    case_id = subgoal_case(
        store, requirements_file(), ("old.pdf", "pdf", b"old-pdf"), ("new.pdf", "pdf", b"new-pdf")
    )
    run_id = store.add_run("Find the changes.", case_id=case_id)

    assert await advance(store, settings, run_id) == "succeeded"

    assert json.loads(store.outputs[run_id] or "null") == rules_file()
    assert "extract_versions" in tools(store, run_id)
    [result] = [
        p for p in store.payloads(run_id, "tool_result") if p["tool_name"] == "extract_versions"
    ]
    trace = json.loads(result["result"])
    assert (trace["old"]["source"], trace["new"]["source"]) == ("library", "library")
    assert trace["new"]["figure_lines"] == 1
    assert library.links[case_id] == (old.id, new.id)


async def test_uploading_the_folder_puts_both_versions_in_the_library_once(
    store: InMemoryRunStore, settings: Settings
) -> None:
    library = FakeSubgoalLibrary()
    old = library.add(b"old-pdf", "1.0.0", "base")
    store.subgoal = library
    case_id = subgoal_case(
        store, requirements_file(), ("old.pdf", "pdf", b"old-pdf"), ("new.pdf", "pdf", b"new-pdf")
    )

    await subgoal.ingest_case(store, case_id)

    new = library.version("UN R999", "2.0.0")
    assert new.role is None and new.extracted_with == paragraphs.EXTRACTOR
    assert library.links[case_id] == (old.id, new.id)
    notes = {f.filename: " ".join(f.notes) for f in store.cases[case_id]}
    assert "In the regulation library as UN R999 1.0.0 (already there)" in notes["old.pdf"]
    assert "UN R999 2.0.0 (added from this case, with no role)" in notes["new.pdf"]

    # Uploaded again, or run: the same files are found, nothing is added a second time.
    await subgoal.ingest_case(store, case_id)
    run_id = store.add_run("Find the changes.", case_id=case_id)
    assert await advance(store, settings, run_id) == "succeeded"
    assert len(library.versions) == 2
    [result] = [
        p for p in store.payloads(run_id, "tool_result") if p["tool_name"] == "extract_versions"
    ]
    trace = json.loads(result["result"])
    assert (trace["old"]["source"], trace["new"]["source"]) == ("library", "library")
