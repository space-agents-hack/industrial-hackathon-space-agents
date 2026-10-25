"""An in-memory LibraryStore with the same rules as the Supabase one: the conditional claim, the
heartbeat that fails once the import is cancelled, a role that moves to the newest version, and
paragraphs that go when a version's file changes. tests/test_library_integration.py checks the
real one against a local stack."""

from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import UUID, uuid4

from agent_service.domain.figures import Described
from agent_service.domain.paragraphs import Extraction, Paragraph
from agent_service.domain.pdf_figures import Figure
from agent_service.domain.regulations import (
    FileStatus,
    ImportRow,
    ImportStatus,
    PlannedFile,
    VersionToSplit,
)
from agent_service.providers import Endpoint

ORG = UUID("00000000-0000-4000-8000-000000000001")
OTHER_ORG = UUID("00000000-0000-4000-8000-000000000002")


@dataclass
class StoredVersion:
    organization_id: UUID
    code: str
    version_label: str
    role: str | None
    sha256: str
    size_bytes: int
    path: str
    title: str | None
    id: UUID = field(default_factory=uuid4)
    extracted_with: str | None = None
    extraction_error: str | None = None
    page_count: int | None = None
    paragraphs: list[Paragraph] = field(default_factory=list)
    figures: list[Figure] = field(default_factory=list)
    figures_missing: int = 0


