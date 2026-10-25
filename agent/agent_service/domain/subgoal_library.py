"""The two versions of a sub-goal case, read from the organisation's regulation library (#42,
SYS-45, SYS-16, SYS-24).

Clemente, 2026-10-25: the sub-goal's PDFs are "processed and properly done in the DB", through
"the full data ingestion pipeline". So each of the case's two PDFs is:
1. found in the library by its sha256: an exact file match, not a guess by name. Certivity's
   index lists base and latest for every regulation, so after the library import the sub-goal's
   pair is usually there already (the dev pair is UN R175 base and latest, same files).
2. split by the current extractor, figures included, if it was not yet (an older `EXTRACTOR`, or
   pictures without a description). That is the import's own step, `regulations.split_one`.
3. if the library does not have the file: stored in the `regulations` bucket, recorded as a new
   version with no role, and split the same way.
The diff then reads the stored paragraphs. A fix to the library's extraction (tables, figures)
reaches the sub-goal with no code of its own, and there is one extraction for both goals.

Read in memory, as before, only when the library cannot be used, and the trace says why: no
library store, a file the guards below refuse to record, a label the PDF does not print, a split
that failed, or a database that did not answer. A sub-goal run never fails for the library.

The guards. Recording a version is not free for the rest of the library:
  - never a role. `record_regulation_version` with a role takes it from the regulation's other
    version, and the main goal cites `base` (writer.citable_version): a held-out "old" PDF
    recorded as base would change what every main-goal requirement of that regulation cites.
  - never over another file. The function upserts on (regulation, version label): a label the
    library has with a different sha256 would replace the library's file and its paragraphs.
  - never next to a lone version without a role. citable_version cites the only version of a
    regulation when none is base; a second version would make it refuse that regulation.

Figure lines are model-written ("[Figure: ...]", paragraphs.FIGURE_PREFIX). The same picture
gets the same words (descriptions are cached by the image's hash), but a picture re-encoded in
the new PDF is described again, possibly in other words, and nothing has measured how often that
happens between two versions. Detection was measured without figures (7/7 flagged, 0 extra on
the dev pair), so `for_diff` leaves them out and the writer step reads them (`with_figures`).

What this does NOT do: wait for embeddings or the scope summary (the library's indexing does them
later; the diff needs neither), or remove a version it recorded.
"""

import asyncio
import hashlib
import logging
import re
from dataclasses import dataclass, field, replace
from typing import Any, Protocol, cast
from uuid import UUID

from agent_service.domain import paragraphs, regulations
from agent_service.domain.library_store import SupabaseLibraryStore
from agent_service.domain.regulations import DescribeFigures, SplitStore, VersionToSplit

log = logging.getLogger(__name__)

# PostgREST's page size (supabase/config.toml `max_rows`, and the hosted default).
_PAGE = 1000


@dataclass(frozen=True)
class LibraryVersion:
    id: UUID
    regulation_code: str
    version_label: str
    role: str | None
    sha256: str
    pdf_path: str
    extracted_with: str | None = None
    extraction_error: str | None = None
    figures_missing: int = 0

    def to_split(self) -> VersionToSplit:
        return VersionToSplit(
            self.id,
            self.regulation_code,
            self.version_label,
            self.sha256,
            self.pdf_path,
            self.extracted_with,
            self.figures_missing,
        )

    @property
    def split(self) -> bool:
        """Split by the current extractor, and the split worked."""
        return self.extracted_with == paragraphs.EXTRACTOR and self.extraction_error is None


@dataclass(frozen=True)
class StoredParagraph:
    label: str
    text: str
    page_start: int


class SubgoalLibrary(SplitStore, Protocol):
    async def version_by_sha256(self, org: UUID, sha256: str) -> LibraryVersion | None:
        """The organisation's version whose file has this sha256, the oldest if several."""
        ...

    async def regulation_versions(self, org: UUID, code: str) -> list[LibraryVersion]: ...

    async def stored_paragraphs(self, version_id: UUID) -> list[StoredParagraph]:
        """Current numbered paragraphs, in document order."""
        ...

    async def upload_pdf(self, path: str, data: bytes) -> None: ...

    async def record_case_version(
        self, org: UUID, code: str, version_label: str, sha256: str, size: int, file_name: str
    ) -> None:
        """A new version with no role, no import and no title."""
        ...

    async def link_case(self, case_id: UUID, old: UUID | None, new: UUID | None) -> None: ...


