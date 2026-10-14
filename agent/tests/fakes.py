"""An in-memory RunStore with the same behaviour as the Supabase one, including the conditional
claim. tests/test_store_integration.py checks the real one against a local stack."""

from datetime import UTC, datetime
from typing import Any
from uuid import UUID, uuid4

from agent_service.records import Approval, ApprovalRequest, EventKind, Run, RunStatus


class InMemoryRunStore:
    def __init__(self) -> None:
        self.runs: dict[UUID, Run] = {}
        self.outputs: dict[UUID, str | None] = {}
        self.errors: dict[UUID, str | None] = {}
        self.usage: dict[UUID, dict[str, Any]] = {}
        self.models: dict[UUID, str] = {}
        self.events: list[tuple[UUID, EventKind, dict[str, Any]]] = []
        self.approvals: list[Approval] = []
        self.conversations: dict[UUID, Any] = {}
        self.closed = False

    # Helpers the tests use to play the web's part.

    def add_run(self, task: str, status: RunStatus = "queued") -> UUID:
        run_id = uuid4()
        self.runs[run_id] = Run(id=run_id, task=task, status=status, updated_at=datetime.now(UTC))
        return run_id

    def decide(self, run_id: UUID, status: str, note: str | None = None) -> None:
        self.approvals = [
            a.model_copy(update={"status": status, "note": note})
            if a.run_id == run_id and a.status == "pending"
            else a
            for a in self.approvals
        ]

    def kinds(self, run_id: UUID) -> list[str]:
        return [kind for rid, kind, _ in self.events if rid == run_id]

    def payloads(self, run_id: UUID, kind: str) -> list[dict[str, Any]]:
        return [p for rid, k, p in self.events if rid == run_id and k == kind]

    # The RunStore interface.

    async def get_run(self, run_id: UUID) -> Run | None:
        return self.runs.get(run_id)

    async def claim(self, run_id: UUID, expected: RunStatus, model: str) -> bool:
        run = self.runs.get(run_id)
        if run is None or run.status != expected:
            return False
        self._update(run_id, "running")
        self.models[run_id] = model
        return True

    async def touch(self, run_id: UUID) -> None:
        if self.runs[run_id].status == "running":
            self._update(run_id, "running")

    async def add_event(self, run_id: UUID, kind: EventKind, payload: dict[str, Any]) -> None:
        self.events.append((run_id, kind, payload))

    async def request_approvals(
        self, run_id: UUID, requests: list[ApprovalRequest]
    ) -> list[Approval]:
        created = [
            Approval(id=uuid4(), run_id=run_id, status="pending", **r.model_dump())
            for r in requests
        ]
        self.approvals.extend(created)
        return created

    async def list_approvals(self, run_id: UUID) -> list[Approval]:
        return [a for a in self.approvals if a.run_id == run_id]

    async def save_conversation(self, run_id: UUID, conversation: Any) -> None:
        self.conversations[run_id] = conversation

    async def load_conversation(self, run_id: UUID) -> Any | None:
        return self.conversations.get(run_id)

    async def set_status(
        self,
        run_id: UUID,
        status: RunStatus,
        *,
        only_if: RunStatus,
        output: str | None = None,
        error: str | None = None,
        usage: dict[str, Any] | None = None,
    ) -> bool:
        if self.runs[run_id].status != only_if:
            return False
        self._update(run_id, status)
        self.outputs[run_id] = output
        self.errors[run_id] = error
        if usage is not None:
            self.usage[run_id] = usage
        return True

    async def aclose(self) -> None:
        self.closed = True

    def _update(self, run_id: UUID, status: RunStatus) -> None:
        self.runs[run_id] = self.runs[run_id].model_copy(
            update={"status": status, "updated_at": datetime.now(UTC)}
        )
