"""Search over the regulation library (docs/regulations-store.md, "Embeddings" and "Search"):
indexing a library (a vector per distinct paragraph text, a scope summary per version) and the
hybrid search that the agent's tools call.

Indexing runs in slices, like an import: each call works until its deadline and reports what is
left, so it fits a function call on Vercel and can be driven from the CLI or the web alike. Calling
it again is always safe: every step skips what is already done.

What this does NOT do: extract paragraphs (the extraction does, into regulation_paragraphs, before
this runs), write the per-paragraph AI context line (step 4 of the design, only if recall shows it
is needed), or rerank results with a second model (the agent's model reads the results itself).
"""

import io
import logging
import os
import time
from dataclasses import dataclass, field
from typing import Any, Literal, Protocol
from uuid import UUID

import httpx
from pydantic import BaseModel, Field
from pydantic_ai import Agent
from pypdf import PdfReader

from agent_service import metering, providers
from agent_service.metering import Credential, Meter
from agent_service.settings import Settings

log = logging.getLogger(__name__)

# The column is halfvec(1024) (migration 20261024200000): a vector of another length is refused by
# the database, so a model that ignores `dimensions` fails at the first batch, not at search time.
DIMENSIONS = 1024

EmbeddingProvider = Literal["openai", "openrouter"]

_EMBEDDING_URLS: dict[EmbeddingProvider, str] = {
    "openai": "https://api.openai.com/v1/embeddings",
    "openrouter": "https://openrouter.ai/api/v1/embeddings",
}
_KEY_ENV: dict[EmbeddingProvider, str] = {
    "openai": "OPENAI_API_KEY",
    "openrouter": "OPENROUTER_API_KEY",
}

# One request carries at most this many inputs and characters. OpenAI allows 2,048 inputs and
# 300,000 tokens per request; 400,000 characters is about 100,000 tokens, so a batch of long tables
# stays well under the token limit and one slow request does not eat the slice.
_MAX_INPUTS = 256
_MAX_CHARS = 400_000
# What one database round trip hands over. A write of 250 vectors is about 2.5 MB of JSON.
_FETCH = 500
_WRITE = 250


class EmbeddingError(Exception):
    """The embedding provider could not be reached, refused, or answered something unusable. The
    message never contains the key."""


@dataclass(frozen=True)
class EmbeddingModel:
    provider: EmbeddingProvider
    name: str
    dimensions: int = DIMENSIONS

    @classmethod
    def parse(cls, value: str) -> "EmbeddingModel":
        """ "openai:text-embedding-3-small" or "openrouter:openai/text-embedding-3-small"."""
        provider, sep, name = value.partition(":")
        if not sep or not name or provider not in _EMBEDDING_URLS:
            raise ValueError(
                f"Embedding model {value!r} is not 'openai:<model>' or 'openrouter:<model>'."
            )
        return cls(provider=provider, name=name)  # pyright: ignore[reportArgumentType]

    @property
    def key(self) -> str:
        # What the `model` column holds. The provider is part of it: the same model through
        # OpenRouter should give the same vectors (not tested), and until someone checks, vectors
        # from two routes are never compared.
        return f"{self.provider}:{self.name}@{self.dimensions}"


async def embed(
    http: httpx.AsyncClient,
    model: EmbeddingModel,
    api_key: str,
    texts: list[str],
    *,
    meter: Meter | None = None,
    process: metering.Process = "embedding",
    credential: Credential | None = None,
) -> list[list[float]]:
    """One request. The caller keeps `texts` within _MAX_INPUTS and _MAX_CHARS. With a meter, the
    tokens the provider reports are recorded once the vectors are known to be usable."""
    try:
        response = await http.post(
            _EMBEDDING_URLS[model.provider],
            headers={"Authorization": f"Bearer {api_key}"},
            json={
                "model": model.name,
                "input": texts,
                "dimensions": model.dimensions,
                "encoding_format": "float",
            },
            timeout=60,
        )
    except httpx.HTTPError as exc:
        reason = providers.scrub(f"{type(exc).__name__}: {exc}", api_key)[:200]
        raise EmbeddingError(f"Could not reach {model.provider} ({reason}).") from None
    if response.status_code in (401, 403):
        raise EmbeddingError(f"{model.provider} rejected the API key.")
    if response.is_error:
        detail = providers.scrub(response.text, api_key)[:300]
        raise EmbeddingError(f"{model.provider} answered {response.status_code}: {detail}")
    try:
        data: list[dict[str, Any]] = response.json()["data"]
        vectors = [row["embedding"] for row in sorted(data, key=lambda row: row["index"])]
    except (ValueError, KeyError, TypeError):
        raise EmbeddingError(f"{model.provider} answered in an unexpected format.") from None
    if len(vectors) != len(texts):
        raise EmbeddingError(f"Asked for {len(texts)} vectors, got {len(vectors)}.")
    if any(len(v) != model.dimensions for v in vectors):
        raise EmbeddingError(
            f"{model.name} did not return {model.dimensions} dimensions; it may not support "
            "shortening, and the database stores exactly that many."
        )
    if meter is not None:
        tokens = _prompt_tokens(response)
        meter.add(
            process,
            f"{model.provider}:{model.name}",
            credential or Credential.of(model.provider, None),
            input_tokens=tokens,
            cost=metering.embedding_cost(model.provider, model.name, tokens),
        )
    return vectors


