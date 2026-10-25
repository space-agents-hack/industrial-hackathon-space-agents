"""Files copied inside Storage, as queued in public.storage_copies (migration 20261025050000).

A copy of an organisation (scripts/demo-org.sql, #59) is rows and files. SQL copies the rows, run
by the workflow that holds the database password; only the Storage API copies a file, and only
this service holds the key it needs. So SQL writes down what to copy and this does it, a slice at
a time, until nothing is left. The caller names no path: whoever can write that table decides,
and no browser role can.

A copy is server-side: no file passes through this function, so a 50 MB PDF costs a request, not
its size in memory.
"""

import logging
import time
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any, Protocol, cast

from postgrest.types import CountMethod
from storage3.exceptions import StorageApiError
from supabase import AsyncClient, acreate_client

log = logging.getLogger(__name__)


@dataclass(frozen=True)
class PendingCopy:
    id: int
    bucket_id: str
    source_path: str
    target_path: str


@dataclass
class Progress:
    copied: int = 0
    failed: int = 0
    remaining: int = 0


class CopyQueue(Protocol):
    async def pending(self, limit: int) -> list[PendingCopy]: ...
    async def copy(self, bucket_id: str, source_path: str, target_path: str) -> None: ...
    async def finish(self, copy_id: int, error: str | None) -> None: ...
    async def remaining(self) -> int: ...
    async def aclose(self) -> None: ...


class AlreadyThere(Exception):
    """The target exists: an earlier slice copied it and stopped before writing that down."""


class SupabaseCopyQueue:
    def __init__(self, client: AsyncClient) -> None:
        self._db = client

    @classmethod
    async def connect(cls, url: str, secret_key: str) -> "SupabaseCopyQueue":
        return cls(await acreate_client(url, secret_key))

    async def pending(self, limit: int) -> list[PendingCopy]:
        res = (
            await self._db.table("storage_copies")
            .select("id, bucket_id, source_path, target_path")
            .is_("copied_at", "null")
            .order("id")
            .limit(limit)
            .execute()
        )
        return [PendingCopy(**row) for row in cast(list[dict[str, Any]], res.data)]

    async def copy(self, bucket_id: str, source_path: str, target_path: str) -> None:
        try:
            await self._db.storage.from_(bucket_id).copy(source_path, target_path)
        except StorageApiError as exc:
            if str(exc.status) == "409":
                raise AlreadyThere(target_path) from None
            raise

    async def finish(self, copy_id: int, error: str | None) -> None:
        changes: dict[str, Any] = {"error": error}
        if error is None:
            changes["copied_at"] = datetime.now(UTC).isoformat()
        await self._db.table("storage_copies").update(changes).eq("id", copy_id).execute()

    async def remaining(self) -> int:
        res = (
            await self._db.table("storage_copies")
            .select("id", count=CountMethod.exact, head=True)
            .is_("copied_at", "null")
            .execute()
        )
        return res.count or 0

    async def aclose(self) -> None:
        # The client has no close of its own; its HTTP pools go with the instance.
        return None


async def advance(queue: CopyQueue, *, slice_s: float, batch: int = 50) -> Progress:
    """Copy pending files until the slice is spent. A failure is written on its row and the row
    stays pending, so the next call tries it again; one missing source does not stop the rest."""
    deadline = time.monotonic() + slice_s
    progress = Progress()
    tried: set[int] = set()
    while time.monotonic() < deadline:
        rows = [r for r in await queue.pending(batch + len(tried)) if r.id not in tried]
        if not rows:
            break
        for row in rows:
            if time.monotonic() >= deadline:
                break
            tried.add(row.id)
            try:
                await queue.copy(row.bucket_id, row.source_path, row.target_path)
            except AlreadyThere:
                pass
            except Exception as exc:
                log.warning("Could not copy %s/%s: %s", row.bucket_id, row.source_path, exc)
                await queue.finish(row.id, f"{type(exc).__name__}: {exc}"[:500])
                progress.failed += 1
                continue
            await queue.finish(row.id, None)
            progress.copied += 1
    progress.remaining = await queue.remaining()
    return progress
