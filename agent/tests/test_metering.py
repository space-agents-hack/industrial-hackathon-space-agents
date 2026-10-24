"""Usage recording (agent_service/metering.py, docs/se SYS-40): every model and embedding call is
counted under the model the organisation chose and the key that paid, including the calls of a
run that fails. No provider is reached: the models are pydantic-ai's FunctionModel."""

import json
from decimal import Decimal
from typing import Any

import httpx
import pytest
from genai_prices import Usage, calc_price
from pydantic_ai import Agent
from pydantic_ai.messages import ModelMessage, ModelResponse, TextPart
from pydantic_ai.models.function import AgentInfo, FunctionModel
from pydantic_ai.usage import RequestUsage

from agent_service import metering, runner
from agent_service.domain import case_ingest
from agent_service.domain.regulation_search import EmbeddingModel, embed, search
from agent_service.domain.scripted import scripted_model
from agent_service.metering import Credential, Meter, MeteredModel, metered
from agent_service.settings import Settings
from tests.fakes import ORG, InMemoryRunStore, case_run
from tests.search_fakes import InMemorySearchStore

pytestmark = pytest.mark.anyio

KEY = "sk-test-not-a-real-key-wxyz"


def answer(_messages: list[ModelMessage], _info: AgentInfo) -> ModelResponse:
    return ModelResponse(
        parts=[TextPart("ok")], usage=RequestUsage(input_tokens=120, output_tokens=8)
    )


async def stream_answer(_messages: list[ModelMessage], _info: AgentInfo):
    yield "ok"


def model(meter: Meter, name: str = "anthropic:claude-opus-5-5") -> MeteredModel:
    function = FunctionModel(answer, stream_function=stream_answer)
    return MeteredModel(function, meter, "writer", name, Credential.of("anthropic", KEY))


# ------------------------------------------------------------------------------ the meter


async def test_each_response_is_counted_under_the_chosen_name_and_the_keys_last_four() -> None:
    meter = Meter(ORG)
    agent = Agent(output_type=str)

    await agent.run("a", model=model(meter))
    await agent.run("b", model=model(meter))

    [row] = meter.take()
    assert row["process"] == "writer"
    assert (row["provider"], row["model"]) == ("anthropic", "anthropic:claude-opus-5-5")
    assert (row["key_source"], row["key_hint"]) == ("organization", "wxyz")
    assert (row["requests"], row["input_tokens"], row["output_tokens"]) == (2, 240, 16)
    # A function model has no price: no cost, and both requests say so.
    assert row["cost_usd"] is None
    assert row["unpriced_requests"] == 2


async def test_a_streamed_response_is_counted_too() -> None:
    meter = Meter(ORG)
    async with Agent(output_type=str).run_stream("a", model=model(meter)) as result:
        await result.get_output()

    [row] = meter.take()
    assert row["requests"] == 1
    assert row["output_tokens"] > 0


async def test_writing_the_rows_empties_the_meter_so_nothing_is_counted_twice() -> None:
    store = InMemoryRunStore()
    meter = Meter(ORG)
    await Agent(output_type=str).run("a", model=model(meter))

    await meter.flush(store)
    await meter.flush(store)

    assert len(store.usage_rows) == 1


async def test_a_database_that_refuses_the_rows_does_not_fail_the_work() -> None:
    class Refusing:
        async def record_usage(self, rows: list[dict[str, Any]]) -> None:
            raise RuntimeError("database down")

    meter = Meter(ORG)
    meter.add("search", "openai:x", Credential.of("openai", None), cost=Decimal(1))

    await meter.flush(Refusing())  # logged, not raised


def test_the_price_is_the_libraries_estimate_for_the_responding_model() -> None:
    response = ModelResponse(
        parts=[TextPart("x")],
        usage=RequestUsage(input_tokens=1_000_000, output_tokens=1_000),
        model_name="claude-opus-5-5",
        provider_name="anthropic",
    )
    expected = calc_price(
        Usage(input_tokens=1_000_000, output_tokens=1_000),
        "claude-opus-5-5",
        provider_id="anthropic",
    ).total_price
    assert metering.response_cost(response) == expected
    assert expected > 0


def test_ollama_costs_nothing_rather_than_an_unknown_amount() -> None:
    meter = Meter(ORG)
    meter.add(
        "writer", "ollama:qwen3:32b", Credential.of("ollama", None, "http://gpu:11434"), cost=None
    )
    [row] = meter.take()
    assert (row["cost_usd"], row["unpriced_requests"]) == (0.0, 0)
    assert (row["key_source"], row["key_hint"]) == ("server", "http://gpu:11434")


