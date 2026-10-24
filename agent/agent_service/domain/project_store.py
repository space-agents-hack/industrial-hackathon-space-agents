"""What the assistant (domain/assistant.py) reads about a project in Supabase, with the secret key.
The in-memory twin for unit tests is in tests/fakes.py (InMemoryProjectStore). Read only: the
assistant writes nothing."""

from typing import Any, cast
from uuid import UUID

from supabase import AsyncClient, acreate_client

from agent_service.domain.assistant import CaseFileSummary, CaseSummary, ProjectInfo, RunSummary
from agent_service.domain.regulation_search import ProjectScope


def _rows(response: Any) -> list[dict[str, Any]]:
    return cast(list[dict[str, Any]], response.data)


class SupabaseProjectStore:
    def __init__(self, client: AsyncClient) -> None:
        self._db = client

    @classmethod
    async def connect(cls, url: str, secret_key: str) -> "SupabaseProjectStore":
        return cls(await acreate_client(url, secret_key))

    async def project(self, project_id: UUID) -> ProjectInfo | None:
        res = await (
            self._db.table("projects")
            .select("id, organization_id, name, all_regulations")
            .eq("id", str(project_id))
            .limit(1)
            .execute()
        )
        rows = _rows(res)
        return ProjectInfo.model_validate(rows[0]) if rows else None

    async def project_cases(self, project_id: UUID) -> list[CaseSummary]:
        res = await (
            self._db.table("cases")
            .select("id, name, case_files(filename, format, status, pages, position)")
            .eq("project_id", str(project_id))
            .order("created_at")
            .execute()
        )
        cases: list[CaseSummary] = []
        for row in _rows(res):
            files = sorted(row.get("case_files") or [], key=lambda f: f.get("position") or 0)
            cases.append(
                CaseSummary(
                    id=row["id"],
                    name=row["name"],
                    files=[CaseFileSummary.model_validate(f) for f in files],
                )
            )
        return cases

    async def project_runs(self, project_id: UUID, limit: int) -> list[RunSummary]:
        # Every run has a case since SYS-38; the inner join keeps the runs of this project's cases.
        res = await (
            self._db.table("runs")
            .select("id, case_id, status, model, created_at, task, error, cases!inner(project_id)")
            .eq("cases.project_id", str(project_id))
            .order("created_at", desc=True)
            .limit(limit)
            .execute()
        )
        return [RunSummary.model_validate(r) for r in _rows(res)]

    async def project_scope(self, project_id: UUID) -> ProjectScope:
        # The same reading as SupabaseSearchStore.project_scope, from the project instead of a case.
        res = await (
            self._db.table("projects")
            .select("all_regulations, project_regulations(regulation_id)")
            .eq("id", str(project_id))
            .limit(1)
            .execute()
        )
        rows = _rows(res)
        if not rows or rows[0].get("all_regulations", True):
            return ProjectScope(all_regulations=True)
        chosen = [r["regulation_id"] for r in rows[0].get("project_regulations") or []]
        if not chosen:
            return ProjectScope(all_regulations=False)
        versions = await (
            self._db.table("regulation_versions")
            .select("id")
            .in_("regulation_id", chosen)
            .execute()
        )
        return ProjectScope(
            all_regulations=False, version_ids=[UUID(r["id"]) for r in _rows(versions)]
        )

    async def regulation_code(self, org: UUID, regulation_id: UUID) -> str | None:
        res = await (
            self._db.table("regulations")
            .select("code")
            .eq("id", str(regulation_id))
            .eq("organization_id", str(org))
            .limit(1)
            .execute()
        )
        rows = _rows(res)
        return str(rows[0]["code"]) if rows else None

    async def aclose(self) -> None:
        await self._db.postgrest.aclose()