def _prompt_tokens(response: httpx.Response) -> int:
    # OpenAI and OpenRouter both answer {"usage": {"prompt_tokens": n, "total_tokens": n}}. An
    # answer without it is still a request; it is recorded with 0 tokens rather than guessed.
    try:
        usage = response.json().get("usage") or {}
        return int(usage.get("prompt_tokens") or usage.get("total_tokens") or 0)
    except (ValueError, TypeError, AttributeError):
        return 0


def _batches(rows: list[tuple[str, str]]) -> list[list[tuple[str, str]]]:
    batches: list[list[tuple[str, str]]] = []
    current: list[tuple[str, str]] = []
    chars = 0
    for row in rows:
        if current and (len(current) >= _MAX_INPUTS or chars + len(row[1]) > _MAX_CHARS):
            batches.append(current)
            current, chars = [], 0
        current.append(row)
        chars += len(row[1])
    if current:
        batches.append(current)
    return batches


# ------------------------------------------------------------------------------------------
# Scope summaries
# ------------------------------------------------------------------------------------------


class ScopeSummary(BaseModel):
    summary: str = Field(
        description=(
            "At most 120 words: which products, devices or vehicle categories the regulation "
            "applies to, which aspects it governs (for example photometry, colour, installation, "
            "approval marking, test procedures), and what it explicitly excludes."
        )
    )
    keywords: list[str] = Field(
        description=(
            "5 to 20 short terms an engineer describing a component would use, including common "
            "names the regulation itself does not use (for example 'tail light' for 'rear position "
            "lamp'). No regulation numbers."
        )
    )


_SUMMARY_INSTRUCTIONS = (
    "You index vehicle regulations so that an engineer can tell, from a component description, "
    "which regulations might apply. You are given the opening pages of one regulation: its "
    "title, contents and scope. Describe only what those pages say; do not add requirements "
    "from memory. Write in English."
)

summary_agent = Agent(
    name="regulation-scope-summary",
    output_type=ScopeSummary,
    instructions=_SUMMARY_INSTRUCTIONS,
)

# The title, contents and scope are on the first pages: the contents of the longest regulations
# (R48, R10) run to four or five pages. 30,000 characters is about 8,000 tokens per call.
_SUMMARY_PAGES = 8
_SUMMARY_CHARS = 30_000
# What the database accepts (migration 20261024200000).
_SUMMARY_MAX_CHARS = 4000
_MAX_KEYWORDS = 40


def opening_text(pdf: bytes) -> str:
    reader = PdfReader(io.BytesIO(pdf))
    parts: list[str] = []
    for number, page in enumerate(reader.pages[:_SUMMARY_PAGES], start=1):
        parts.append(f"--- page {number} ---\n{page.extract_text() or ''}")
    return "\n".join(parts)[:_SUMMARY_CHARS]


# ------------------------------------------------------------------------------------------
# The database
# ------------------------------------------------------------------------------------------


class VersionToSummarize(BaseModel):
    id: UUID
    code: str
    title: str | None = None
    version_label: str
    pdf_path: str
    sha256: str


class Hit(BaseModel):
    """One search result: what a submission cites (regulation, version, label, page) and why it
    came back (its rank in each half; None where that half did not find it)."""

    paragraph_id: UUID
    version_id: UUID
    regulation_code: str
    version_label: str
    role: str | None = None
    label: str | None = None
    heading: str | None = None
    kind: str
    text: str
    page_start: int
    page_end: int
    score: float
    text_rank: int | None = None
    vector_rank: int | None = None
    similarity: float | None = None


@dataclass(frozen=True)
class ProjectScope:
    """Which regulations a case's project uses (projects.all_regulations, project_regulations)."""

    all_regulations: bool
    # The versions of the chosen regulations; ignored when all_regulations is true.
    version_ids: list[UUID] = field(default_factory=list)


