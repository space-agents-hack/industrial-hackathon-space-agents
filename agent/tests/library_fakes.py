"""An in-memory LibraryStore with the same rules as the Supabase one: the conditional claim, the
heartbeat that fails once the import is cancelled, and a role that moves to the newest version.
tests/test_library_integration.py checks the real one against a local stack."""

from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import UUID, uuid4

from agent_service.domain.regulations import FileStatus, ImportRow, ImportStatus, PlannedFile

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
    closed: bool = False

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

    def role_of(self, code: str, version_label: str, org: UUID = ORG) -> str | None:
        return next(
            v.role
            for v in self.versions
            if v.organization_id == org and v.code == code and v.version_label == version_label
        )

    # The LibraryStore interface.

    async def get_import(self, import_id: UUID) -> ImportRow | None:
        return self.imports.get(import_id)

    async def claim_import(
        self, import_id: UUID, expected: ImportStatus, *, idle_s: float = 0
    ) -> bool:
        job = self.imports.get(import_id)
        if job is None or job.status != expected:
            return False
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
        self.versions = [
            v
            for v in self.versions
            if not (same_regulation(v) and v.version_label == file.version_label)
        ]
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

    async def aclose(self) -> None:
        self.closed = True

    def _set(self, import_id: UUID, status: ImportStatus) -> None:
        job = self.imports[import_id]
        self.imports[import_id] = job.model_copy(
            update={"status": status, "updated_at": datetime.now(UTC)}
        )
