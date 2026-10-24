"""Where a run lives between two requests. The runner only knows this interface, so the loop is
tested against an in-memory fake (tests/fakes.py) and the Supabase version against a real local
stack (tests/test_store_integration.py)."""

from datetime import UTC, datetime
from typing import Any, Protocol, cast
from uuid import UUID

from pydantic import TypeAdapter
from supabase import AsyncClient, acreate_client
from supabase_auth.errors import AuthApiError

from agent_service.providers import Endpoint
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

_approvals = TypeAdapter(list[Approval])
_files = TypeAdapter(list[RunFile])
_case_files = TypeAdapter(list[CaseFile])
_blocks = TypeAdapter(list[CaseFileBlock])

# The private bucket the browser uploads case files to (migration 20261024160000_case_files).
CASE_FILES_BUCKET = "case-files"

# PostgREST returns at most this many rows per request (`max_rows` in supabase/config.toml and the
# hosted default). A sum over one page would silently undercount a busy month.
_PAGE = 1000


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

    async def run_files(self, run_id: UUID) -> list[RunFile]:
        """The case files attached to the run, in upload order."""
        ...

    async def download(self, storage_path: str) -> bytes: ...

    async def upload(self, storage_path: str, data: bytes, media_type: str) -> None:
        """Put an object in the case-files bucket, replacing one at that path."""
        ...

    async def case_files(self, case_id: UUID) -> list[CaseFile]:
        """The case's files in upload order."""
        ...

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
        """Change a file's parse status only while it is still `only_if`: two ingest requests for
        the same case must not both parse one file."""
        ...

    async def replace_blocks(
        self, file_id: UUID, organization_id: UUID, blocks: list[CaseFileBlock]
    ) -> None: ...

    async def case_blocks(self, case_id: UUID) -> list[CaseFileBlock]:
        """Every stored block of the case's files, by file and sequence."""
        ...

    async def certivity_reference(self) -> list[dict[str, Any]]:
        """Certivity's reference files (index, answer files), one row each."""
        ...

    async def replace_certivity_reference(self, rows: list[dict[str, Any]]) -> None: ...

    async def regulation_index(self, organization_id: UUID) -> list[dict[str, Any]]:
        """The organisation's regulation library in the shape of Certivity's index.json, as much
        of it as validate.py reads: each regulation's code and its versions' label and role."""
        ...

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
        """Change the status only while it is still `only_if`. False if it had moved on, for
        example a run marked failed as stale while its old request was still finishing."""
        ...

    async def organization_settings(self, org: UUID) -> OrganizationSettings | None:
        """Only what the organisation changed; None if it never changed anything."""
        ...

    async def organization_model(self, org: UUID, process: str) -> str | None:
        """The model the organisation chose for one process (organization_models), or None."""
        ...

    async def provider_key(self, org: UUID, provider: str) -> str | None:
        """The organisation's API key for this provider, or None if it has not connected one."""
        ...

    async def provider_endpoint(self, org: UUID, provider: str) -> Endpoint | None:
        """The organisation's own server for this provider (Ollama), or None if it set none."""
        ...

    async def month_cost(self, org: UUID) -> float:
        """USD recorded on the organisation's runs created since the start of this UTC month."""
        ...

    async def create_user(self, email: str, password: str) -> tuple[UUID, bool]:
        """A confirmed user with this email: (id, True) if created now, (id, False) if it
        already existed, in which case nothing about it is changed."""
        ...

    async def set_password(self, user_id: UUID, password: str) -> bool:
        """False if there is no such user."""
        ...

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
            .select("id, organization_id, task, status, updated_at, case_id, requested_model")
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

    async def run_files(self, run_id: UUID) -> list[RunFile]:
        res = (
            await self._db.table("run_files")
            .select("id, storage_path, filename, format, bytes, sha256")
            .eq("run_id", str(run_id))
            .order("created_at")
            .order("id")
            .execute()
        )
        return _files.validate_python(res.data)

    async def download(self, storage_path: str) -> bytes:
        return await self._db.storage.from_(CASE_FILES_BUCKET).download(storage_path)

    async def upload(self, storage_path: str, data: bytes, media_type: str) -> None:
        await self._db.storage.from_(CASE_FILES_BUCKET).upload(
            storage_path, data, {"content-type": media_type, "upsert": "true"}
        )

    async def case_files(self, case_id: UUID) -> list[CaseFile]:
        res = (
            await self._db.table("case_files")
            .select(
                "id, case_id, organization_id, position, storage_path, filename, format, bytes,"
                " sha256, status, notes, error, pages"
            )
            .eq("case_id", str(case_id))
            .order("position")
            .order("created_at")
            .order("filename")
            .execute()
        )
        return _case_files.validate_python(res.data)

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
        changes: dict[str, Any] = {"status": status, "error": error}
        if notes is not None:
            changes["notes"] = notes
        if pages is not None:
            changes["pages"] = pages
        if status in ("parsed", "failed"):
            changes["parsed_at"] = datetime.now(UTC).isoformat()
        res = (
            await self._db.table("case_files")
            .update(changes)
            .eq("id", str(file_id))
            .eq("status", only_if)
            .execute()
        )
        return len(res.data) == 1

    async def replace_blocks(
        self, file_id: UUID, organization_id: UUID, blocks: list[CaseFileBlock]
    ) -> None:
        # A re-parse replaces the whole file's content, so no stale page survives a new version.
        await self._db.table("case_file_blocks").delete().eq("file_id", str(file_id)).execute()
        if blocks:
            rows = [
                {**b.model_dump(mode="json"), "organization_id": str(organization_id)}
                for b in blocks
            ]
            await self._db.table("case_file_blocks").insert(rows).execute()

    async def case_blocks(self, case_id: UUID) -> list[CaseFileBlock]:
        files = await self.case_files(case_id)
        if not files:
            return []
        order = {f.id: i for i, f in enumerate(files)}
        blocks: list[CaseFileBlock] = []
        offset = 0
        while True:
            res = (
                await self._db.table("case_file_blocks")
                .select("file_id, seq, kind, page, label, text, image_path, media_type, parser")
                .in_("file_id", [str(f.id) for f in files])
                .order("id")
                .range(offset, offset + _PAGE - 1)
                .execute()
            )
            page = _blocks.validate_python(res.data)
            blocks += page
            if len(page) < _PAGE:
                break
            offset += _PAGE
        return sorted(blocks, key=lambda b: (order.get(b.file_id, 0), b.seq))

    async def certivity_reference(self) -> list[dict[str, Any]]:
        res = (
            await self._db.table("certivity_reference")
            .select("kind, case_id, content, certivity_commit")
            .execute()
        )
        return cast(list[dict[str, Any]], res.data)

    async def regulation_index(self, organization_id: UUID) -> list[dict[str, Any]]:
        # One page is enough: a library holds one row per regulation (56 in the challenge).
        res = (
            await self._db.table("regulations")
            .select("code, regulation_versions(version_label, role)")
            .eq("organization_id", str(organization_id))
            .order("code")
            .execute()
        )
        return [
            {
                "regulation": r["code"],
                "versions": [
                    {"version_label": v["version_label"], "role": v.get("role") or ""}
                    for v in r.get("regulation_versions") or []
                ],
            }
            for r in cast(list[dict[str, Any]], res.data)
        ]

    async def replace_certivity_reference(self, rows: list[dict[str, Any]]) -> None:
        # Upsert first, then delete what the new package no longer has: between the two, a check
        # sees the new files plus at worst a stale one, never an empty table.
        if rows:
            await self._db.table("certivity_reference").upsert(rows).execute()
        keep = {(r["kind"], r["case_id"]) for r in rows}
        stored = await self.certivity_reference()
        for r in stored:
            if (r["kind"], r["case_id"]) not in keep:
                await (
                    self._db.table("certivity_reference")
                    .delete()
                    .eq("kind", r["kind"])
                    .eq("case_id", r["case_id"])
                    .execute()
                )

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
        changes: dict[str, Any] = {"status": status, "output": output, "error": error}
        if usage is not None:
            changes["usage"] = usage
        res = (
            await self._db.table("runs")
            .update(changes)
            .eq("id", str(run_id))
            .eq("status", only_if)
            .execute()
        )
        return len(res.data) == 1

    async def organization_settings(self, org: UUID) -> OrganizationSettings | None:
        res = (
            await self._db.table("organization_settings")
            .select("model, max_model_requests, monthly_cost_cap_usd")
            .eq("organization_id", str(org))
            .limit(1)
            .execute()
        )
        return OrganizationSettings.model_validate(res.data[0]) if res.data else None

    async def organization_model(self, org: UUID, process: str) -> str | None:
        res = (
            await self._db.table("organization_models")
            .select("model")
            .eq("organization_id", str(org))
            .eq("process", process)
            .limit(1)
            .execute()
        )
        row = res.data[0] if res.data else None
        model = row.get("model") if isinstance(row, dict) else None
        return model if isinstance(model, str) else None

    async def provider_key(self, org: UUID, provider: str) -> str | None:
        # The only function the secret key may call and a signed-in person may not: the key is
        # decrypted from Vault here and nowhere else.
        res = await self._db.rpc(
            "read_provider_key", {"org": str(org), "key_provider": provider}
        ).execute()
        return res.data if isinstance(res.data, str) and res.data else None

    async def provider_endpoint(self, org: UUID, provider: str) -> Endpoint | None:
        # Same rule as read_provider_key: only the secret key may call it.
        res = await self._db.rpc(
            "read_provider_endpoint", {"org": str(org), "key_provider": provider}
        ).execute()
        data = res.data
        if not isinstance(data, dict) or not data.get("base_url"):
            return None
        row = cast(dict[str, Any], data)
        return Endpoint(
            base_url=str(row["base_url"]),
            auth_scheme=row.get("auth_scheme") or "none",
            username=row.get("username"),
            secret=row.get("secret"),
        )

    async def month_cost(self, org: UUID) -> float:
        # Same rule as the database's organization_usage(): by the run's created_at, so the cap
        # and the usage page agree on which month a run belongs to. That function cannot be
        # called with the secret key (it asks auth.uid()), hence the sum here.
        start = datetime.now(UTC).replace(day=1, hour=0, minute=0, second=0, microsecond=0)
        total = 0.0
        offset = 0
        while True:
            res = (
                await self._db.table("runs")
                .select("cost:usage->>cost_usd")
                .eq("organization_id", str(org))
                .gte("created_at", start.isoformat())
                .order("id")
                .range(offset, offset + _PAGE - 1)
                .execute()
            )
            page: list[Any] = res.data
            # A run on an unpriced model records no cost and counts as zero.
            total += sum(float(r["cost"]) for r in page if r.get("cost") is not None)
            if len(page) < _PAGE:
                return total
            offset += _PAGE

    async def create_user(self, email: str, password: str) -> tuple[UUID, bool]:
        try:
            created = await self._db.auth.admin.create_user(
                {"email": email, "password": password, "email_confirm": True}
            )
            return UUID(created.user.id), True
        except AuthApiError as exc:
            if exc.code != "email_exists":
                raise
        existing = await self._find_user(email)
        if existing is None:
            # Deleted between the two calls; rare enough to report rather than retry.
            raise LookupError("The user existed a moment ago and is gone now.")
        return existing, False

    async def _find_user(self, email: str) -> UUID | None:
        # The Auth admin API in this client has no lookup by email, only pages of users.
        wanted = email.casefold()
        page = 1
        while True:
            users = await self._db.auth.admin.list_users(page=page, per_page=_PAGE)
            for user in users:
                if (user.email or "").casefold() == wanted:
                    return UUID(user.id)
            if len(users) < _PAGE:
                return None
            page += 1

    async def set_password(self, user_id: UUID, password: str) -> bool:
        try:
            await self._db.auth.admin.update_user_by_id(str(user_id), {"password": password})
        except AuthApiError as exc:
            if exc.code == "user_not_found":
                return False
            raise
        return True

    async def aclose(self) -> None:
        await self._db.postgrest.aclose()
        # Auth has its own connection pool (used by create_user and set_password).
        await self._db.auth.close()
