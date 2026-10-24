"""The run page's chat (#28, SYS-39) with the scripted model: it answers from the run's rows and
the library, uses the run's model with the organisation's key, refuses over the cap, and writes
nothing but its usage (SYS-40)."""

from uuid import uuid4

import pytest
from fastapi.testclient import TestClient
from pydantic_ai.messages import ModelMessage, ModelResponse, TextPart
from pydantic_ai.models.function import AgentInfo, FunctionModel

from agent_service import providers, runner
from agent_service.api import app, get_store
from agent_service.domain import run_chat
from agent_service.domain.run_chat import ChatRefused, Turn
from agent_service.records import OrganizationSettings, Requirement
from agent_service.settings import Settings, get_settings
from tests.fakes import ORG, InMemoryRunStore, case_run

pytestmark = pytest.mark.anyio

AUTH = {"Authorization": "Bearer test-secret"}
KEY = "sk-test-0123456789abcdef-SECRET"


async def finished_run(store: InMemoryRunStore, settings: Settings):
    run_id = case_run(store)
    plan = await runner.prepare(store, settings, run_id)
    assert await runner.execute(store, settings, plan) == "awaiting_approval"
    return run_id


def ask(question: str) -> list[Turn]:
    return [Turn(role="user", content=question)]


async def test_why_a_requirement_quotes_the_paragraph_it_cites(store, settings) -> None:
    run_id = await finished_run(store, settings)
    r = next(r for r in await store.run_requirements(run_id) if r.paragraph == "5.4.3")

    result = await run_chat.answer(store, settings, run_id, ask(f"Why did you add {r.ext_id}?"))

    assert result.text.startswith(f"{r.ext_id} cites UN R148 00, 5.4.3, page 4")
    # The full paragraph, read from the library by the tool, not only the requirement's text.
    assert "The luminous intensity shall not exceed 30 cd." in result.text
    assert result.model == "scripted"


async def test_is_it_captured_searches_and_names_the_requirement_that_cites_it(
    store, settings
) -> None:
    run_id = await finished_run(store, settings)
    cited = next(r for r in await store.run_requirements(run_id) if r.paragraph == "5.4.3")

    result = await run_chat.answer(store, settings, run_id, ask("luminous intensity"))

    assert f"UN R148 00, 5.4.3, page 4: cited by {cited.ext_id}." in result.text


async def test_an_obligation_no_requirement_cites_is_called_not_cited(store, settings) -> None:
    run_id = await finished_run(store, settings)
    # Only 5.4.2 says "visible"; take its requirement away to make it a miss.
    store.requirements = [r for r in store.requirements if r.paragraph != "5.4.2"]

    result = await run_chat.answer(store, settings, run_id, ask("visible"))

    assert "UN R148 00, 5.4.2, page 4: not cited." in result.text


async def test_the_conversation_so_far_reaches_the_model(
    store, settings, monkeypatch: pytest.MonkeyPatch
) -> None:
    run_id = await finished_run(store, settings)
    seen: list[int] = []

    def model(messages: list[ModelMessage], info: AgentInfo) -> ModelResponse:
        seen.append(len(messages))
        return ModelResponse(parts=[TextPart("ok")])

    monkeypatch.setattr(providers, "build_model", lambda *_: FunctionModel(model))

    turns = [
        Turn(role="user", content="first"),
        Turn(role="assistant", content="an answer"),
        Turn(role="user", content="second"),
    ]
    assert (await run_chat.answer(store, settings, run_id, turns)).text == "ok"
    # The two earlier turns and the question, in one request.
    assert seen == [3]


async def test_it_writes_nothing_to_the_run(store, settings) -> None:
    run_id = await finished_run(store, settings)
    events, rows = list(store.events), list(store.requirements)

    await run_chat.answer(store, settings, run_id, ask("luminous intensity"))

    assert store.events == events
    assert store.requirements == rows
    assert store.runs[run_id].status == "awaiting_approval"


async def test_it_uses_the_runs_model_with_the_organisations_key(
    store, settings, monkeypatch: pytest.MonkeyPatch
) -> None:
    run_id = await finished_run(store, settings)
    store.models[run_id] = "openai:gpt-test"
    store.keys[(ORG, "openai")] = KEY
    built: list[tuple[str, str | None]] = []

    def refuse(messages: list[ModelMessage], info: AgentInfo) -> ModelResponse:
        raise RuntimeError(f"Incorrect API key provided: {KEY}")

    def build(name: str, key: str | None, endpoint=None) -> FunctionModel:
        built.append((name, key))
        return FunctionModel(refuse)

    monkeypatch.setattr(providers, "build_model", build)

    with pytest.raises(ChatRefused) as refused:
        await run_chat.answer(store, settings, run_id, ask("anything"))

    assert built == [("openai:gpt-test", KEY)]
    assert refused.value.status == 502
    # The provider's message reaches the person without the key.
    assert KEY not in str(refused.value)
    assert providers.REDACTED in str(refused.value)


