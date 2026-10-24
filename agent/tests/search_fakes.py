"""An in-memory SearchStore. It plays the database's part only as far as the indexer sees it: texts
without a vector for the model, versions whose summary is missing or stale. The SQL itself (keys,
search, pruning) is tested in supabase/tests/regulation_search_test.sql."""

import hashlib
from dataclasses import dataclass, field
from uuid import UUID, uuid4

from agent_service.domain.regulation_search import Hit, ScopeSummary, VersionToSummarize

ORG = UUID("00000000-0000-4000-8000-000000000001")


def sha(text: str) -> str:
    return hashlib.sha256(text.encode()).hexdigest()


@dataclass
class InMemorySearchStore:
    # The embedding inputs of the organisation's paragraphs, as regulation_texts_to_embed sees them.
    inputs: list[str] = field(default_factory=list)
    vectors: dict[tuple[str, str], list[float]] = field(default_factory=dict)
    versions: list[VersionToSummarize] = field(default_factory=list)
    # version id -> (summary, model, sha256 of the PDF it was written from)
    summaries: dict[UUID, tuple[ScopeSummary, str, str]] = field(default_factory=dict)
    objects: dict[str, bytes] = field(default_factory=dict)
    keys: dict[str, str] = field(default_factory=dict)
    # What Admin stored per process (organization_models).
    models: dict[str, str] = field(default_factory=dict)
    refreshes: int = 0
    analyses: int = 0
    matches: list[dict[str, object]] = field(default_factory=list)
    closed: bool = False

    def add_version(self, code: str, label: str, pdf: bytes) -> VersionToSummarize:
        version = VersionToSummarize(
            id=uuid4(),
            code=code,
            title=None,
            version_label=label,
            pdf_path=f"{ORG}/{code.replace(' ', '_')}/{label}/x.pdf",
            sha256=hashlib.sha256(pdf).hexdigest(),
        )
        self.versions.append(version)
        self.objects[version.pdf_path] = pdf
        return version

    async def provider_key(self, org: UUID, provider: str) -> str | None:
        return self.keys.get(provider)

    async def organization_model(self, org: UUID, process: str) -> str | None:
        return self.models.get(process)

    async def refresh_keys(self, org: UUID) -> int:
        self.refreshes += 1
        return 0

    async def texts_to_embed(self, org: UUID, model: str, limit: int) -> list[tuple[str, str]]:
        distinct = sorted({(sha(t), t) for t in self.inputs})
        return [(h, t) for h, t in distinct if (model, h) not in self.vectors][:limit]

    async def save_embeddings(
        self, org: UUID, model: str, rows: list[tuple[str, list[float]]]
    ) -> None:
        for h, vec in rows:
            self.vectors.setdefault((model, h), vec)

    async def prune_embeddings(self, org: UUID, model: str) -> int:
        live = {sha(t) for t in self.inputs}
        dead = [k for k in self.vectors if k[0] == model and k[1] not in live]
        for k in dead:
            del self.vectors[k]
        return len(dead)

    async def analyze(self) -> None:
        self.analyses += 1

    async def versions_to_summarize(self, org: UUID) -> list[VersionToSummarize]:
        return [
            v
            for v in self.versions
            if v.id not in self.summaries or self.summaries[v.id][2] != v.sha256
        ]

    async def download(self, path: str) -> bytes:
        return self.objects[path]

    async def save_summary(
        self, version_id: UUID, summary: ScopeSummary, model: str, sha256: str
    ) -> None:
        self.summaries[version_id] = (summary, model, sha256)

    async def match(
        self,
        org: UUID,
        query: str | None,
        embedding: list[float] | None,
        model: str,
        version_ids: list[UUID] | None,
        k: int,
    ) -> list[Hit]:
        self.matches.append(
            {"query": query, "embedding": embedding, "model": model, "versions": version_ids}
        )
        return []

    async def aclose(self) -> None:
        self.closed = True