def test_a_deployment_key_is_named_by_its_variable_never_by_its_value() -> None:
    assert Credential.of("openai", None) == Credential("deployment", "OPENAI_API_KEY")
    assert Credential.for_model("deepseek:deepseek-chat", None, None).hint == "DEEPSEEK_API_KEY"


def test_openrouter_embeddings_are_priced_at_openais_price() -> None:
    direct = metering.embedding_cost("openai", "text-embedding-3-small", 1_000_000)
    routed = metering.embedding_cost("openrouter", "openai/text-embedding-3-small", 1_000_000)
    assert direct is not None and direct > 0
    assert routed == direct


def test_the_scripted_model_and_work_without_a_meter_are_not_metered() -> None:
    plain = scripted_model()
    assert metered(plain, Meter(ORG), "writer", "scripted", Credential("deployment")) is plain
    assert metered(plain, None, "writer", "openai:x", Credential("deployment")) is plain


async def test_a_transcription_is_counted_as_one() -> None:
    meter = Meter(ORG)
    transcribe = case_ingest.transcriber(
        MeteredModel(
            FunctionModel(answer),
            meter,
            "transcription",
            "anthropic:claude-haiku-5-5",
            Credential.of("anthropic", None),
        )
    )

    await transcribe("page 3", "drawing")  # pyright: ignore[reportArgumentType]

    [row] = meter.take()
    assert (row["process"], row["key_source"]) == ("transcription", "deployment")


# ------------------------------------------------------------------------------ embeddings


def embeddings_endpoint(tokens_per_input: int = 5) -> httpx.AsyncClient:
    def handle(request: httpx.Request) -> httpx.Response:
        texts = json.loads(request.content)["input"]
        data = [{"index": i, "embedding": [0.0] * 1024} for i in range(len(texts))]
        tokens = tokens_per_input * len(texts)
        return httpx.Response(
            200, json={"data": data, "usage": {"prompt_tokens": tokens, "total_tokens": tokens}}
        )

    return httpx.AsyncClient(transport=httpx.MockTransport(handle))


async def test_an_embedding_call_records_the_tokens_the_provider_reports() -> None:
    meter = Meter(ORG)
    model = EmbeddingModel.parse("openai:text-embedding-3-small")
    async with embeddings_endpoint() as http:
        await embed(
            http, model, KEY, ["a", "b"], meter=meter, credential=Credential.of("openai", KEY)
        )

    [row] = meter.take()
    assert (row["process"], row["model"], row["input_tokens"]) == (
        "embedding",
        "openai:text-embedding-3-small",
        10,
    )
    assert row["cost_usd"] == pytest.approx(10 * 0.02 / 1_000_000)


async def test_a_search_outside_a_run_writes_its_query_vector_at_once(settings: Settings) -> None:
    store = InMemorySearchStore(keys={"openai": KEY})
    async with embeddings_endpoint() as http:
        await search(store, http, settings, ORG, "rear position lamp")

    [row] = store.usage
    assert (row["process"], row["key_hint"], row["input_tokens"]) == ("search", "wxyz", 5)


# ------------------------------------------------------------------------------ runs


@pytest.fixture
def priced_run(store: InMemoryRunStore, settings: Settings, monkeypatch: pytest.MonkeyPatch):
    """A run on "openai:gpt-test" with the organisation's key, played by the scripted model."""
    monkeypatch.setattr(runner, "build_model", lambda *_args: scripted_model())
    settings.agent_model = "openai:gpt-test"
    store.keys[(ORG, "openai")] = KEY
    return case_run(store)


async def test_a_run_records_its_writer_and_check_usage_with_the_key_that_paid(
    store: InMemoryRunStore, settings: Settings, priced_run: Any
) -> None:
    plan = await runner.prepare(store, settings, priced_run)
    await runner.execute(store, settings, plan)

    rows = store.usage_rows
    assert {r["process"] for r in rows} == {"writer", "check"}
    assert all(r["model"] == "openai:gpt-test" and r["key_hint"] == "wxyz" for r in rows)
    assert all(r["run_id"] == str(priced_run) for r in rows)
    assert sum(r["requests"] for r in rows) > 0


async def test_a_run_that_fails_still_records_what_it_spent(
    store: InMemoryRunStore, settings: Settings, priced_run: Any
) -> None:
    settings.max_model_requests = 2
    plan = await runner.prepare(store, settings, priced_run)

    assert await runner.execute(store, settings, plan) == "failed"

    assert sum(r["requests"] for r in store.usage_rows) >= 2
