"""Indexing and searching the regulation library, without a database or a provider: the embedding
API is httpx.MockTransport, the summary model is pydantic-ai's TestModel, and the store is
tests/search_fakes.py. The PDFs are made up here, not challenge material."""

import asyncio
import json
from collections.abc import Iterator
from typing import Any
from uuid import uuid4

import httpx
import pytest
from fastapi.testclient import TestClient
from pydantic_ai.models.function import FunctionModel
from pydantic_ai.models.test import TestModel

from agent_service.api import app, get_download_client, get_search_store
from agent_service.domain import regulation_search
from agent_service.domain.regulation_search import (
    DIMENSIONS,
    EmbeddingError,
    EmbeddingModel,
    ProjectScope,
    _batches,  # pyright: ignore[reportPrivateUsage]
    embed,
    index_library,
    opening_text,
    search,
)
from agent_service.domain.search_store import vector_literal
from agent_service.settings import Settings, get_settings
from tests.search_fakes import ORG, InMemorySearchStore

pytestmark = pytest.mark.anyio

AUTH = {"Authorization": "Bearer test-secret"}
KEY = "sk-test-not-a-real-key"
MODEL = EmbeddingModel.parse("openai:text-embedding-3-small")


def text_pdf(*pages: str) -> bytes:
    """A real PDF with one line of text per page, small enough to write by hand."""
    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"",  # the page tree, filled in below once the page numbers are known
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ]
    kids = []
    for text in pages:
        stream = f"BT /F1 12 Tf 72 720 Td ({text}) Tj ET".encode()
        objects.append(b"<< /Length %d >>\nstream\n%s\nendstream" % (len(stream), stream))
        content = len(objects)
        objects.append(
            b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] "
            b"/Resources << /Font << /F1 3 0 R >> >> /Contents %d 0 R >>" % content
        )
        kids.append(b"%d 0 R" % len(objects))
    objects[1] = b"<< /Type /Pages /Kids [%s] /Count %d >>" % (b" ".join(kids), len(kids))
    out = bytearray(b"%PDF-1.4\n")
    offsets = []
    for number, body in enumerate(objects, start=1):
        offsets.append(len(out))
        out += b"%d 0 obj\n%s\nendobj\n" % (number, body)
    xref = len(out)
    out += b"xref\n0 %d\n0000000000 65535 f \n" % (len(objects) + 1)
    out += b"".join(b"%010d 00000 n \n" % o for o in offsets)
    out += b"trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (
        len(objects) + 1,
        xref,
    )
    return bytes(out)