@dataclass
class Read:
    """One version as the diff reads it."""

    paragraphs: list[StoredParagraph]
    # Where it came from, for the trace: "library", "library, split now", "library, ingested
    # now", or "in memory: <why>".
    source: str
    # The library's names when it came from there (what the index calls them); else the version
    # the PDF's footers print.
    regulation: str | None
    version_label: str | None
    version_id: UUID | None = None
    pages: int | None = None
    warnings: list[str] = field(default_factory=list)

    def described(self) -> dict[str, Any]:
        return {
            "source": self.source,
            "version": self.version_label,
            "pages": self.pages,
            "paragraphs": len(self.paragraphs),
            "figure_lines": sum(_figure_lines(p.text) for p in self.paragraphs),
        }


def for_diff(read: Read) -> list[StoredParagraph]:
    """The paragraphs without model-written figure lines (module docstring)."""
    out: list[StoredParagraph] = []
    for p in read.paragraphs:
        kept = "\n".join(
            line
            for line in p.text.split("\n")
            if not line.lstrip().startswith(paragraphs.FIGURE_PREFIX)
        )
        out.append(replace(p, text=kept))
    return out


def with_figures(read: Read) -> list[StoredParagraph]:
    return list(read.paragraphs)


def _figure_lines(text: str) -> int:
    return sum(1 for line in text.split("\n") if line.lstrip().startswith(paragraphs.FIGURE_PREFIX))


async def read_version(
    library: SubgoalLibrary | None,
    figures: DescribeFigures | None,
    org: UUID,
    pdf: bytes,
    file_name: str,
    regulation: str | None,
    deadline: float,
) -> Read:
    """One of the case's PDFs as stored paragraphs, ingesting it if the library lacks it.
    `regulation` is the code to record it under when it is new (the code the other version has
    in the library, else the one the requirements cite). Raises paragraphs.ExtractionProblem only
    when the PDF cannot be read even in memory."""
    if library is None:
        return await _in_memory(pdf, "no regulation library store")
    sha = hashlib.sha256(pdf).hexdigest()
    try:
        found = await library.version_by_sha256(org, sha)
        how = "library"
        if found is None:
            found, why = await _ingest(library, org, pdf, sha, file_name, regulation)
            if found is None:
                return await _in_memory(pdf, why)
            how = "library, ingested now"
        if not found.split or found.figures_missing > 0:
            # The import's own step, with its figures: descriptions cached by picture are reused,
            # missing ones are asked for until `deadline`, and the paragraphs are replaced.
            await regulations.split_one(
                library, found.to_split(), paragraphs.extract, figures, deadline
            )
            found = await library.version_by_sha256(org, sha)
            if how == "library":
                how = "library, split now"
        if found is None or not found.split:
            error = found.extraction_error if found is not None else None
            return await _in_memory(
                pdf, f"the library could not split it ({error or 'no paragraphs stored'})"
            )
        stored = await library.stored_paragraphs(found.id)
        if not stored:
            return await _in_memory(pdf, "the library has no numbered paragraphs for it")
    except paragraphs.ExtractionProblem:
        raise
    except Exception as exc:
        log.exception("Sub-goal: reading %s from the library failed", file_name)
        return await _in_memory(pdf, f"the library could not be read ({type(exc).__name__})")
    warnings = (
        [f"{found.figures_missing} picture(s) without a description yet"]
        if found.figures_missing
        else []
    )
    return Read(
        stored,
        how,
        found.regulation_code,
        found.version_label,
        found.id,
        warnings=warnings,
    )


async def _ingest(
    library: SubgoalLibrary,
    org: UUID,
    pdf: bytes,
    sha: str,
    file_name: str,
    regulation: str | None,
) -> tuple[LibraryVersion | None, str]:
    """Store and record a PDF the library does not have, or say why not (module docstring)."""
    if not regulation:
        return None, "not in the library, and the requirements cite no regulation to file it under"
    label = await _printed_label(pdf)
    if label is None or not re.fullmatch(
        regulations._VERSION_LABEL,  # pyright: ignore[reportPrivateUsage]
        label,
    ):
        return None, "not in the library, and the PDF does not print a version label"
    versions = await library.regulation_versions(org, regulation)
    if any(v.version_label == label for v in versions):
        return None, (
            f"the library has {regulation} {label} as another file; it is not replaced from a case"
        )
    if len(versions) == 1 and versions[0].role != "base":
        return None, (
            f"{regulation} has one version and no base in the library; a second would stop the "
            "main goal citing it"
        )
    await library.upload_pdf(regulations.storage_path(org, regulation, label), pdf)
    await library.record_case_version(org, regulation, label, sha, len(pdf), file_name)
    return await library.version_by_sha256(org, sha), ""


