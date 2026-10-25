"""An in-memory RunStore with the same behaviour as the Supabase one, including the conditional
claim. tests/test_store_integration.py checks the real one against a local stack."""

import hashlib
import re
from collections.abc import Sequence
from datetime import UTC, datetime
from typing import Any
from uuid import UUID, uuid4

from agent_service.domain.assistant import CaseFileSummary, CaseSummary, ProjectInfo, RunSummary
from agent_service.domain.regulation_search import (
    Hit,
    ProjectScope,
    ScopeSummary,
    VersionToSummarize,
)
from agent_service.providers import Endpoint
from agent_service.records import (
    Approval,
    ApprovalRequest,
    CaseFile,
    CaseFileBlock,
    CaseFileStatus,
    EventKind,
    LibraryVersion,
    NewRequirement,
    OrganizationSettings,
    Paragraph,
    Requirement,
    RequirementStatus,
    Run,
    RunEvent,
    RunFile,
    RunOutcome,
    RunStatus,
)

ORG = UUID("00000000-0000-4000-8000-000000000001")


class InMemoryRunStore:
    def __init__(self) -> None:
        self.runs: dict[UUID, Run] = {}
        self.reference: list[dict[str, Any]] = []
        # run_checks rows by (run_id, source), as the agent stores them.
        self.checks: dict[tuple[UUID, str], dict[str, Any]] = {}
        # Per organisation, in the shape regulation_index returns.
        self.library: dict[UUID, list[dict[str, Any]]] = {}
        self.settings: dict[UUID, OrganizationSettings] = {}
        self.process_models: dict[tuple[UUID, str], str] = {}
        self.keys: dict[tuple[UUID, str], str] = {}
        self.endpoints: dict[tuple[UUID, str], Endpoint] = {}
        # Cost already spent this month per organisation, standing in for older runs' usage.
        self.spent: dict[UUID, float] = {}
        # Organisations marked read-only (SYS-47).
        self.read_only: set[UUID] = set()
        self.users: dict[UUID, tuple[str, str]] = {}
        self.outputs: dict[UUID, str | None] = {}
        self.errors: dict[UUID, str | None] = {}
        self.usage: dict[UUID, dict[str, Any]] = {}
        # model_usage rows, as agent_service/metering.py writes them.
        self.usage_rows: list[dict[str, Any]] = []
        self.models: dict[UUID, str] = {}
        self.events: list[tuple[UUID, EventKind, dict[str, Any]]] = []
        self.approvals: list[Approval] = []
        self.conversations: dict[UUID, Any] = {}
        self.files: dict[UUID, list[RunFile]] = {}
        self.objects: dict[str, bytes] = {}
        self.cases: dict[UUID, list[CaseFile]] = {}
        self.blocks: dict[UUID, list[CaseFileBlock]] = {}
        self.case_names: dict[UUID, str] = {}
        self.case_kinds: dict[UUID, str] = {}
        self.organization_names: dict[UUID, str] = {}
        # Per case, the regulations its project chose; a case not here reads all of them.
        self.case_choice: dict[UUID, set[str]] = {}
        # The library as the writer reads it (regulation_versions); `library` above is the same
        # library in index.json's shape, for tests that only need the checks.
        self.versions: dict[UUID, list[LibraryVersion]] = {}
        self.paragraphs: dict[UUID, list[Paragraph]] = {}
        self.requirements: list[Requirement] = []
        # What a sub-goal run reads and fills (domain/subgoal_library.py); None: in memory.
        self.subgoal: Any = None
        self.closed = False

    # Helpers the tests use to play the web's part.

    def add_run(
        self,
        task: str,
        status: RunStatus = "queued",
        org: UUID = ORG,
        case_id: UUID | None = None,
        requested_model: str | None = None,
    ) -> UUID:
        run_id = uuid4()
        self.runs[run_id] = Run(
            id=run_id,
            organization_id=org,
            task=task,
            status=status,
            updated_at=datetime.now(UTC),
            case_id=case_id,
            requested_model=requested_model,
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

    def add_version(
        self,
        regulation: str,
        version_label: str,
        paragraphs: Sequence[tuple[str | None, str, int]],
        *,
        role: str | None = "base",
        org: UUID = ORG,
        heading: str = "",
    ) -> UUID:
        """What an import and its extraction leave in the library: a version and its paragraphs,
        given as (label, text, page)."""
        version_id = uuid4()
        self.paragraphs[version_id] = [
            Paragraph(
                id=uuid4(),
                version_id=version_id,
                position=i,
                label=label,
                heading=heading,
                kind="paragraph" if label else "text",
                text=text,
                page_start=page,
                page_end=page,
                content_hash=hashlib.sha256(text.encode()).hexdigest(),
            )
            for i, (label, text, page) in enumerate(paragraphs)
        ]
        self.versions.setdefault(org, []).append(
            LibraryVersion(
                id=version_id,
                regulation=regulation,
                title=f"{regulation} title",
                version_label=version_label,
                role=role,
                page_count=max((p for _, _, p in paragraphs), default=0),
                paragraph_count=len(paragraphs),
            )
        )
        return version_id

    def add_parsed_case(self, name: str, text: str, org: UUID = ORG) -> UUID:
        """A case whose one file was uploaded and parsed: what a run on a case starts from."""
        case_id = uuid4()
        self.case_names[case_id] = name
        file_id = self.add_case_file(case_id, "spec.md", "md", text.encode(), org)
        files = self.cases[case_id]
        files[-1] = files[-1].model_copy(update={"status": "parsed"})
        self.blocks[file_id] = [
            CaseFileBlock(file_id=file_id, seq=0, kind="text", text=text, parser="markdown")
        ]
        return case_id

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

    async def run_outcome(self, run_id: UUID) -> RunOutcome | None:
        if run_id not in self.runs:
            return None
        return RunOutcome(
            model=self.models.get(run_id),
            output=self.outputs.get(run_id),
            error=self.errors.get(run_id),
        )

    async def run_events(self, run_id: UUID) -> list[RunEvent]:
        return [RunEvent(kind=k, payload=p) for rid, k, p in self.events if rid == run_id]

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

    async def save_check(self, row: dict[str, Any]) -> None:
        self.checks[(UUID(row["run_id"]), row["source"])] = row

    async def regulation_index(self, organization_id: UUID) -> list[dict[str, Any]]:
        derived: dict[str, list[dict[str, str]]] = {}
        for v in self.versions.get(organization_id, []):
            entry = {"version_label": v.version_label, "role": v.role or ""}
            derived.setdefault(v.regulation, []).append(entry)
        return list(self.library.get(organization_id, [])) + [
            {"regulation": code, "versions": vs} for code, vs in sorted(derived.items())
        ]

    async def case_name(self, case_id: UUID) -> str | None:
        return self.case_names.get(case_id)

    async def case_kind(self, case_id: UUID) -> str | None:
        if case_id in self.case_kinds:
            return self.case_kinds[case_id]
        return "main" if case_id in self.cases or case_id in self.case_names else None

    async def store_case_file(self, row: dict[str, Any]) -> None:
        self.cases.setdefault(UUID(str(row["case_id"])), []).append(
            CaseFile.model_validate({**row, "id": uuid4(), "status": "parsed"})
        )

    async def organization_name(self, org: UUID) -> str | None:
        return self.organization_names.get(org)

    async def library_versions(self, org: UUID) -> list[LibraryVersion]:
        return sorted(self.versions.get(org, []), key=lambda v: (v.regulation, v.version_label))

    async def version_paragraphs(self, version_id: UUID) -> list[Paragraph]:
        return list(self.paragraphs.get(version_id, []))

    def search_store(self) -> "TextSearch":
        return TextSearch(self)

    def subgoal_library(self) -> Any:
        return self.subgoal

    async def add_requirements(self, rows: list[NewRequirement]) -> None:
        taken = {(r.run_id, r.ext_id) for r in self.requirements}
        for row in rows:
            if (row.run_id, row.ext_id) in taken:
                raise ValueError(f"duplicate key (run_id, ext_id) = {row.ext_id}")
            taken.add((row.run_id, row.ext_id))
        self.requirements += [Requirement(id=uuid4(), **r.model_dump()) for r in rows]

    async def run_requirements(self, run_id: UUID) -> list[Requirement]:
        rows = [r for r in self.requirements if r.run_id == run_id]
        return sorted(rows, key=lambda r: int(r.ext_id.partition("-")[2]))

    async def add_findings(self, run_id: UUID, findings: dict[str, list[dict[str, Any]]]) -> None:
        self.requirements = [
            r.model_copy(update={"findings": [*r.findings, *findings[r.ext_id]]})
            if r.run_id == run_id and r.ext_id in findings
            else r
            for r in self.requirements
        ]

    async def set_requirement_status(
        self,
        run_id: UUID,
        status: RequirementStatus,
        *,
        only_if: RequirementStatus,
        ext_ids: list[str] | None = None,
    ) -> int:
        moved = 0
        for i, r in enumerate(self.requirements):
            if r.run_id != run_id or r.status != only_if:
                continue
            if ext_ids is not None and r.ext_id not in ext_ids:
                continue
            self.requirements[i] = r.model_copy(update={"status": status})
            moved += 1
        return moved

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

    async def organization_model(self, org: UUID, process: str) -> str | None:
        return self.process_models.get((org, process))

    async def provider_key(self, org: UUID, provider: str) -> str | None:
        return self.keys.get((org, provider))

    async def provider_endpoint(self, org: UUID, provider: str) -> Endpoint | None:
        return self.endpoints.get((org, provider))

    async def organization_read_only(self, org: UUID) -> bool:
        return org in self.read_only

    async def month_cost(self, org: UUID) -> float:
        # As private.usage_entries: the ledger, plus runs.usage for a run with no ledger rows.
        metered = {r["run_id"] for r in self.usage_rows}
        recorded = sum(
            float(self.usage[rid].get("cost_usd") or 0)
            for rid, run in self.runs.items()
            if run.organization_id == org and rid in self.usage and str(rid) not in metered
        )
        ledger = sum(
            float(r["cost_usd"] or 0) for r in self.usage_rows if r["organization_id"] == str(org)
        )
        return self.spent.get(org, 0.0) + recorded + ledger

    async def record_usage(self, rows: list[dict[str, Any]]) -> None:
        self.usage_rows += rows

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


def seed_library(store: InMemoryRunStore, org: UUID = ORG) -> None:
    """Two made-up regulations, small enough to read in a test: four obligations in all, one of
    them in a paragraph the scripted check rejects (it calls itself obsolete)."""
    store.add_version(
        "UN R148",
        "00",
        [
            ("1", "1. Scope. This Regulation applies to signalling lamps.", 1),
            ("5.4.2", "5.4.2. The rear position lamp shall be visible from the rear.", 4),
            ("5.4.3", "5.4.3. The luminous intensity shall not exceed 30 cd.", 4),
            ("6.1", "6.1. This obsolete provision shall no longer be applied.", 20),
        ],
        org=org,
        heading="5. General specifications",
    )
    store.add_version(
        "UN R48",
        "06",
        [
            ("2.7", "2.7. Definitions: a lamp is a device.", 2),
            ("6.10.1", "6.10.1. Two rear position lamps must be fitted.", 30),
        ],
        org=org,
    )
    store.add_version(
        "UN R48",
        "07",
        [("6.10.1", "6.10.1. Two or four lamps must be fitted.", 31)],
        role="latest",
        org=org,
    )


CASE_TEXT = "# Rear lamp\nA red LED rear position lamp for vehicles of category M1."
TASK = "Write the requirements for this rear position lamp."


def case_run(store: InMemoryRunStore, task: str = TASK, org: UUID = ORG) -> UUID:
    """A queued run on a parsed case, with the made-up library: the normal way a run starts."""
    seed_library(store, org)
    case_id = store.add_parsed_case("dev-rear-lamp", CASE_TEXT, org)
    return store.add_run(task, org=org, case_id=case_id)


class TextSearch:
    """The two calls the library search makes when it searches (regulation_search.search), over
    the fake's paragraphs. Not PostgreSQL's ranking: a paragraph matches if it has any of the
    query's words, and more occurrences rank higher. Enough to test what the agent does with
    ranked hits; the SQL is tested in pgTAP (regulation_search_test.sql). No vectors: with no
    embedding key the agent searches text only, which is what this answers."""

    def __init__(self, store: InMemoryRunStore) -> None:
        self.store = store
        self.queries: list[str | None] = []

    async def organization_read_only(self, org: UUID) -> bool:
        return await self.store.organization_read_only(org)

    async def provider_key(self, org: UUID, provider: str) -> str | None:
        return None

    async def record_usage(self, rows: list[dict[str, Any]]) -> None:
        await self.store.record_usage(rows)

    async def organization_model(self, org: UUID, process: str) -> str | None:
        return await self.store.organization_model(org, process)

    async def project_scope(self, case_id: UUID) -> ProjectScope | None:
        chosen = self.store.case_choice.get(case_id)
        if chosen is None:
            return ProjectScope(all_regulations=True)
        versions = [v for vs in self.store.versions.values() for v in vs]
        return ProjectScope(
            all_regulations=False, version_ids=[v.id for v in versions if v.regulation in chosen]
        )

    # The indexer's half of SearchStore; a run never indexes.
    async def refresh_keys(self, org: UUID) -> int:
        raise NotImplementedError

    async def texts_to_embed(self, org: UUID, model: str, limit: int) -> list[tuple[str, str]]:
        raise NotImplementedError

    async def save_embeddings(
        self, org: UUID, model: str, rows: list[tuple[str, list[float]]]
    ) -> None:
        raise NotImplementedError

    async def prune_embeddings(self, org: UUID, model: str) -> int:
        raise NotImplementedError

    async def analyze(self) -> None:
        raise NotImplementedError

    async def versions_to_summarize(self, org: UUID) -> list[VersionToSummarize]:
        raise NotImplementedError

    async def download(self, path: str) -> bytes:
        raise NotImplementedError

    async def save_summary(
        self, version_id: UUID, summary: ScopeSummary, model: str, sha256: str
    ) -> None:
        raise NotImplementedError

    async def aclose(self) -> None:
        pass

    async def match(
        self,
        org: UUID,
        query: str | None,
        embedding: list[float] | None,
        model: str,
        version_ids: list[UUID] | None,
        k: int,
    ) -> list[Hit]:
        self.queries.append(query)
        words = {w.lower() for w in re.findall(r"\w+", query or "")}
        hits: list[Hit] = []
        for version in self.store.versions.get(org, []):
            if version_ids is not None and version.id not in version_ids:
                continue
            for p in self.store.paragraphs.get(version.id, []):
                haystack = f"{p.label or ''} {p.heading} {p.text}".lower()
                score = sum(haystack.count(w) for w in words)
                if score:
                    hits.append(
                        Hit(
                            paragraph_id=p.id,
                            version_id=version.id,
                            regulation_code=version.regulation,
                            version_label=version.version_label,
                            role=version.role,
                            label=p.label,
                            heading=p.heading,
                            kind=p.kind,
                            text=p.text,
                            page_start=p.page_start,
                            page_end=p.page_end,
                            score=float(score),
                            text_rank=1,
                        )
                    )
        return sorted(hits, key=lambda h: -h.score)[:k]


class InMemoryProjectStore:
    """What the assistant reads about a project (domain/assistant.py ProjectStore), over an
    InMemoryRunStore's cases and runs. The Supabase twin is domain/project_store.py, checked
    against the real schema in test_store_integration.py."""

    def __init__(self, store: InMemoryRunStore) -> None:
        self.store = store
        self.projects: dict[UUID, ProjectInfo] = {}
        self.case_project: dict[UUID, UUID] = {}
        self.scopes: dict[UUID, ProjectScope] = {}
        self.regulation_codes: dict[UUID, str] = {}
        self.closed = False

    def add_project(self, name: str, case_ids: Sequence[UUID] = (), org: UUID = ORG) -> UUID:
        project_id = uuid4()
        self.projects[project_id] = ProjectInfo(id=project_id, organization_id=org, name=name)
        for case_id in case_ids:
            self.case_project[case_id] = project_id
        return project_id

    async def project(self, project_id: UUID) -> ProjectInfo | None:
        return self.projects.get(project_id)

    async def project_cases(self, project_id: UUID) -> list[CaseSummary]:
        return [
            CaseSummary(
                id=case_id,
                name=self.store.case_names.get(case_id, str(case_id)),
                files=[
                    CaseFileSummary(filename=f.filename, format=f.format, status=f.status)
                    for f in self.store.cases.get(case_id, [])
                ],
            )
            for case_id, pid in self.case_project.items()
            if pid == project_id
        ]

    async def project_runs(self, project_id: UUID, limit: int) -> list[RunSummary]:
        runs = [
            RunSummary(
                id=r.id,
                case_id=r.case_id,
                status=r.status,
                model=self.store.models.get(r.id),
                created_at=r.updated_at,
                task=r.task,
                error=self.store.errors.get(r.id),
            )
            for r in self.store.runs.values()
            if r.case_id is not None and self.case_project.get(r.case_id) == project_id
        ]
        return sorted(runs, key=lambda r: r.created_at, reverse=True)[:limit]

    async def project_scope(self, project_id: UUID) -> ProjectScope:
        return self.scopes.get(project_id, ProjectScope(all_regulations=True))

    async def regulation_code(self, org: UUID, regulation_id: UUID) -> str | None:
        return self.regulation_codes.get(regulation_id)

    async def aclose(self) -> None:
        self.closed = True