class SearchStore(Protocol):
    async def record_usage(self, rows: list[dict[str, Any]]) -> None: ...
    async def provider_key(self, org: UUID, provider: str) -> str | None: ...
    async def project_scope(self, case_id: UUID) -> ProjectScope | None: ...
    async def organization_model(self, org: UUID, process: str) -> str | None: ...
    async def refresh_keys(self, org: UUID) -> int: ...
    async def texts_to_embed(self, org: UUID, model: str, limit: int) -> list[tuple[str, str]]: ...
    async def save_embeddings(
        self, org: UUID, model: str, rows: list[tuple[str, list[float]]]
    ) -> None: ...
    async def prune_embeddings(self, org: UUID, model: str) -> int: ...
    async def analyze(self) -> None: ...
    async def versions_to_summarize(self, org: UUID) -> list[VersionToSummarize]: ...
    async def download(self, path: str) -> bytes: ...
    async def save_summary(
        self, version_id: UUID, summary: ScopeSummary, model: str, sha256: str
    ) -> None: ...
    async def match(
        self,
        org: UUID,
        query: str | None,
        embedding: list[float] | None,
        model: str,
        version_ids: list[UUID] | None,
        k: int,
    ) -> list[Hit]: ...
    async def aclose(self) -> None: ...


# ------------------------------------------------------------------------------------------
# Indexing
# ------------------------------------------------------------------------------------------


@dataclass
class Progress:
    keys_changed: int = 0
    embedded: int = 0
    pruned: int = 0
    summarized: int = 0
    # True when nothing is left to do for vectors and summaries alike.
    done: bool = False
    # Why a part was skipped or stopped; the rest of the slice still ran.
    notes: list[str] = field(default_factory=list)


async def embedding_model_for(store: SearchStore, settings: Settings, org: UUID) -> EmbeddingModel:
    """The organisation's choice (Admin, organization_models, SYS-33), else EMBEDDING_MODEL.

    Vectors are kept per organisation and model, so a change does not delete the old ones: the
    indexer computes the new model's vectors, and until it has, a search with the new model finds
    paragraphs by full text only. Changing back reuses the old vectors."""
    return EmbeddingModel.parse(
        await store.organization_model(org, "embedding") or settings.embedding_model
    )


async def _embedding_key(
    store: SearchStore, org: UUID, model: EmbeddingModel
) -> tuple[str | None, Credential]:
    """The organisation's own key first, as for runs, then the deployment's environment; and
    which of the two it was, for the usage page."""
    if own := await store.provider_key(org, model.provider):
        return own, Credential.of(model.provider, own)
    return os.environ.get(_KEY_ENV[model.provider]), Credential(
        "deployment", _KEY_ENV[model.provider]
    )


async def index_library(
    store: SearchStore,
    http: httpx.AsyncClient,
    settings: Settings,
    org: UUID,
    *,
    slice_s: float | None = None,
) -> Progress:
    deadline = time.monotonic() + (settings.index_slice_s if slice_s is None else slice_s)
    progress = Progress()
    meter = Meter(org)
    try:
        vectors_done = await _index_vectors(store, http, settings, org, deadline, progress, meter)
        summaries_done = await _summarize(store, settings, org, deadline, progress, meter)
    finally:
        # Also when a provider refuses halfway: the batches before it were billed.
        await meter.flush(store)
    progress.done = vectors_done and summaries_done
    return progress


async def _index_vectors(
    store: SearchStore,
    http: httpx.AsyncClient,
    settings: Settings,
    org: UUID,
    deadline: float,
    progress: Progress,
    meter: Meter,
) -> bool:
    model = await embedding_model_for(store, settings, org)
    api_key, credential = await _embedding_key(store, org, model)
    if not api_key:
        progress.notes.append(
            f"No {model.provider} key: connect one in Settings or set "
            f"{_KEY_ENV[model.provider]}. Paragraphs are found by full text only until then."
        )
        return False
    # Every slice, not only the first: the extraction may have run since the last one, and on an
    # indexed library this is one statement that changes nothing (about 2 s for 50,000 rows).
    progress.keys_changed = await store.refresh_keys(org)
    if progress.keys_changed:
        # Thousands of new rows and no statistics yet make the planner pick plans that take
        # minutes (migration 20261024210000, analyze_regulation_search).
        await store.analyze()
    while True:
        if time.monotonic() >= deadline:
            return False
        rows = await store.texts_to_embed(org, model.key, _FETCH)
        if not rows:
            break
        for batch in _batches(rows):
            vectors = await embed(
                http,
                model,
                api_key,
                [text for _, text in batch],
                meter=meter,
                credential=credential,
            )
            pairs = [(sha, vec) for (sha, _), vec in zip(batch, vectors, strict=True)]
            for start in range(0, len(pairs), _WRITE):
                await store.save_embeddings(org, model.key, pairs[start : start + _WRITE])
            progress.embedded += len(batch)
            if time.monotonic() >= deadline:
                return False
    # Last, so a slice that runs out of time never spends it deleting. A pruned vector is never
    # one a paragraph still points to, so the order does not matter for correctness.
    progress.pruned = await store.prune_embeddings(org, model.key)
    if progress.embedded or progress.pruned:
        await store.analyze()
    return True


