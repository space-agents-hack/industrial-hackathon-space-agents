"""Search over the regulation library in Supabase: the functions of migration 20261024200000 and
the PDFs in the bucket. The in-memory twin for unit tests is tests/search_fakes.py; the SQL itself
is tested by supabase/tests/regulation_search_test.sql."""

from datetime import UTC, datetime
from typing import Any, cast
from uuid import UUID

from postgrest.exceptions import APIError
from postgrest.types import ReturnMethod
from supabase import AsyncClient, acreate_client

from agent_service.domain.regulation_search import (
    Hit,
    ProjectScope,
    ScopeSummary,
    SearchTimeout,
    VersionToSummarize,
)
from agent_service.domain.regulations import BUCKET


def _rows(response: Any) -> list[dict[str, Any]]:
    return cast(list[dict[str, Any]], response.data)


def vector_literal(vector: list[float]) -> str:
    # pgvector's text form. Sent as a string rather than a JSON array so the cast is pgvector's own
    # parser on every path (table insert and function argument alike). Six significant digits:
    # halfvec keeps about three, so more would only make the request larger.
    return "[" + ",".join(f"{x:.6g}" for x in vector) + "]"


# Paragraph keys per call of add_regulation_embedding_keys (migration 20261024330000).
_KEY_BATCH = 1000


class SupabaseSearchStore:
    """With the secret key, which bypasses RLS: only the agent writes vectors and summaries, and
    the search functions are granted to the service role alone."""

    def __init__(self, client: AsyncClient) -> None:
        self._db = client

    @classmethod
    async def connect(cls, url: str, secret_key: str) -> "SupabaseSearchStore":
        return cls(await acreate_client(url, secret_key))

    async def record_usage(self, rows: list[dict[str, Any]]) -> None:
        await self._db.table("model_usage").insert(rows, returning=ReturnMethod.minimal).execute()

    async def organizations(self, limit: int) -> list[UUID]:
        res = await self._db.table("organizations").select("id").limit(limit).execute()
        return [UUID(r["id"]) for r in _rows(res)]

    async def provider_key(self, org: UUID, provider: str) -> str | None:
        res = await self._db.rpc(
            "read_provider_key", {"org": str(org), "key_provider": provider}
        ).execute()
        return res.data if isinstance(res.data, str) and res.data else None

    async def organization_model(self, org: UUID, process: str) -> str | None:
        res = (
            await self._db.table("organization_models")
            .select("model")
            .eq("organization_id", str(org))
            .eq("process", process)
            .limit(1)
            .execute()
        )
        rows = _rows(res)
        model = rows[0].get("model") if rows else None
        return model if isinstance(model, str) else None

    async def project_scope(self, case_id: UUID) -> ProjectScope | None:
        res = await (
            self._db.table("cases")
            .select("projects(all_regulations, project_regulations(regulation_id))")
            .eq("id", str(case_id))
            .limit(1)
            .execute()
        )
        rows = _rows(res)
        project = rows[0].get("projects") if rows else None
        if not isinstance(project, dict):
            return None
        if project.get("all_regulations", True):
            return ProjectScope(all_regulations=True)
        chosen = [r["regulation_id"] for r in project.get("project_regulations") or []]
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

    async def refresh_keys(self, org: UUID) -> int:
        # In batches: one statement over the whole library was cancelled by the hosted database's
        # 8 s statement timeout, so production could never be indexed (#41): hashing its 48,487
        # paragraphs took about 25 s there. A batch of 1,000 is about 0.5 s at that speed; on an
        # indexed library the first call adds nothing and ends it.
        added = 0
        while True:
            res = await self._db.rpc(
                "add_regulation_embedding_keys",
                {"p_organization_id": str(org), "p_limit": _KEY_BATCH},
            ).execute()
            n = int(cast(Any, res.data) or 0)
            added += n
            if n < _KEY_BATCH:
                return added

    async def texts_to_embed(self, org: UUID, model: str, limit: int) -> list[tuple[str, str]]:
        res = await self._db.rpc(
            "regulation_texts_to_embed",
            {"p_organization_id": str(org), "p_model": model, "p_limit": limit},
        ).execute()
        return [(r["input_sha256"], r["input"]) for r in _rows(res)]

    async def save_embeddings(
        self, org: UUID, model: str, rows: list[tuple[str, list[float]]]
    ) -> None:
        # ignore_duplicates: two slices running at once embed the same text twice; the first
        # write wins and the second is a no-op instead of an error.
        await (
            self._db.table("regulation_embeddings")
            .upsert(
                [
                    {
                        "organization_id": str(org),
                        "model": model,
                        "input_sha256": sha,
                        "embedding": vector_literal(vec),
                    }
                    for sha, vec in rows
                ],
                on_conflict="organization_id,model,input_sha256",
                ignore_duplicates=True,
                returning=ReturnMethod.minimal,
            )
            .execute()
        )

    async def prune_embeddings(self, org: UUID, model: str) -> int:
        res = await self._db.rpc(
            "prune_regulation_embeddings", {"p_organization_id": str(org), "p_model": model}
        ).execute()
        return int(cast(Any, res.data) or 0)

    async def analyze(self) -> None:
        await self._db.rpc("analyze_regulation_search", {}).execute()

    async def versions_to_summarize(self, org: UUID) -> list[VersionToSummarize]:
        # All versions and the filter here: PostgREST cannot compare two columns, and a library is
        # about a hundred rows.
        res = await (
            self._db.table("regulation_versions")
            .select("id, version_label, pdf_path, sha256, summary_sha256, regulations(code, title)")
            .eq("organization_id", str(org))
            .order("pdf_path")
            .execute()
        )
        return [
            VersionToSummarize(
                id=r["id"],
                code=r["regulations"]["code"],
                title=r["regulations"]["title"],
                version_label=r["version_label"],
                pdf_path=r["pdf_path"],
                sha256=r["sha256"],
            )
            for r in _rows(res)
            if r["summary_sha256"] != r["sha256"]
        ]

    async def download(self, path: str) -> bytes:
        return await self._db.storage.from_(BUCKET).download(path)

    async def save_summary(
        self, version_id: UUID, summary: ScopeSummary, model: str, sha256: str
    ) -> None:
        await (
            self._db.table("regulation_versions")
            .update(
                {
                    "scope_summary": summary.summary,
                    "scope_keywords": summary.keywords,
                    "summary_model": model,
                    "summary_sha256": sha256,
                    "summarized_at": datetime.now(UTC).isoformat(),
                }
            )
            .eq("id", str(version_id))
            .execute()
        )

    async def match(
        self,
        org: UUID,
        query: str | None,
        embedding: list[float] | None,
        model: str,
        version_ids: list[UUID] | None,
        k: int,
    ) -> list[Hit]:
        try:
            res = await self._db.rpc(
                "match_regulation_paragraphs",
                {
                    "p_organization_id": str(org),
                    "p_query": query,
                    "p_query_embedding": vector_literal(embedding) if embedding else None,
                    "p_model": model,
                    "p_version_ids": [str(v) for v in version_ids] if version_ids else None,
                    "p_k": k,
                },
            ).execute()
        except APIError as exc:
            # 57014: cancelled by the statement timeout. The search decides what to do with it.
            if exc.code == "57014":
                raise SearchTimeout(exc.message) from exc
            raise
        return [Hit.model_validate(r) for r in _rows(res)]

    async def aclose(self) -> None:
        await self._db.postgrest.aclose()
