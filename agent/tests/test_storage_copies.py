"""The files queued in storage_copies (#59): copied once, a failure kept pending with its reason,
and only reachable with the shared secret."""

from dataclasses import dataclass, field

import pytest
from fastapi.testclient import TestClient

from agent_service import storage_copies
from agent_service.api import app, get_copy_queue
from agent_service.settings import Settings, get_settings
from agent_service.storage_copies import AlreadyThere, PendingCopy

pytestmark = pytest.mark.anyio

AUTH = {"Authorization": "Bearer test-secret"}


@dataclass
class FakeQueue:
    rows: dict[int, PendingCopy] = field(default_factory=dict)
    # Paths in the bucket, as (bucket, path).
    objects: set[tuple[str, str]] = field(default_factory=set)
    done: dict[int, str | None] = field(default_factory=dict)
    closed: bool = False

    def add(self, source: str, target: str, bucket: str = "regulations") -> int:
        copy_id = len(self.rows) + 1
        self.rows[copy_id] = PendingCopy(copy_id, bucket, source, target)
        return copy_id

    async def pending(self, limit: int) -> list[PendingCopy]:
        waiting = [r for i, r in sorted(self.rows.items()) if self.done.get(i, "x") is not None]
        return waiting[:limit]

    async def copy(self, bucket_id: str, source_path: str, target_path: str) -> None:
        if (bucket_id, source_path) not in self.objects:
            raise RuntimeError("Object not found")
        if (bucket_id, target_path) in self.objects:
            raise AlreadyThere(target_path)
        self.objects.add((bucket_id, target_path))

    async def finish(self, copy_id: int, error: str | None) -> None:
        self.done[copy_id] = error

    async def remaining(self) -> int:
        return len(await self.pending(10_000))

    async def aclose(self) -> None:
        self.closed = True


async def test_each_file_is_copied_and_a_missing_one_stays_pending_with_its_reason() -> None:
    queue = FakeQueue(objects={("regulations", "a/r7.pdf"), ("regulations", "a/r48.pdf")})
    first = queue.add("a/r7.pdf", "b/r7.pdf")
    missing = queue.add("a/gone.pdf", "b/gone.pdf")
    last = queue.add("a/r48.pdf", "b/r48.pdf")

    progress = await storage_copies.advance(queue, slice_s=10)

    assert (progress.copied, progress.failed, progress.remaining) == (2, 1, 1)
    assert queue.done[first] is None and queue.done[last] is None
    assert "Object not found" in (queue.done[missing] or "")
    assert ("regulations", "b/r48.pdf") in queue.objects


async def test_a_file_an_earlier_call_copied_counts_as_copied() -> None:
    # The copy happened and the call ended before it was written down: the next one goes on.
    queue = FakeQueue(objects={("case-files", "a/spec.md"), ("case-files", "b/spec.md")})
    copy_id = queue.add("a/spec.md", "b/spec.md", bucket="case-files")

    progress = await storage_copies.advance(queue, slice_s=10)

    assert (progress.copied, progress.remaining) == (1, 0)
    assert queue.done[copy_id] is None


def test_the_endpoint_needs_the_secret_and_reports_what_is_left(settings: Settings) -> None:
    queue = FakeQueue(objects={("regulations", "a/r7.pdf")})
    queue.add("a/r7.pdf", "b/r7.pdf")
    app.dependency_overrides[get_copy_queue] = lambda: queue
    app.dependency_overrides[get_settings] = lambda: settings
    try:
        client = TestClient(app)
        assert client.post("/admin/storage-copies/advance").status_code == 401
        response = client.post("/admin/storage-copies/advance", headers=AUTH)
    finally:
        app.dependency_overrides.clear()

    assert response.status_code == 200
    assert response.json() == {"copied": 1, "failed": 0, "remaining": 0}
    assert queue.closed