async def _summarize(
    store: SearchStore,
    settings: Settings,
    org: UUID,
    deadline: float,
    progress: Progress,
    meter: Meter,
) -> bool:
    name = (
        await store.organization_model(org, "summary")
        or settings.summary_model
        or settings.agent_model
    )
    if name == "scripted":
        progress.notes.append(
            "No summaries: the model is 'scripted'. Set SUMMARY_MODEL or AGENT_MODEL to a real one."
        )
        return False
    provider = providers.provider_of(name)
    api_key = await store.provider_key(org, provider) if provider else None
    model = metering.metered(
        providers.build_model(name, api_key),
        meter,
        "summary",
        name,
        Credential.of(provider or "", api_key),
    )
    unread = 0
    for version in await store.versions_to_summarize(org):
        if time.monotonic() >= deadline:
            return False
        try:
            text = opening_text(await store.download(version.pdf_path))
        except Exception as exc:
            # One unreadable PDF must not stop the other 91; it stays in the list and is tried
            # again on the next slice.
            log.exception("Could not read %s %s", version.code, version.version_label)
            progress.notes.append(
                f"{version.code} {version.version_label}: PDF not read ({type(exc).__name__})."
            )
            unread += 1
            continue
        heading = f"{version.code}, version {version.version_label}"
        if version.title:
            heading += f": {version.title}"
        result = await summary_agent.run(f"{heading}\n\n{text}", model=model)
        summary = result.output
        summary.summary = summary.summary[:_SUMMARY_MAX_CHARS]
        summary.keywords = [k[:100] for k in summary.keywords[:_MAX_KEYWORDS]]
        await store.save_summary(version.id, summary, name, version.sha256)
        progress.summarized += 1
    return unread == 0


# ------------------------------------------------------------------------------------------
# Searching
# ------------------------------------------------------------------------------------------

SearchMode = Literal["hybrid", "text", "vector"]


def within_scope(requested: list[UUID] | None, scope: ProjectScope | None) -> list[UUID] | None:
    """The versions a search may return: what the caller asked for, cut to the project's choice.

    None means the whole library. An empty list means nothing, on purpose: a project narrowed to
    regulations that have no stored version yet must find nothing rather than everything."""
    if scope is None or scope.all_regulations:
        return requested
    allowed = set(scope.version_ids)
    if requested is None:
        return list(scope.version_ids)
    return [v for v in requested if v in allowed]


async def search(
    store: SearchStore,
    http: httpx.AsyncClient,
    settings: Settings,
    org: UUID,
    query: str,
    *,
    version_ids: list[UUID] | None = None,
    k: int = 20,
    mode: SearchMode = "hybrid",
    case_id: UUID | None = None,
    meter: Meter | None = None,
) -> list[Hit]:
    """The paragraphs that best match `query`, best first. "text" and "vector" switch one half
    off, which is how the recall of each is compared with both.

    With `case_id`, only the regulations the case's project uses (SYS-32, IF-3 as agreed on #24
    by Ramón and Clemente): the writer passes the run's case, and a project that left a
    regulation out never gets a paragraph of it back, whatever the caller asked for.

    The query's vector is billed to `meter` (a run's) when given; without one it is written to the
    store at once, so a search from the command line is counted too."""
    if case_id is not None:
        version_ids = within_scope(version_ids, await store.project_scope(case_id))
    model = await embedding_model_for(store, settings, org)
    embedding: list[float] | None = None
    if mode != "text":
        api_key, credential = await _embedding_key(store, org, model)
        if not api_key:
            raise EmbeddingError(
                f"No {model.provider} key to embed the query; use mode='text' or connect one."
            )
        own = meter or Meter(org)
        # Same truncation as the stored inputs (regulation_embedding_input): a longer query would
        # be refused by the provider.
        embedding = (
            await embed(
                http,
                model,
                api_key,
                [query[:24000]],
                meter=own,
                process="search",
                credential=credential,
            )
        )[0]
        if meter is None:
            await own.flush(store)
    return await store.match(
        org, query if mode != "vector" else None, embedding, model.key, version_ids, k
    )
