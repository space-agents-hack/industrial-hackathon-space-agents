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

import asyncio
import io
import logging
import os
import re
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
from agent_service.slices import each_until

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
# A write of 250 vectors is about 2.5 MB of JSON.
_WRITE = 250


class EmbeddingError(Exception):
    """The embedding provider could not be reached, refused, or answered something unusable. The
    message never contains the key."""


class EmbeddingBusy(EmbeddingError):
    """The provider asked to slow down (429) or failed on its side (5xx): worth asking again."""

    def __init__(self, message: str, retry_after_s: float | None) -> None:
        super().__init__(message)
        self.retry_after_s = retry_after_s


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
    if response.status_code == 429 or response.status_code >= 500:
        detail = providers.scrub(response.text, api_key)[:300]
        raise EmbeddingBusy(
            f"{model.provider} answered {response.status_code}: {detail}",
            _retry_after(response),
        )
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


def _retry_after(response: httpx.Response) -> float | None:
    try:
        return float(response.headers["retry-after"])
    except (KeyError, ValueError):
        return None


def _prompt_tokens(response: httpx.Response) -> int:
    # OpenAI and OpenRouter both answer {"usage": {"prompt_tokens": n, "total_tokens": n}}. An
    # answer without it is still a request; it is recorded with 0 tokens rather than guessed.
    try:
        usage = response.json().get("usage") or {}
        return int(usage.get("prompt_tokens") or usage.get("total_tokens") or 0)
    except (ValueError, TypeError, AttributeError):
        return 0


# OpenAI's answer when one input is over the model's 8,192 tokens: "Invalid 'input[122]': maximum
# input length is 8192 tokens." The database cuts inputs at 24,000 characters, about 6,000 tokens of
# prose, but a dense table of numbers and symbols tokenises at closer to 2 characters a token: in
# production one such paragraph stopped the whole library's indexing (#37).
_TOO_LONG = re.compile(r"input\[(\d+)\]'?: maximum input length")
# Each retry halves the input it names; past this a paragraph is not worth more requests.
_MIN_INPUT_CHARS = 1000
# A busy provider is asked again this many times, waiting what it says or 2, 4, 8 s. Several
# requests at once (#43) make a 429 likely on a low tier; failing the slice for it would lose more
# time than the wait.
_BUSY_RETRIES = 3
_MAX_WAIT_S = 30.0