async def test_an_answer_records_its_usage_against_the_run(
    store, settings, monkeypatch: pytest.MonkeyPatch
) -> None:
    run_id = await finished_run(store, settings)
    store.models[run_id] = "openai:gpt-test"
    store.keys[(ORG, "openai")] = KEY

    def reply(messages: list[ModelMessage], info: AgentInfo) -> ModelResponse:
        return ModelResponse(parts=[TextPart("R-001 cites 5.4.2.")])

    monkeypatch.setattr(providers, "build_model", lambda *_: FunctionModel(reply))

    await run_chat.answer(store, settings, run_id, ask("why R-001?"))

    [row] = store.usage_rows
    assert (row["process"], row["model"], row["run_id"]) == ("chat", "openai:gpt-test", str(run_id))
    assert (row["key_source"], row["key_hint"]) == ("organization", KEY[-4:])


async def test_over_the_monthly_cap_it_does_not_answer(store, settings) -> None:
    run_id = await finished_run(store, settings)
    store.settings[ORG] = OrganizationSettings(monthly_cost_cap_usd=5)
    store.spent[ORG] = 5

    with pytest.raises(ChatRefused) as refused:
        await run_chat.answer(store, settings, run_id, ask("anything"))

    assert refused.value.status == 409
    assert "monthly cap" in str(refused.value)


async def test_the_last_turn_must_be_the_question(store, settings) -> None:
    run_id = await finished_run(store, settings)
    with pytest.raises(ChatRefused) as refused:
        await run_chat.answer(store, settings, run_id, [Turn(role="assistant", content="hello")])
    assert refused.value.status == 422


async def test_an_unknown_run_is_404(store, settings) -> None:
    with pytest.raises(ChatRefused) as refused:
        await run_chat.answer(store, settings, uuid4(), ask("anything"))
    assert refused.value.status == 404


def test_a_long_requirement_list_says_what_it_left_out(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(run_chat, "_REQUIREMENTS_CHARS", 300)
    rows = [
        Requirement(
            id=uuid4(),
            case_id=uuid4(),
            organization_id=ORG,
            run_id=uuid4(),
            ext_id=f"R-{n:03d}",
            text="The lamp shall be red. " * 3,
            version_id=uuid4(),
            paragraph_id=uuid4(),
            paragraph_hash="x",
            regulation="UN R148",
            version_label="00",
            page=4,
            paragraph="5.4.2",
        )
        for n in range(1, 11)
    ]

    text = run_chat.requirement_lines(rows)

    assert text.startswith("- R-001 [draft] UN R148 00, paragraph 5.4.2, page 4: The lamp")
    assert "more not shown" in text
    assert "R-010" in text.splitlines()[-1]


# The HTTP surface.


@pytest.fixture
def client(store: InMemoryRunStore, settings: Settings):
    app.dependency_overrides[get_store] = lambda: store
    app.dependency_overrides[get_settings] = lambda: settings
    yield TestClient(app)
    app.dependency_overrides.clear()


async def test_post_chat_answers(client: TestClient, store, settings) -> None:
    run_id = await finished_run(store, settings)

    response = client.post(
        f"/runs/{run_id}/chat",
        headers=AUTH,
        json={"messages": [{"role": "user", "content": "luminous intensity"}]},
    )

    assert response.status_code == 200
    body = response.json()
    assert "cited by" in body["answer"]
    assert body["model"] == "scripted"
    assert set(body["usage"]) == {"input_tokens", "output_tokens", "requests", "cost_usd"}
    assert store.closed


def test_post_chat_needs_the_secret(client: TestClient) -> None:
    response = client.post(
        f"/runs/{uuid4()}/chat", json={"messages": [{"role": "user", "content": "x"}]}
    )
    assert response.status_code == 401


@pytest.mark.parametrize(
    "messages",
    [[], [{"role": "system", "content": "x"}], [{"role": "user", "content": "x" * 4001}]],
)
def test_post_chat_refuses_a_malformed_conversation(client: TestClient, messages) -> None:
    response = client.post(f"/runs/{uuid4()}/chat", headers=AUTH, json={"messages": messages})
    assert response.status_code == 422


def test_post_chat_of_an_unknown_run_is_404(client: TestClient) -> None:
    response = client.post(
        f"/runs/{uuid4()}/chat",
        headers=AUTH,
        json={"messages": [{"role": "user", "content": "x"}]},
    )
    assert response.status_code == 404