async def _printed_label(pdf: bytes) -> str | None:
    try:
        return (await asyncio.to_thread(paragraphs.extract, pdf)).version_label
    except paragraphs.ExtractionProblem:
        return None


async def _in_memory(pdf: bytes, why: str) -> Read:
    x = await asyncio.to_thread(paragraphs.extract, pdf)
    return Read(
        [StoredParagraph(p.label, p.text, p.page_start) for p in x.paragraphs if p.label],
        f"in memory: {why}",
        None,
        x.version_label,
        pages=x.page_count,
        warnings=list(x.warnings),
    )


# ------------------------------------------------------------------------------------------
# In Supabase
# ------------------------------------------------------------------------------------------


def _rows(response: Any) -> list[dict[str, Any]]:
    return cast(list[dict[str, Any]], response.data)


def _version(r: dict[str, Any]) -> LibraryVersion:
    return LibraryVersion(
        id=UUID(r["id"]),
        regulation_code=r["regulations"]["code"],
        version_label=r["version_label"],
        role=r["role"],
        sha256=r["sha256"],
        pdf_path=r["pdf_path"],
        extracted_with=r["extracted_with"],
        extraction_error=r["extraction_error"],
        figures_missing=r["figures_missing"] or 0,
    )


_VERSION_COLUMNS = (
    "id, version_label, role, sha256, pdf_path, extracted_with, extraction_error, "
    "figures_missing, regulations!inner(code)"
)


class SupabaseSubgoalLibrary(SupabaseLibraryStore):
    """The library store the import uses, plus what a sub-goal run reads and writes. With the
    secret key: the run's case and organisation were checked by the runner. It shares the run
    store's connection (RunStore.subgoal_library), so the run store closes it."""

    async def version_by_sha256(self, org: UUID, sha256: str) -> LibraryVersion | None:
        res = (
            await self._db.table("regulation_versions")
            .select(_VERSION_COLUMNS)
            .eq("organization_id", str(org))
            .eq("sha256", sha256)
            .order("created_at")
            .limit(1)
            .execute()
        )
        rows = _rows(res)
        return _version(rows[0]) if rows else None

    async def regulation_versions(self, org: UUID, code: str) -> list[LibraryVersion]:
        res = (
            await self._db.table("regulation_versions")
            .select(_VERSION_COLUMNS)
            .eq("organization_id", str(org))
            .eq("regulations.code", code)
            .execute()
        )
        return [_version(r) for r in _rows(res)]

    async def stored_paragraphs(self, version_id: UUID) -> list[StoredParagraph]:
        out: list[StoredParagraph] = []
        start = 0
        while True:
            res = (
                await self._db.table("regulation_paragraphs")
                .select("label, text, page_start")
                .eq("version_id", str(version_id))
                .is_("superseded_at", "null")
                .not_.is_("label", "null")
                .order("position")
                .range(start, start + _PAGE - 1)
                .execute()
            )
            page = _rows(res)
            out += [StoredParagraph(r["label"], r["text"], r["page_start"]) for r in page]
            if len(page) < _PAGE:
                return out
            start += _PAGE

    async def record_case_version(
        self, org: UUID, code: str, version_label: str, sha256: str, size: int, file_name: str
    ) -> None:
        # Null title, source and status: the function keeps the regulation's own (coalesce) and
        # the version shows as added from a case, not from an index.
        await self._db.rpc(
            "record_regulation_version",
            {
                "p_organization_id": str(org),
                "p_import_id": None,
                "p_code": code,
                "p_slug": regulations.slug_of(code),
                "p_kind": regulations.kind_of(code),
                "p_title": None,
                "p_source_url": None,
                "p_version_label": version_label,
                "p_role": None,
                "p_status": None,
                "p_version_title": None,
                "p_file_name": file_name[:255] or "version.pdf",
                "p_sha256": sha256,
                "p_size_bytes": size,
                "p_pdf_path": regulations.storage_path(org, code, version_label),
            },
        ).execute()

    async def link_case(self, case_id: UUID, old: UUID | None, new: UUID | None) -> None:
        await (
            self._db.table("cases")
            .update({"old_version_id": _str(old), "new_version_id": _str(new)})
            .eq("id", str(case_id))
            .execute()
        )


def _str(value: UUID | None) -> str | None:
    return None if value is None else str(value)
