"""The regulation library in Supabase: the import tables, the catalogue and paragraph functions,
and the bucket.
The in-memory twin for unit tests is tests/library_fakes.py; this one is tested against a local
stack in tests/test_library_integration.py."""

from datetime import UTC, datetime, timedelta
from typing import Any, cast
from uuid import UUID

from supabase import AsyncClient, acreate_client

from agent_service.domain.paragraphs import Extraction
from agent_service.domain.regulations import (
    BUCKET,
    FileStatus,
    ImportRow,
    ImportStatus,
    PlannedFile,
    VersionToSplit,
)

# PostgREST's page size (supabase/config.toml `max_rows`, and the hosted default).
_PAGE = 1000


def _rows(response: Any) -> list[dict[str, Any]]:
    return cast(list[dict[str, Any]], response.data)


class SupabaseLibraryStore:
    """With the secret key, which bypasses RLS: only the agent writes the library."""

    def __init__(self, client: AsyncClient) -> None:
        self._db = client

    @classmethod
    async def connect(cls, url: str, secret_key: str) -> "SupabaseLibraryStore":
        return cls(await acreate_client(url, secret_key))

    async def get_import(self, import_id: UUID) -> ImportRow | None:
        res = (
            await self._db.table("regulation_imports")
            .select("id, organization_id, status, index, updated_at")
            .eq("id", str(import_id))
            .limit(1)
            .execute()
        )
        rows = _rows(res)
        return ImportRow.model_validate(rows[0]) if rows else None

    async def claim_import(
        self, import_id: UUID, expected: ImportStatus, *, idle_s: float = 0
    ) -> bool:
        # The status filter is the lock, as for runs: of two requests, one update matches a row.
        query = (
            self._db.table("regulation_imports")
            .update({"status": "running", "error": None})
            .eq("id", str(import_id))
            .eq("status", expected)
        )
        if idle_s:
            cutoff = datetime.now(UTC) - timedelta(seconds=idle_s)
            query = query.lt("updated_at", cutoff.isoformat())
        return len(_rows(await query.execute())) == 1

    async def touch_import(self, import_id: UUID) -> bool:
        res = (
            await self._db.table("regulation_imports")
            .update({"status": "running"})
            .eq("id", str(import_id))
            .eq("status", "running")
            .execute()
        )
        return len(_rows(res)) == 1

    async def end_import(
        self, import_id: UUID, status: ImportStatus, error: str | None = None
    ) -> None:
        values: dict[str, Any] = {"status": status, "error": error}
        if status != "paused":
            values["finished_at"] = datetime.now(UTC).isoformat()
        await (
            self._db.table("regulation_imports")
            .update(values)
            .eq("id", str(import_id))
            .eq("status", "running")
            .execute()
        )

    async def has_files(self, import_id: UUID) -> bool:
        res = (
            await self._db.table("regulation_import_files")
            .select("position")
            .eq("import_id", str(import_id))
            .limit(1)
            .execute()
        )
        return bool(res.data)

    async def add_files(self, import_id: UUID, files: list[PlannedFile]) -> None:
        rows = [
            {
                "import_id": str(import_id),
                "position": f.position,
                "regulation_code": f.regulation_code,
                "regulation_title": f.regulation_title,
                "source_url": f.regulation_source_url,
                "version_label": f.version_label,
                "role": f.role,
                "version_status": f.status,
                "version_title": f.version_title,
                "file_name": f.file_name,
                "url": f.url,
                "sha256": f.sha256,
                "size_bytes": f.size_bytes,
            }
            for f in files
        ]
        for start in range(0, len(rows), _PAGE):
            page = rows[start : start + _PAGE]
            await self._db.table("regulation_import_files").insert(page).execute()

    async def pending_files(self, import_id: UUID) -> list[PlannedFile]:
        files: list[PlannedFile] = []
        start = 0
        while True:
            res = (
                await self._db.table("regulation_import_files")
                .select("*")
                .eq("import_id", str(import_id))
                .eq("status", "pending")
                .order("position")
                .range(start, start + _PAGE - 1)
                .execute()
            )
            page = _rows(res)
            files += [
                PlannedFile(
                    position=r["position"],
                    regulation_code=r["regulation_code"],
                    regulation_title=r["regulation_title"],
                    regulation_source_url=r["source_url"],
                    version_label=r["version_label"],
                    role=r["role"],
                    status=r["version_status"],
                    version_title=r["version_title"],
                    file_name=r["file_name"],
                    url=r["url"],
                    sha256=r["sha256"],
                    size_bytes=r["size_bytes"],
                )
                for r in page
            ]
            if len(page) < _PAGE:
                return files
            start += _PAGE

    async def failed_count(self, import_id: UUID) -> int:
        res = (
            await self._db.table("regulation_import_files")
            .select("position", count="exact")  # pyright: ignore[reportArgumentType]
            .eq("import_id", str(import_id))
            .eq("status", "failed")
            .limit(1)
            .execute()
        )
        return res.count or 0

    async def set_file(
        self, import_id: UUID, position: int, status: FileStatus, error: str | None = None
    ) -> None:
        await (
            self._db.table("regulation_import_files")
            .update({"status": status, "error": error})
            .eq("import_id", str(import_id))
            .eq("position", position)
            .execute()
        )

    async def stored_file(
        self, organization_id: UUID, code: str, version_label: str
    ) -> tuple[str, int] | None:
        res = (
            await self._db.table("regulation_versions")
            .select("sha256, size_bytes, regulations!inner(code)")
            .eq("organization_id", str(organization_id))
            .eq("regulations.code", code)
            .eq("version_label", version_label)
            .limit(1)
            .execute()
        )
        rows = _rows(res)
        return (rows[0]["sha256"], rows[0]["size_bytes"]) if rows else None

    async def object_exists(self, path: str) -> bool:
        return await self._db.storage.from_(BUCKET).exists(path)

    async def upload_pdf(self, path: str, data: bytes) -> None:
        await self._db.storage.from_(BUCKET).upload(
            path, data, {"content-type": "application/pdf", "upsert": "true"}
        )

    async def record_version(self, job: ImportRow, file: PlannedFile, size_bytes: int) -> None:
        await self._db.rpc(
            "record_regulation_version",
            {
                "p_organization_id": str(job.organization_id),
                "p_import_id": str(job.id),
                "p_code": file.regulation_code,
                "p_slug": file.slug,
                "p_kind": file.kind,
                "p_title": file.regulation_title,
                "p_source_url": file.regulation_source_url,
                "p_version_label": file.version_label,
                "p_role": file.role,
                "p_status": file.status,
                "p_version_title": file.version_title,
                "p_file_name": file.file_name,
                "p_sha256": file.sha256,
                "p_size_bytes": size_bytes,
                "p_pdf_path": file.path(job.organization_id),
            },
        ).execute()

    async def versions_to_split(
        self, organization_id: UUID, extractor: str
    ) -> list[VersionToSplit]:
        found: list[VersionToSplit] = []
        start = 0
        while True:
            res = (
                await self._db.table("regulation_versions")
                .select("id, version_label, sha256, pdf_path, regulations!inner(code)")
                .eq("organization_id", str(organization_id))
                .or_(f"extracted_with.is.null,extracted_with.neq.{extractor}")
                .order("created_at")
                .order("id")
                .range(start, start + _PAGE - 1)
                .execute()
            )
            page = _rows(res)
            found += [
                VersionToSplit(
                    id=UUID(r["id"]),
                    regulation_code=r["regulations"]["code"],
                    version_label=r["version_label"],
                    sha256=r["sha256"],
                    pdf_path=r["pdf_path"],
                )
                for r in page
            ]
            if len(page) < _PAGE:
                return found
            start += _PAGE

    async def download_pdf(self, path: str) -> bytes:
        return await self._db.storage.from_(BUCKET).download(path)

    async def save_paragraphs(
        self, version: VersionToSplit, extractor: str, extraction: Extraction
    ) -> bool:
        # One call, one transaction (replace_regulation_paragraphs): about 500 paragraphs and
        # 150 KB of text for an average version, a few MB for the largest (R49).
        rows = [
            {
                "position": p.position,
                "label": p.label,
                "annex": p.annex,
                "appendix": p.appendix,
                "part": p.part,
                "number": p.number,
                "heading": p.heading,
                "kind": p.kind,
                "text": p.text,
                "page_start": p.page_start,
                "page_end": p.page_end,
                "content_hash": p.content_hash,
            }
            for p in extraction.paragraphs
        ]
        res = await self._db.rpc(
            "replace_regulation_paragraphs",
            {
                "p_version_id": str(version.id),
                "p_sha256": version.sha256,
                "p_extracted_with": extractor,
                "p_page_count": extraction.page_count,
                "p_paragraphs": rows,
            },
        ).execute()
        return res.data is not None

    async def splitting_failed(self, version: VersionToSplit, extractor: str, error: str) -> None:
        await self._db.rpc(
            "record_regulation_extraction_failure",
            {
                "p_version_id": str(version.id),
                "p_sha256": version.sha256,
                "p_extracted_with": extractor,
                "p_error": error,
            },
        ).execute()

    async def splitting_errors(self, organization_id: UUID, extractor: str) -> list[str]:
        res = (
            await self._db.table("regulation_versions")
            .select("version_label, extraction_error, regulations!inner(code)")
            .eq("organization_id", str(organization_id))
            .eq("extracted_with", extractor)
            .not_.is_("extraction_error", "null")
            .order("created_at")
            .limit(_PAGE)
            .execute()
        )
        return [
            f"{r['regulations']['code']} {r['version_label']}: {r['extraction_error']}"
            for r in _rows(res)
        ]

    async def aclose(self) -> None:
        await self._db.postgrest.aclose()
