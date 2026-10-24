"""An in-memory RunStore with the same behaviour as the Supabase one, including the conditional
claim. tests/test_store_integration.py checks the real one against a local stack."""

from datetime import UTC, datetime
from typing import Any
from uuid import UUID, uuid4

from agent_service.records import (
    Approval,
    ApprovalRequest,
    CaseFile,
    CaseFileBlock,
    CaseFileStatus,
    EventKind,
    OrganizationSettings,
    Run,
    RunFile,
    RunStatus,
)

ORG = UUID("00000000-0000-4000-8000-000000000001")


class InMemoryRunStore:
    def __init__(self) -> None:
        self.runs: dict[UUID, Run] = {}
        self.reference: list[dict[str, Any]] = []
        # Per organisation, in the shape regulation_index returns.
        self.library: dict[UUID, list[dict[str, Any]]] = {}
        self.settings: dict[UUID, OrganizationSettings] = {}
        self.keys: dict[tuple[UUID, str], str] = {}
        # Cost already spent this month per organisation, standing in for older runs' usage.
        self.spent: dict[UUID, float] = {}
        self.users: dict[UUID, tuple[str, str]] = {}
        self.outputs: dict[UUID, str | None] = {}
        self.errors: dict[UUID, str | None] = {}
        self.usage: dict[UUID, dict[str, Any]] = {}
        self.models: dict[UUID, str] = {}
        self.events: list[tuple[UUID, EventKind, dict[str, Any]]] = []
        self.approvals: list[Approval] = []
        self.conversations: dict[UUID, Any] = {}
        self.files: dict[UUID, list[RunFile]] = {}
        self.objects: dict[str, bytes] = {}
        self.cases: dict[UUID, list[CaseFile]] = {}
        self.blocks: dict[UUID, list[CaseFileBlock]] = {}
        self.closed = False

    # Helpers the tests use to play the web's part.

    def add_run(
        self,
        task: str,
        status: RunStatus = "queued",
        org: UUID = ORG,
        case_id: UUID | None = None,
    ) -> UUID:
        run_id = uuid4()
        self.runs[run_id] = Run(
            id=run_id,
            organization_id=org,
            task=task,
            status=status,
            updated_at=datetime.now(UTC),
            case_id=case_id,
        )
        return run_id

    def attach(
        self, run_id: UUID, filename: str, fmt: str, data: bytes, sha256: str | None = None
    ) -> None:
        """What the browser upload and start_run() do: an object in the bucket and its row.

        Rows come back newest first, as the database's random order may give them; the agent has
        to restore the upload order from the `{n}-` prefix the web puts in the object's name.
        """
        files = self.files.setdefault(run_id, [])
        path = f"{self.runs[run_id].organization_id}/{run_id}/{len(files) + 1}-{filename}"
        self.objects[path] = data
        row = RunFile(
            id=uuid4(),
            storage_path=path,
            filename=filename,
            format=fmt,
            bytes=len(data),
            sha256=sha256,
        )
        files.insert(0, row)

    def add_case_file(
        self, case_id: UUID, filename: str, fmt: str, data: bytes, org: UUID = ORG
    ) -> UUID:
        """What the case page does: an object in the case's folder and a pending case_files row."""
        files = self.cases.setdefault(case_id, [])
        path = f"{org}/{case_id}/{len(files) + 1}-{filename}"
        self.objects[path] = data
        row = CaseFile(
            id=uuid4(),
            case_id=case_id,
            organization_id=org,
            position=len(files),
            storage_path=path,
            filename=filename,
            format=fmt,
            bytes=len(data),
            status="pending",
        )
        files.append(row)
        return row.id

    def case_file(self, file_id: UUID) -> CaseFile:
        return next(f for fs in self.cases.values() for f in fs if f.id == file_id)

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

    async def run_files(self, run_id: UUID) -> list[RunFile]:
        return list(self.files.get(run_id, []))

    async def download(self, storage_path: str) -> bytes:
        return self.objects[storage_path]

    async def upload(self, storage_path: str, data: bytes, media_type: str) -> None:
        self.objects[storage_path] = data

    async def case_files(self, case_id: UUID) -> list[CaseFile]:
        return sorted(self.cases.get(case_id, []), key=lambda f: f.position)

    async def set_case_file(
        self,
        file_id: UUID,
        status: CaseFileStatus,
        *,
        only_if: CaseFileStatus,
        notes: list[str] | None = None,
        error: str | None = None,
        pages: int | None = None,
    ) -> bool:
        for files in self.cases.values():
            for i, f in enumerate(files):
                if f.id == file_id:
                    if f.status != only_if:
                        return False
                    changes: dict[str, Any] = {"status": status, "error": error}
                    if notes is not None:
                        changes["notes"] = notes
                    if pages is not None:
                        changes["pages"] = pages
                    files[i] = f.model_copy(update=changes)
                    return True
        return False

    async def replace_blocks(
        self, file_id: UUID, organization_id: UUID, blocks: list[CaseFileBlock]
    ) -> None:
        self.blocks[file_id] = list(blocks)

    async def case_blocks(self, case_id: UUID) -> list[CaseFileBlock]:
        return [b for f in await self.case_files(case_id) for b in self.blocks.get(f.id, [])]

    async def certivity_reference(self) -> list[dict[str, Any]]:
        return list(self.reference)

    async def replace_certivity_reference(self, rows: list[dict[str, Any]]) -> None:
        self.reference = list(rows)

    async def regulation_index(self, organization_id: UUID) -> list[dict[str, Any]]:
        return list(self.library.get(organization_id, []))

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

    async def organization_settings(self, org: UUID) -> OrganizationSettings | None:
        return self.settings.get(org)

    async def provider_key(self, org: UUID, provider: str) -> str | None:
        return self.keys.get((org, provider))

    async def month_cost(self, org: UUID) -> float:
        recorded = sum(
            float(self.usage[rid].get("cost_usd") or 0)
            for rid, run in self.runs.items()
            if run.organization_id == org and rid in self.usage
        )
        return self.spent.get(org, 0.0) + recorded

    async def create_user(self, email: str, password: str) -> tuple[UUID, bool]:
        for user_id, (existing, _) in self.users.items():
            if existing.casefold() == email.casefold():
                return user_id, False
        user_id = uuid4()
        self.users[user_id] = (email, password)
        return user_id, True

    async def set_password(self, user_id: UUID, password: str) -> bool:
        if user_id not in self.users:
            return False
        self.users[user_id] = (self.users[user_id][0], password)
        return True

    async def aclose(self) -> None:
        self.closed = True

    def _update(self, run_id: UUID, status: RunStatus) -> None:
        self.runs[run_id] = self.runs[run_id].model_copy(
            update={"status": status, "updated_at": datetime.now(UTC)}
        )