async def embed_fitting(
    http: httpx.AsyncClient,
    model: EmbeddingModel,
    api_key: str,
    texts: list[str],
    *,
    meter: Meter | None = None,
    credential: Credential | None = None,
) -> list[list[float]]:
    """`embed`, shortening an input the provider says is too long and asking again. The vector is
    then of the input's first part; its key is still the full input's, so the paragraph is not
    embedded again on every slice. A refused request is not billed."""
    texts = list(texts)
    busy = 0
    while True:
        try:
            return await embed(http, model, api_key, texts, meter=meter, credential=credential)
        except EmbeddingBusy as exc:
            busy += 1
            if busy > _BUSY_RETRIES:
                raise
            wait = 2.0**busy if exc.retry_after_s is None else exc.retry_after_s
            wait = min(wait, _MAX_WAIT_S)
            log.warning("%s; asking again in %.0f s", exc, wait)
            await asyncio.sleep(wait)
        except EmbeddingError as exc:
            match = _TOO_LONG.search(str(exc))
            i = int(match.group(1)) if match else -1
            if not 0 <= i < len(texts) or len(texts[i]) < _MIN_INPUT_CHARS:
                raise
            log.warning("Embedding input %d of %d chars is too long; halving it", i, len(texts[i]))
            texts[i] = texts[i][: len(texts[i]) // 2]


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
            "applies to, which aspects it governs (for example performance limits, installation, "
            "approval marking, test procedures), and what it explicitly excludes."
        )
    )
    keywords: list[str] = Field(
        description=(
            "5 to 20 short terms an engineer describing a component would use, including the "
            "everyday names of things the regulation names formally. No regulation numbers."
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
        # Side by side (#43): they write different tables (regulation_embeddings and
        # regulation_versions) and wait on different providers. One after the other, summaries
        # started only once every vector was written: production had 16,256 vectors and 0 of 92
        # summaries after two slices. Both run to the end, so a refused embedding key does not
        # throw away the summaries written meanwhile, and the first error is raised after.
        vectors_done, summaries_done = await asyncio.gather(
            _index_vectors(store, http, settings, org, deadline, progress, meter),
            _summarize(store, settings, org, deadline, progress, meter),
            return_exceptions=True,
        )
    finally:
        # Also when a provider refuses halfway: the batches before it were billed.
        await meter.flush(store)
    for outcome in (vectors_done, summaries_done):
        if isinstance(outcome, BaseException):
            raise outcome
    progress.done = vectors_done is True and summaries_done is True
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
            f"No {model.provider} key: connect one in Admin, Providers, or set "
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

    async def embed_batch(batch: list[tuple[str, str]]) -> bool:
        vectors = await embed_fitting(
            http, model, api_key, [text for _, text in batch], meter=meter, credential=credential
        )
        pairs = [(sha, vec) for (sha, _), vec in zip(batch, vectors, strict=True)]
        for start in range(0, len(pairs), _WRITE):
            await store.save_embeddings(org, model.key, pairs[start : start + _WRITE])
        progress.embedded += len(batch)
        return True

    # One fetch per round, a full request for each lane: the texts still to embed are the ones
    # without a vector, so the next fetch has to wait for this round's writes or it would hand out
    # the same texts again.
    lanes = max(settings.embedding_concurrency, 1)
    while True:
        if time.monotonic() >= deadline:
            return False
        rows = await store.texts_to_embed(org, model.key, _MAX_INPUTS * lanes)
        if not rows:
            break
        if not await each_until(_batches(rows), embed_batch, limit=lanes, deadline=deadline):
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
    name = (await store.organization_model(org, "summary") or settings.summary_model).strip()
    if name in ("", "scripted"):
        progress.notes.append(
            "No summaries: the summary model is 'scripted'. Choose one in Admin, Models, or set "
            "SUMMARY_MODEL."
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
    stopped = False

    async def summarize_one(version: VersionToSummarize) -> bool:
        nonlocal unread, stopped
        try:
            # In a thread: reading a PDF is CPU work, and the vectors run in this same loop.
            text = await asyncio.to_thread(opening_text, await store.download(version.pdf_path))
        except Exception as exc:
            # One unreadable PDF must not stop the other 91; it stays in the list and is tried
            # again on the next slice.
            log.exception("Could not read %s %s", version.code, version.version_label)
            progress.notes.append(
                f"{version.code} {version.version_label}: PDF not read ({type(exc).__name__})."
            )
            unread += 1
            return True
        heading = f"{version.code}, version {version.version_label}"
        if version.title:
            heading += f": {version.title}"
        try:
            result = await summary_agent.run(f"{heading}\n\n{text}", model=model)
        except Exception as exc:
            # A missing or refused key fails every version the same way: say it once and stop,
            # so the vectors written in this slice still count and the page shows why (#37).
            # Once: the calls already in flight fail the same way.
            log.exception("Summary of %s %s failed", version.code, version.version_label)
            if not stopped:
                stopped = True
                reason = providers.scrub(f"{type(exc).__name__}: {exc}", api_key)[:300]
                progress.notes.append(f"Summaries stopped at {version.code} with {name}: {reason}")
            return False
        summary = result.output
        summary.summary = summary.summary[:_SUMMARY_MAX_CHARS]
        summary.keywords = [k[:100] for k in summary.keywords[:_MAX_KEYWORDS]]
        await store.save_summary(version.id, summary, name, version.sha256)
        progress.summarized += 1
        return True

    complete = await each_until(
        await store.versions_to_summarize(org),
        summarize_one,
        limit=settings.summary_concurrency,
        deadline=deadline,
    )
    return complete and unread == 0


# ------------------------------------------------------------------------------------------
# Searching
# ------------------------------------------------------------------------------------------

SearchMode = Literal["hybrid", "text", "vector"]

# What a person reads when a search could not use vectors (#37). In production every search
# matched words only for hours and nothing said so: the library had never been indexed.
WORDS_ONLY = (
    "Search matched words only ({reason}): a paragraph worded differently from the query is not "
    "found. An admin indexes the library on the Regulations page."
)
NOT_INDEXED = "the regulations searched have no vectors yet"


def words_only(hits: list[Hit]) -> bool:
    """True when the vector half of a hybrid search contributed nothing. With any vector in the
    searched versions it always returns its nearest paragraphs, which fusion ranks next to the best
    word matches, so a page of results without one means those versions have no vectors."""
    return all(h.vector_rank is None for h in hits)


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
            # Read by a person under a word-only search (WORDS_ONLY); a caller that wants words
            # only passes mode="text".
            raise EmbeddingError(f"no {model.provider} key is connected to embed the query")
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