@dataclass
class InMemoryLibraryStore:
    imports: dict[UUID, ImportRow] = field(default_factory=dict)
    errors: dict[UUID, str | None] = field(default_factory=dict)
    files: dict[UUID, list[PlannedFile]] = field(default_factory=dict)
    file_status: dict[tuple[UUID, int], tuple[FileStatus, str | None]] = field(default_factory=dict)
    versions: list[StoredVersion] = field(default_factory=list)
    objects: dict[str, bytes] = field(default_factory=dict)
    # Set to make the next touch fail, as if someone pressed Cancel during the import.
    cancel_on_touch: bool = False
    # Paths whose download from the bucket fails, as if the storage API did not answer.
    unreachable: set[str] = field(default_factory=set)
    closed: bool = False
    # What figures.FigureStep reads and writes.
    models: dict[str, str] = field(default_factory=dict)
    descriptions: dict[tuple[UUID, str], Described] = field(default_factory=dict)
    usage: list[dict[str, Any]] = field(default_factory=list)

    # Helpers the tests use to play the web's part.

    def add_import(
        self, index: Any, status: ImportStatus = "queued", idle_s: float = 0, org: UUID = ORG
    ) -> UUID:
        import_id = uuid4()
        self.imports[import_id] = ImportRow(
            id=import_id,
            organization_id=org,
            status=status,
            index=index,
            updated_at=datetime.now(UTC) - timedelta(seconds=idle_s),
        )
        return import_id

    def statuses(self, import_id: UUID) -> list[FileStatus]:
        return [self.file_status[(import_id, f.position)][0] for f in self.files[import_id]]

    def file_errors(self, import_id: UUID) -> list[str | None]:
        return [self.file_status[(import_id, f.position)][1] for f in self.files[import_id]]

    def version(self, code: str, version_label: str, org: UUID = ORG) -> StoredVersion:
        return next(
            v
            for v in self.versions
            if v.organization_id == org and v.code == code and v.version_label == version_label
        )

    def role_of(self, code: str, version_label: str, org: UUID = ORG) -> str | None:
        return self.version(code, version_label, org).role

    # The LibraryStore interface.

    async def get_import(self, import_id: UUID) -> ImportRow | None:
        return self.imports.get(import_id)

    async def claim_import(
        self, import_id: UUID, expected: ImportStatus, *, idle_s: float = 0
    ) -> bool:
        job = self.imports.get(import_id)
        if job is None or job.status != expected:
            return False
        if expected == "failed" and any(
            other.organization_id == job.organization_id
            and other.status in ("queued", "running", "paused")
            for other in self.imports.values()
        ):
            return False  # regulation_imports_one_active
        if idle_s and datetime.now(UTC) - job.updated_at < timedelta(seconds=idle_s):
            return False
        self._set(import_id, "running")
        return True

    async def touch_import(self, import_id: UUID) -> bool:
        if self.cancel_on_touch:
            self._set(import_id, "cancelled")
        job = self.imports[import_id]
        if job.status != "running":
            return False
        self._set(import_id, "running")
        return True

    async def end_import(
        self, import_id: UUID, status: ImportStatus, error: str | None = None
    ) -> None:
        if self.imports[import_id].status == "running":
            self._set(import_id, status)
            self.errors[import_id] = error

    async def has_files(self, import_id: UUID) -> bool:
        return bool(self.files.get(import_id))

    async def add_files(self, import_id: UUID, files: list[PlannedFile]) -> None:
        self.files[import_id] = list(files)
        for f in files:
            self.file_status[(import_id, f.position)] = ("pending", None)

    async def pending_files(self, import_id: UUID) -> list[PlannedFile]:
        return [
            f
            for f in self.files.get(import_id, [])
            if self.file_status[(import_id, f.position)][0] == "pending"
        ]

    async def failed_count(self, import_id: UUID) -> int:
        return self.statuses(import_id).count("failed")

    async def set_file(
        self, import_id: UUID, position: int, status: FileStatus, error: str | None = None
    ) -> None:
        self.file_status[(import_id, position)] = (status, error)

    async def stored_file(
        self, organization_id: UUID, code: str, version_label: str
    ) -> tuple[str, int] | None:
        for v in self.versions:
            if (v.organization_id, v.code, v.version_label) == (
                organization_id,
                code,
                version_label,
            ):
                return v.sha256, v.size_bytes
        return None

    async def object_exists(self, path: str) -> bool:
        return path in self.objects

    async def upload_pdf(self, path: str, data: bytes) -> None:
        self.objects[path] = data

    async def record_version(self, job: ImportRow, file: PlannedFile, size_bytes: int) -> None:
        org = job.organization_id

        def same_regulation(v: StoredVersion) -> bool:
            return v.organization_id == org and v.code == file.regulation_code

        if file.role is not None:
            for v in self.versions:
                if same_regulation(v) and v.role == file.role:
                    v.role = None
        existing = next(
            (
                v
                for v in self.versions
                if same_regulation(v) and v.version_label == file.version_label
            ),
            None,
        )
        if existing is None:
            self.versions.append(
                StoredVersion(
                    organization_id=org,
                    code=file.regulation_code,
                    version_label=file.version_label,
                    role=file.role,
                    sha256=file.sha256,
                    size_bytes=size_bytes,
                    path=file.path(org),
                    title=file.version_title,
                )
            )
            return
        if existing.sha256 != file.sha256:
            # A different file: what was split from the old one is stale (as in the migration).
            existing.extracted_with = existing.extraction_error = existing.page_count = None
            existing.paragraphs = []
        existing.role, existing.sha256, existing.size_bytes = file.role, file.sha256, size_bytes
        existing.title = file.version_title

    async def versions_to_split(
        self, organization_id: UUID, extractor: str
    ) -> list[VersionToSplit]:
        return [
            VersionToSplit(
                v.id, v.code, v.version_label, v.sha256, v.path, v.extracted_with, v.figures_missing
            )
            for v in self.versions
            if v.organization_id == organization_id
            and (v.extracted_with != extractor or v.figures_missing > 0)
        ]

    async def download_pdf(self, path: str) -> bytes:
        if path in self.unreachable:
            raise ConnectionError(path)
        return self.objects[path]

    async def save_paragraphs(
        self, version: VersionToSplit, extractor: str, extraction: Extraction
    ) -> bool:
        stored = self._version(version)
        if stored is None:
            return False
        stored.paragraphs = list(extraction.paragraphs)
        stored.page_count = extraction.page_count
        stored.extracted_with, stored.extraction_error = extractor, None
        return True

    async def splitting_failed(self, version: VersionToSplit, extractor: str, error: str) -> None:
        stored = self._version(version)
        if stored is not None:
            stored.extracted_with, stored.extraction_error = extractor, error
            stored.paragraphs = []

    async def save_figures(
        self, version: VersionToSplit, figures: list[Figure], missing: int
    ) -> None:
        stored = self._version(version)
        if stored is not None:
            stored.figures, stored.figures_missing = list(figures), missing

    async def organization_model(self, org: UUID, process: str) -> str | None:
        return self.models.get(process)

    async def provider_key(self, org: UUID, provider: str) -> str | None:
        return None

    async def provider_endpoint(self, org: UUID, provider: str) -> Endpoint | None:
        return None

    async def record_usage(self, rows: list[dict[str, Any]]) -> None:
        self.usage += rows

    async def figure_descriptions(self, org: UUID, shas: list[str]) -> dict[str, Described]:
        return {sha: d for (o, sha), d in self.descriptions.items() if o == org and sha in shas}

    async def save_figure_description(self, org: UUID, sha256: str, described: Described) -> None:
        self.descriptions[(org, sha256)] = described

    async def splitting_errors(self, organization_id: UUID, extractor: str) -> list[str]:
        return [
            f"{v.code} {v.version_label}: {v.extraction_error}"
            for v in self.versions
            if v.organization_id == organization_id
            and v.extracted_with == extractor
            and v.extraction_error is not None
        ]

    def _version(self, version: VersionToSplit) -> StoredVersion | None:
        # Only while the file is the one that was listed, like the database function.
        return next(
            (v for v in self.versions if v.id == version.id and v.sha256 == version.sha256), None
        )

    async def aclose(self) -> None:
        self.closed = True

    def _set(self, import_id: UUID, status: ImportStatus) -> None:
        job = self.imports[import_id]
        self.imports[import_id] = job.model_copy(
            update={"status": status, "updated_at": datetime.now(UTC)}
        )
