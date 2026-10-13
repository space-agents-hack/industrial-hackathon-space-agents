"""Where a run lives between two requests. The runner only knows this interface, so the loop is
tested against an in-memory fake (tests/fakes.py) and the Supabase version against a real local
stack (tests/test_store_integration.py)."""

from typing import Any, Protocol
from uuid import UUID

from pydantic import TypeAdapter
from supabase import AsyncClient, acreate_client

from agent_service.records import Approval, ApprovalRequest, EventKind, Run, RunStatus

_approvals = TypeAdapter(list[Approval])


class RunStore(Protocol):
    async def get_run(self, run_id: UUID) -> Run | None: ...

    async def claim(self, run_id: UUID, expected: RunStatus, model: str) -> bool:
        """Move the run from `expected` to running. False if someone else got there first."""
        ...

    async def touch(self, run_id: UUID) -> None:
        """Heartbeat: refresh `updated_at` while the run is still running."""
        ...

    async def add_event(self, run_id: UUID, kind: EventKind, payload: dict[str, Any]) -> None: ...

    async def request_approvals(
        self, run_id: UUID, requests: list[ApprovalRequest]
    ) -> list[Approval]: ...

    async def list_approvals(self, run_id: UUID) -> list[Approval]: ...

    async def save_conversation(self, run_id: UUID, conversation: Any) -> None: ...

    async def load_conversation(self, run_id: UUID) -> Any | None: ...

    async def set_status(
        self,
        run_id: UUID,
        status: RunStatus,
        *,
        output: str | None = None,
        error: str | None = None,
        usage: dict[str, Any] | None = None,
    ) -> None: ...

    async def aclose(self) -> None: ...


class SupabaseRunStore:
    """Talks to Postgres through the Supabase API with the secret key, which bypasses RLS. That is
    why this key exists only in the agent's environment and never in the web's."""

    def __init__(self, client: AsyncClient) -> None:
        self._db = client

    @classmethod
    async def connect(cls, url: str, secret_key: str) -> "SupabaseRunStore":
        return cls(await acreate_client(url, secret_key))

    async def get_run(self, run_id: UUID) -> Run | None:
        res = (
            await self._db.table("runs")
            .select("id, task, status, updated_at")
            .eq("id", str(run_id))
            .limit(1)
            .execute()
        )
        return Run.model_validate(res.data[0]) if res.data else None

    async def claim(self, run_id: UUID, expected: RunStatus, model: str) -> bool:
        # The status filter is the lock: of two requests racing for the same run, only one update
        # matches a row.
        res = (
            await self._db.table("runs")
            .update({"status": "running", "model": model, "error": None})
            .eq("id", str(run_id))
            .eq("status", expected)
            .execute()
        )
        return len(res.data) == 1

    async def touch(self, run_id: UUID) -> None:
        await (
            self._db.table("runs")
            .update({"status": "running"})
            .eq("id", str(run_id))
            .eq("status", "running")
            .execute()
        )

    async def add_event(self, run_id: UUID, kind: EventKind, payload: dict[str, Any]) -> None:
        await (
            self._db.table("run_events")
            .insert({"run_id": str(run_id), "kind": kind, "payload": payload})
            .execute()
        )

    async def request_approvals(
        self, run_id: UUID, requests: list[ApprovalRequest]
    ) -> list[Approval]:
        rows = [{"run_id": str(run_id), **r.model_dump()} for r in requests]
        res = await self._db.table("approvals").insert(rows).execute()
        return _approvals.validate_python(res.data)

    async def list_approvals(self, run_id: UUID) -> list[Approval]:
        res = (
            await self._db.table("approvals")
            .select("*")
            .eq("run_id", str(run_id))
            .order("created_at")
            .execute()
        )
        return _approvals.validate_python(res.data)

    async def save_conversation(self, run_id: UUID, conversation: Any) -> None:
        await (
            self._db.table("run_state")
            .upsert({"run_id": str(run_id), "conversation": conversation})
            .execute()
        )

    async def load_conversation(self, run_id: UUID) -> Any | None:
        res = (
            await self._db.table("run_state")
            .select("conversation")
            .eq("run_id", str(run_id))
            .limit(1)
            .execute()
        )
        if not res.data:
            return None
        row = res.data[0]
        return row["conversation"] if isinstance(row, dict) else None

    async def set_status(
        self,
        run_id: UUID,
        status: RunStatus,
        *,
        output: str | None = None,
        error: str | None = None,
        usage: dict[str, Any] | None = None,
    ) -> None:
        changes: dict[str, Any] = {"status": status, "output": output, "error": error}
        if usage is not None:
            changes["usage"] = usage
        await self._db.table("runs").update(changes).eq("id", str(run_id)).execute()

    async def aclose(self) -> None:
        await self._db.postgrest.aclose()