class Provider:
    """The embeddings endpoint: one vector per input, recording what it was sent."""

    def __init__(self, *, status: int = 200, dimensions: int = DIMENSIONS) -> None:
        self.requests: list[dict[str, Any]] = []
        self.status = status
        self.dimensions = dimensions

    def handle(self, request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        self.requests.append({"url": str(request.url), "headers": request.headers, "body": body})
        if self.status != 200:
            return httpx.Response(self.status, text=f"refused key {KEY}")
        data = [
            {"index": i, "embedding": [float(i)] * self.dimensions}
            for i in range(len(body["input"]))
        ]
        # Out of order on purpose: the API documents `index`, not the order of the list.
        return httpx.Response(200, json={"data": list(reversed(data))})

    @property
    def client(self) -> httpx.AsyncClient:
        return httpx.AsyncClient(transport=httpx.MockTransport(self.handle))


@pytest.fixture
def index_settings(settings: Settings) -> Settings:
    return settings.model_copy(update={"summary_model": "test", "index_slice_s": 60})


@pytest.fixture
def summary_model() -> Iterator[TestModel]:
    model = TestModel(
        custom_output_args={"summary": "Rear position lamps.", "keywords": ["tail light"]}
    )
    with regulation_search.summary_agent.override(model=model):
        yield model


# ---------------------------------------------------------------------------------- the model


def test_the_model_string_names_provider_model_and_length() -> None:
    assert MODEL.key == "openai:text-embedding-3-small@1024"
    routed = EmbeddingModel.parse("openrouter:openai/text-embedding-3-small")
    # Same model through another route: kept apart until someone shows the vectors match.
    assert routed.key == "openrouter:openai/text-embedding-3-small@1024"
    for wrong in ("text-embedding-3-small", "anthropic:x", "openai:"):
        with pytest.raises(ValueError):
            EmbeddingModel.parse(wrong)


async def test_embed_asks_for_the_stored_length_and_keeps_the_input_order() -> None:
    provider = Provider()
    async with provider.client as http:
        vectors = await embed(http, MODEL, KEY, ["a", "b", "c"])
    assert [v[0] for v in vectors] == [0.0, 1.0, 2.0]
    sent = provider.requests[0]
    assert sent["url"] == "https://api.openai.com/v1/embeddings"
    assert sent["headers"]["authorization"] == f"Bearer {KEY}"
    assert sent["body"]["dimensions"] == 1024
    assert sent["body"]["model"] == "text-embedding-3-small"


async def test_a_vector_of_another_length_is_refused_before_it_reaches_the_database() -> None:
    async with Provider(dimensions=1536).client as http:
        with pytest.raises(EmbeddingError, match="1024 dimensions"):
            await embed(http, MODEL, KEY, ["a"])


async def test_a_provider_error_never_repeats_the_key() -> None:
    async with Provider(status=429).client as http:
        with pytest.raises(EmbeddingError) as raised:
            await embed(http, MODEL, KEY, ["a"])
    assert KEY not in str(raised.value)
    assert "429" in str(raised.value)


def test_batches_respect_the_input_and_character_limits() -> None:
    many = [(str(i), "x") for i in range(600)]
    assert [len(b) for b in _batches(many)] == [256, 256, 88]
    long = [(str(i), "x" * 150_000) for i in range(5)]
    assert [len(b) for b in _batches(long)] == [2, 2, 1]


def test_a_vector_is_sent_in_pgvectors_text_form() -> None:
    assert vector_literal([0.5, -1.0, 1e-9]) == "[0.5,-1,1e-09]"


def test_the_opening_pages_of_a_pdf_are_read_with_their_page_numbers() -> None:
    text = opening_text(text_pdf("Regulation No. 7", "1. Scope", *["filler"] * 10))
    assert "--- page 1 ---\nRegulation No. 7" in text
    assert "1. Scope" in text
    assert "--- page 9 ---" not in text


# ---------------------------------------------------------------------------------- indexing


async def test_indexing_embeds_every_distinct_text_then_summarises(
    index_settings: Settings, summary_model: TestModel
) -> None:
    store = InMemorySearchStore(keys={"openai": KEY})
    # Base and latest share most paragraphs: 1,200 paragraphs, 700 distinct texts.
    store.inputs = [f"text {i}" for i in range(700)] + [f"text {i}" for i in range(500)]
    version = store.add_version("UN R7", "1.0.0", text_pdf("Rear position lamps", "1. Scope"))
    provider = Provider()

    async with provider.client as http:
        progress = await index_library(store, http, index_settings, ORG)

    assert progress.done
    assert progress.embedded == 700
    assert len(store.vectors) == 700
    assert all(len(r["body"]["input"]) <= 256 for r in provider.requests)
    summary, model, pdf_sha = store.summaries[version.id]
    assert summary.summary == "Rear position lamps."
    assert summary.keywords == ["tail light"]
    assert (model, pdf_sha) == ("test", version.sha256)


async def test_indexing_again_does_nothing_and_a_changed_text_is_embedded_alone(
    index_settings: Settings, summary_model: TestModel
) -> None:
    store = InMemorySearchStore(keys={"openai": KEY}, inputs=["a", "b"])
    async with Provider().client as http:
        await index_library(store, http, index_settings, ORG)
        provider = Provider()
    async with provider.client as http:
        again = await index_library(store, http, index_settings, ORG)
    assert again.done and again.embedded == 0 and provider.requests == []
    assert store.analyses == 1, (
        "statistics refreshed after writing, not on a slice that wrote nothing"
    )

    store.inputs = ["a", "b changed"]
    async with Provider().client as http:
        changed = await index_library(store, http, index_settings, ORG)
    assert (changed.embedded, changed.pruned) == (1, 1)
    assert store.refreshes == 3, "keys are refreshed on every slice, in case extraction ran"


async def test_a_new_pdf_under_the_same_label_gets_a_new_summary(
    index_settings: Settings, summary_model: TestModel
) -> None:
    store = InMemorySearchStore(keys={"openai": KEY})
    version = store.add_version("UN R7", "1.0.0", text_pdf("first"))
    async with Provider().client as http:
        await index_library(store, http, index_settings, ORG)
        version.sha256 = "f" * 64
        progress = await index_library(store, http, index_settings, ORG)
    assert progress.summarized == 1
    assert store.summaries[version.id][2] == "f" * 64


async def test_without_a_key_nothing_is_embedded_and_the_note_says_why(
    index_settings: Settings, summary_model: TestModel, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    store = InMemorySearchStore(inputs=["a"])
    provider = Provider()
    async with provider.client as http:
        progress = await index_library(store, http, index_settings, ORG)
    assert not progress.done
    assert provider.requests == []
    assert any("No openai key" in n for n in progress.notes)


async def test_the_organisations_key_comes_before_the_environments(
    index_settings: Settings, summary_model: TestModel, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("OPENAI_API_KEY", "sk-environment")
    store = InMemorySearchStore(keys={"openai": KEY}, inputs=["a"])
    provider = Provider()
    async with provider.client as http:
        await index_library(store, http, index_settings, ORG)
    assert provider.requests[0]["headers"]["authorization"] == f"Bearer {KEY}"


async def test_the_scripted_model_writes_no_summaries(settings: Settings) -> None:
    store = InMemorySearchStore(keys={"openai": KEY})
    store.add_version("UN R7", "1.0.0", text_pdf("x"))
    async with Provider().client as http:
        progress = await index_library(store, http, settings, ORG)
    assert not progress.done
    assert store.summaries == {}
    assert any("scripted" in n for n in progress.notes)


async def test_an_unreadable_pdf_does_not_stop_the_other_summaries(
    index_settings: Settings, summary_model: TestModel
) -> None:
    store = InMemorySearchStore(keys={"openai": KEY})
    store.add_version("UN R1", "1.0.0", b"%PDF-1.4 truncated")
    good = store.add_version("UN R7", "1.0.0", text_pdf("x"))
    async with Provider().client as http:
        progress = await index_library(store, http, index_settings, ORG)
    assert good.id in store.summaries
    assert not progress.done, "the broken one is still to do"
    assert any("UN R1 1.0.0: PDF not read" in n for n in progress.notes)


async def test_a_slice_stops_at_its_deadline(
    index_settings: Settings, summary_model: TestModel
) -> None:
    store = InMemorySearchStore(keys={"openai": KEY}, inputs=["a"])
    async with Provider().client as http:
        progress = await index_library(store, http, index_settings, ORG, slice_s=0)
    assert not progress.done and progress.embedded == 0


# ---------------------------------------------------------------------------------- searching


async def test_hybrid_search_embeds_the_query_with_the_same_model(settings: Settings) -> None:
    store = InMemorySearchStore(keys={"openai": KEY})
    provider = Provider()
    async with provider.client as http:
        await search(store, http, settings, ORG, "rear lamp", k=5)
    call = store.matches[0]
    assert call["query"] == "rear lamp"
    assert call["embedding"] is not None
    assert call["model"] == MODEL.key
    assert provider.requests[0]["body"]["input"] == ["rear lamp"]


async def test_the_organisations_embedding_model_is_used_to_index_and_to_search(
    index_settings: Settings, summary_model: TestModel
) -> None:
    # Admin, Other agents and processes (SYS-33). Vectors are stored under the model's key, so the
    # deployment's vectors stay and the organisation's are computed alongside them.
    store = InMemorySearchStore(
        keys={"openrouter": KEY},
        inputs=["a", "b"],
        models={"embedding": "openrouter:openai/text-embedding-3-large", "summary": "test"},
    )
    provider = Provider()
    async with provider.client as http:
        progress = await index_library(store, http, index_settings, ORG)
        await search(store, http, index_settings, ORG, "rear lamp", k=5)

    assert progress.done
    chosen = "openrouter:openai/text-embedding-3-large@1024"
    assert {model for model, _ in store.vectors} == {chosen}
    assert provider.requests[0]["url"] == "https://openrouter.ai/api/v1/embeddings"
    assert provider.requests[0]["body"]["model"] == "openai/text-embedding-3-large"
    assert store.matches[0]["model"] == chosen


async def test_a_case_searches_only_its_projects_regulations(settings: Settings) -> None:
    # SYS-32, IF-3 as agreed on #24: the project's choice cuts whatever the caller asked for.
    r48, r7, r10 = uuid4(), uuid4(), uuid4()
    narrowed, open_, empty = uuid4(), uuid4(), uuid4()
    store = InMemorySearchStore(
        scopes={
            narrowed: ProjectScope(all_regulations=False, version_ids=[r48, r7]),
            open_: ProjectScope(all_regulations=True),
            empty: ProjectScope(all_regulations=False),
        }
    )
    async with Provider().client as http:
        await search(store, http, settings, ORG, "lamp", mode="text", case_id=narrowed)
        await search(
            store, http, settings, ORG, "lamp", mode="text", case_id=narrowed, version_ids=[r7, r10]
        )
        await search(store, http, settings, ORG, "lamp", mode="text", case_id=open_)
        await search(store, http, settings, ORG, "lamp", mode="text", case_id=empty)
        await search(store, http, settings, ORG, "lamp", mode="text")

    assert [m["versions"] for m in store.matches] == [[r48, r7], [r7], None, [], None]


async def test_text_search_needs_no_provider(
    settings: Settings, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    store = InMemorySearchStore()
    provider = Provider()
    async with provider.client as http:
        await search(store, http, settings, ORG, "rear lamp", mode="text")
        with pytest.raises(EmbeddingError, match="no openai key is connected"):
            await search(store, http, settings, ORG, "rear lamp")
    assert provider.requests == []
    assert store.matches[0]["embedding"] is None


async def test_vector_search_sends_no_text_query(settings: Settings) -> None:
    store = InMemorySearchStore(keys={"openai": KEY})
    async with Provider().client as http:
        await search(store, http, settings, ORG, "rear lamp", mode="vector")
    assert store.matches[0]["query"] is None


# ---------------------------------------------------------------------------------- HTTP


@pytest.fixture
def client(index_settings: Settings, summary_model: TestModel):
    store = InMemorySearchStore(keys={"openai": KEY}, inputs=["a", "b"])
    app.dependency_overrides[get_search_store] = lambda: store
    app.dependency_overrides[get_settings] = lambda: index_settings
    # A factory, as in the app: the indexing opens its own client.
    app.dependency_overrides[get_download_client] = lambda: lambda: Provider().client
    yield TestClient(app), store
    app.dependency_overrides.clear()


def test_indexing_over_http_needs_the_secret(client: tuple[TestClient, Any]) -> None:
    http, _ = client
    assert http.post(f"/regulations/index/{ORG}/advance").status_code == 401


def test_indexing_over_http_streams_what_it_did(client: tuple[TestClient, Any]) -> None:
    http, store = client
    response = http.post(f"/regulations/index/{ORG}/advance", headers=AUTH)
    lines = [json.loads(line) for line in response.text.splitlines()]
    assert lines[0] == {"event": "accepted", "organization_id": str(ORG)}
    done = lines[-1]
    assert done["event"] == "done" and done["finished"] is True
    assert done["embedded"] == 2
    assert store.closed


def test_a_page_of_results_without_a_vector_rank_was_found_by_words_only() -> None:
    def hit(vector_rank: int | None) -> regulation_search.Hit:
        return regulation_search.Hit(
            paragraph_id=uuid4(),
            version_id=uuid4(),
            regulation_code="UN R1",
            version_label="00",
            kind="paragraph",
            text="x",
            page_start=1,
            page_end=1,
            score=0.1,
            text_rank=1,
            vector_rank=vector_rank,
        )

    assert regulation_search.words_only([hit(None), hit(None)])
    assert not regulation_search.words_only([hit(None), hit(3)])


async def test_a_summary_model_that_refuses_stops_the_summaries_with_a_note(
    index_settings: Settings,
) -> None:
    # A missing Anthropic key, say: every version would fail the same way, so the slice says it
    # once and the vectors it wrote still count (#37).
    def refuse(_messages: Any, _info: Any) -> Any:
        raise RuntimeError("invalid x-api-key")

    store = InMemorySearchStore(keys={"openai": KEY}, inputs=["a"])
    store.add_version("UN R7", "1.0.0", text_pdf("x"))
    store.add_version("UN R10", "1.0.0", text_pdf("y"))
    with regulation_search.summary_agent.override(model=FunctionModel(refuse)):
        async with Provider().client as http:
            progress = await index_library(store, http, index_settings, ORG)

    assert progress.embedded == 1
    assert not progress.done
    [note] = [n for n in progress.notes if "Summaries stopped" in n]
    assert "invalid x-api-key" in note
    assert store.summaries == {}


async def test_an_input_over_the_token_limit_is_shortened_and_the_slice_goes_on(
    index_settings: Settings, summary_model: TestModel
) -> None:
    # A dense table tokenises at about 2 characters a token, so the database's 24,000-character
    # cut can still be over OpenAI's 8,192 tokens; in production that stopped the library (#37).
    limit = 3000
    sent: list[list[str]] = []

    def handle(request: httpx.Request) -> httpx.Response:
        texts = json.loads(request.content)["input"]
        sent.append(texts)
        for i, t in enumerate(texts):
            if len(t) > limit:
                message = f"Invalid 'input[{i}]': maximum input length is 8192 tokens."
                return httpx.Response(400, json={"error": {"message": message}})
        data = [{"index": i, "embedding": [0.0] * DIMENSIONS} for i in range(len(texts))]
        return httpx.Response(200, json={"data": data})

    store = InMemorySearchStore(keys={"openai": KEY}, inputs=["short", "x" * 10_000])
    async with httpx.AsyncClient(transport=httpx.MockTransport(handle)) as http:
        progress = await index_library(store, http, index_settings, ORG)

    assert progress.embedded == 2
    assert len(store.vectors) == 2, "both keep their full input's key"
    assert max(len(t) for t in sent[-1]) <= limit


async def test_any_other_refusal_still_stops_the_slice(index_settings: Settings) -> None:
    store = InMemorySearchStore(keys={"openai": KEY}, inputs=["a"])
    async with Provider(status=400).client as http:
        with pytest.raises(EmbeddingError):
            await index_library(store, http, index_settings, ORG)


# ---------------------------------------------------------------------------------- side by side


async def test_embedding_requests_go_out_several_at_once(
    index_settings: Settings, summary_model: TestModel
) -> None:
    active, peak = 0, 0

    async def handle(request: httpx.Request) -> httpx.Response:
        nonlocal active, peak
        active += 1
        peak = max(peak, active)
        await asyncio.sleep(0.01)
        active -= 1
        texts = json.loads(request.content)["input"]
        data = [{"index": i, "embedding": [0.0] * DIMENSIONS} for i in range(len(texts))]
        return httpx.Response(200, json={"data": data})

    store = InMemorySearchStore(keys={"openai": KEY}, inputs=[f"t{i}" for i in range(2000)])
    async with httpx.AsyncClient(transport=httpx.MockTransport(handle)) as http:
        progress = await index_library(store, http, index_settings, ORG)

    assert progress.embedded == 2000 and len(store.vectors) == 2000
    assert peak == index_settings.embedding_concurrency


async def test_a_busy_provider_is_waited_out_instead_of_failing_the_slice(
    index_settings: Settings, summary_model: TestModel
) -> None:
    calls = 0

    def handle(request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        if calls == 1:
            return httpx.Response(429, headers={"retry-after": "0"}, text="slow down")
        texts = json.loads(request.content)["input"]
        data = [{"index": i, "embedding": [0.0] * DIMENSIONS} for i in range(len(texts))]
        return httpx.Response(200, json={"data": data})

    store = InMemorySearchStore(keys={"openai": KEY}, inputs=["a", "b"])
    async with httpx.AsyncClient(transport=httpx.MockTransport(handle)) as http:
        progress = await index_library(store, http, index_settings, ORG)

    assert progress.embedded == 2 and calls == 2


async def test_a_provider_that_stays_busy_still_stops_the_slice(index_settings: Settings) -> None:
    def handle(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(503, headers={"retry-after": "0"}, text="unavailable")

    store = InMemorySearchStore(keys={"openai": KEY}, inputs=["a"])
    async with httpx.AsyncClient(transport=httpx.MockTransport(handle)) as http:
        with pytest.raises(EmbeddingError, match="503"):
            await index_library(store, http, index_settings, ORG)


async def test_summaries_are_written_even_when_the_embedding_key_is_refused(
    index_settings: Settings, summary_model: TestModel
) -> None:
    # Side by side, not one after the other: in production 16,256 vectors were written before the
    # first summary was even tried (#43).
    store = InMemorySearchStore(keys={"openai": KEY}, inputs=["a"])
    version = store.add_version("UN R7", "1.0.0", text_pdf("Rear position lamps"))
    async with Provider(status=401).client as http:
        with pytest.raises(EmbeddingError, match="rejected the API key"):
            await index_library(store, http, index_settings, ORG)
    assert version.id in store.summaries
