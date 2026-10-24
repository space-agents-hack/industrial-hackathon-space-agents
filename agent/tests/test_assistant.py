"""The assistant behind the bubble on every page (SYS-39, #28, #31) with the scripted model: it
answers from the project's rows and the library, knows the page the person is on, reads only the
project's own runs and cases, uses the organisation's model and key, refuses over the cap, and
writes nothing."""

from uuid import UUID, uuid4

import pytest
from fastapi.testclient import TestClient
from pydantic_ai.messages import (
    ModelMessage,
    ModelRequest,
    ModelResponse,
    TextPart,
    ToolCallPart,
    ToolReturnPart,
)
from pydantic_ai.models.function import AgentInfo, FunctionModel

from agent_service import providers, runner
from agent_service.api import app, get_project_store, get_store
from agent_service.domain import assistant
from agent_service.domain.assistant import ChatRefused, Page, Turn
from agent_service.domain.regulation_search import ProjectScope
from agent_service.records import OrganizationSettings, Requirement
from agent_service.settings import Settings, get_settings
from tests.fakes import (
    CASE_TEXT,
    ORG,
    TASK,
    InMemoryProjectStore,
    InMemoryRunStore,
    case_run,
)

pytestmark = pytest.mark.anyio

AUTH = {"Authorization": "Bearer test-secret"}
KEY = "sk-test-0123456789abcdef-SECRET"


@pytest.fixture
def projects(store: InMemoryRunStore) -> InMemoryProjectStore:
    return InMemoryProjectStore(store)


async def finished_run(
    store: InMemoryRunStore, projects: InMemoryProjectStore, settings: Settings, seed: bool = True
) -> tuple[UUID, UUID]:
    """A project with one case and one run paused before its export: (project, run). `seed`
    false for a second project on the library the first one seeded."""
    if seed:
        run_id = case_run(store)
    else:
        case = store.add_parsed_case("other-lamp", CASE_TEXT)
        run_id = store.add_run(TASK, case_id=case)
    case_id = store.runs[run_id].case_id
    assert case_id is not None
    project_id = projects.add_project("Rear lamps", [case_id])
    plan = await runner.prepare(store, settings, run_id)
    assert await runner.execute(store, settings, plan) == "awaiting_approval"
    return project_id, run_id


def ask(question: str) -> list[Turn]:
    return [Turn(role="user", content=question)]


def capture(monkeypatch: pytest.MonkeyPatch) -> list[str]:
    """Replace the model with one that records the instructions it was given and answers "ok"."""
    seen: list[str] = []

    def model(messages: list[ModelMessage], info: AgentInfo) -> ModelResponse:
        last = next(m for m in reversed(messages) if isinstance(m, ModelRequest))
        seen.append(last.instructions or "")
        return ModelResponse(parts=[TextPart("ok")])

    monkeypatch.setattr(providers, "build_model", lambda *_: FunctionModel(model))
    return seen


async def test_on_a_runs_page_why_a_requirement_quotes_its_paragraph(
    store, projects, settings
) -> None:
    project_id, run_id = await finished_run(store, projects, settings)
    r = next(r for r in await store.run_requirements(run_id) if r.paragraph == "5.4.3")

    result = await assistant.answer(
        store, projects, settings, project_id, Page(run_id=run_id), ask(f"Why {r.ext_id}?")
    )

    assert result.text.startswith(f"{r.ext_id} cites UN R148 00, 5.4.3, page 4")
    # The full paragraph, read from the library by the tool, not only the requirement's text.
    assert "The luminous intensity shall not exceed 30 cd." in result.text
    assert result.model == "scripted"


async def test_is_it_captured_names_the_requirement_or_says_none_cites_it(
    store, projects, settings
) -> None:
    project_id, run_id = await finished_run(store, projects, settings)
    cited = next(r for r in await store.run_requirements(run_id) if r.paragraph == "5.4.3")
    page = Page(run_id=run_id)

    found = await assistant.answer(
        store, projects, settings, project_id, page, ask("luminous intensity")
    )
    assert f"UN R148 00, 5.4.3, page 4: cited by {cited.ext_id}." in found.text

    store.requirements = [r for r in store.requirements if r.paragraph != "5.4.2"]
    missed = await assistant.answer(store, projects, settings, project_id, page, ask("visible"))
    assert "UN R148 00, 5.4.2, page 4: not cited." in missed.text


async def test_every_page_gets_the_project_and_its_runs_cases_and_regulations(
    store, projects, settings, monkeypatch
) -> None:
    project_id, run_id = await finished_run(store, projects, settings)
    seen = capture(monkeypatch)

    await assistant.answer(
        store, projects, settings, project_id, Page(path="/regulations"), ask("what is here?")
    )

    [context] = seen
    assert "# Project Rear lamps" in context
    assert "- UN R148 00 (base)" in context
    assert "- dev-rear-lamp (id " in context and "spec.md (parsed)" in context
    assert f"- {str(run_id)[:8]} on dev-rear-lamp, awaiting_approval" in context
    assert "Path: /regulations" in context
    # Off a run's page the requirements are not sent; run_details fetches them when asked.
    assert "R-001 [" not in context


async def test_a_case_page_sends_the_cases_text(store, projects, settings, monkeypatch) -> None:
    project_id, run_id = await finished_run(store, projects, settings)
    case_id = store.runs[run_id].case_id
    seen = capture(monkeypatch)

    await assistant.answer(store, projects, settings, project_id, Page(case_id=case_id), ask("?"))

    assert "## Case dev-rear-lamp" in seen[0]
    assert "A red LED rear position lamp" in seen[0]


async def test_an_empty_project_says_what_does_not_exist(
    store, projects, settings, monkeypatch
) -> None:
    project_id = projects.add_project("Empty")
    seen = capture(monkeypatch)

    await assistant.answer(store, projects, settings, project_id, Page(), ask("anything?"))

    assert "None. The organisation's library has no regulation" in seen[0]
    assert "## Cases\n\nNone yet." in seen[0]
    assert "## Runs (newest first)\n\nNone yet." in seen[0]


async def test_only_the_projects_chosen_regulations_are_listed(
    store, projects, settings, monkeypatch
) -> None:
    project_id, _ = await finished_run(store, projects, settings)
    r148 = next(v.id for v in store.versions[ORG] if v.regulation == "UN R148")
    projects.scopes[project_id] = ProjectScope(all_regulations=False, version_ids=[r148])
    seen = capture(monkeypatch)

    await assistant.answer(store, projects, settings, project_id, Page(), ask("?"))

    assert "UN R148" in seen[0]
    assert "UN R48" not in seen[0]


async def test_another_projects_run_or_case_is_not_read(
    store, projects, settings, monkeypatch
) -> None:
    project_id, _ = await finished_run(store, projects, settings)
    other_project, other_run = await finished_run(store, projects, settings, seed=False)
    other_case = store.runs[other_run].case_id
    seen = capture(monkeypatch)

    await assistant.answer(store, projects, settings, project_id, Page(run_id=other_run), ask("?"))
    await assistant.answer(
        store, projects, settings, project_id, Page(case_id=other_case), ask("?")
    )

    assert "That run is not one of this project's." in seen[0]
    assert "R-001 [" not in seen[0]
    assert "Not a case of this project." in seen[1]
    assert other_project != project_id


async def test_run_details_opens_a_run_of_the_project_by_its_short_id(
    store, projects, settings
) -> None:
    project_id, run_id = await finished_run(store, projects, settings)
    deps = assistant.ChatDeps(
        store=store,
        project=projects.projects[project_id],
        scope=ProjectScope(all_regulations=True),
        cases={c.id: c for c in await projects.project_cases(project_id)},
        runs={r.id: r for r in await projects.project_runs(project_id, 10)},
        settings=settings,
    )

    class Ctx:
        def __init__(self, deps: assistant.ChatDeps) -> None:
            self.deps = deps

    text = await assistant.run_details(Ctx(deps), str(run_id)[:8])  # pyright: ignore[reportArgumentType]
    assert f"## Run {run_id}" in text and "R-001 [" in text
    missing = await assistant.run_details(Ctx(deps), "ffffffff")  # pyright: ignore[reportArgumentType]
    assert missing == "No run 'ffffffff' in this project."


async def test_the_conversation_so_far_reaches_the_model(
    store, projects, settings, monkeypatch
) -> None:
    project_id, _ = await finished_run(store, projects, settings)
    lengths: list[int] = []

    def model(messages: list[ModelMessage], info: AgentInfo) -> ModelResponse:
        lengths.append(len(messages))
        return ModelResponse(parts=[TextPart("ok")])

    monkeypatch.setattr(providers, "build_model", lambda *_: FunctionModel(model))
    turns = [
        Turn(role="user", content="first"),
        Turn(role="assistant", content="an answer"),
        Turn(role="user", content="second"),
    ]
    assert (
        await assistant.answer(store, projects, settings, project_id, Page(), turns)
    ).text == "ok"
    # The two earlier turns and the question, in one request.
    assert lengths == [3]


async def test_an_answer_from_a_word_only_search_says_so_under_the_answer(
    store, projects, settings, monkeypatch: pytest.MonkeyPatch
) -> None:
    # No embedding key in the fake store: the search falls back to words (#37). The notice is the
    # agent's, not the model's: it is there whatever the model writes.
    project_id, _ = await finished_run(store, projects, settings)

    def model(messages: list[ModelMessage], info: AgentInfo) -> ModelResponse:
        returned = any(isinstance(p, ToolReturnPart) for m in messages for p in m.parts)
        if returned:
            return ModelResponse(parts=[TextPart("ok")])
        call = ToolCallPart("search_regulations", {"query": "rear position lamp"})
        return ModelResponse(parts=[call, ToolCallPart("search_regulations", {"query": "red"})])

    monkeypatch.setattr(providers, "build_model", lambda *_: FunctionModel(model))

    result = await assistant.answer(store, projects, settings, project_id, Page(), ask("?"))

    assert len(result.notices) == 1
    assert "words only" in result.notices[0]
    assert result.text == "ok"


async def test_it_writes_nothing(store, projects, settings) -> None:
    project_id, run_id = await finished_run(store, projects, settings)
    events, rows = list(store.events), list(store.requirements)

    await assistant.answer(
        store, projects, settings, project_id, Page(run_id=run_id), ask("luminous intensity")
    )

    assert store.events == events
    assert store.requirements == rows
    assert store.runs[run_id].status == "awaiting_approval"


async def test_it_uses_the_organisations_model_and_key_and_hides_the_key(
    store, projects, settings, monkeypatch: pytest.MonkeyPatch
) -> None:
    project_id, run_id = await finished_run(store, projects, settings)
    store.process_models[(ORG, "chat")] = "openai:gpt-test"
    store.keys[(ORG, "openai")] = KEY
    built: list[tuple[str, str | None]] = []

    def refuse(messages: list[ModelMessage], info: AgentInfo) -> ModelResponse:
        raise RuntimeError(f"Incorrect API key provided: {KEY}")

    def build(name: str, key: str | None, endpoint=None) -> FunctionModel:
        built.append((name, key))
        return FunctionModel(refuse)

    monkeypatch.setattr(providers, "build_model", build)

    with pytest.raises(ChatRefused) as refused:
        await assistant.answer(store, projects, settings, project_id, Page(run_id=run_id), ask("?"))

    # The organisation's chat model, not the one the run happened to use.
    assert built == [("openai:gpt-test", KEY)]
    assert refused.value.status == 502
    assert KEY not in str(refused.value)
    assert providers.REDACTED in str(refused.value)


async def test_an_answer_records_its_usage_against_the_run_on_the_page(
    store, projects, settings, monkeypatch: pytest.MonkeyPatch
) -> None:
    project_id, run_id = await finished_run(store, projects, settings)
    store.process_models[(ORG, "chat")] = "openai:gpt-test"
    store.keys[(ORG, "openai")] = KEY
    before = len(store.usage_rows)

    def reply(messages: list[ModelMessage], info: AgentInfo) -> ModelResponse:
        return ModelResponse(parts=[TextPart("R-001 cites 5.4.2.")])

    monkeypatch.setattr(providers, "build_model", lambda *_: FunctionModel(reply))

    await assistant.answer(store, projects, settings, project_id, Page(run_id=run_id), ask("?"))
    await assistant.answer(store, projects, settings, project_id, Page(), ask("?"))

    on_run, off_run = store.usage_rows[before:]
    assert (on_run["process"], on_run["model"]) == ("chat", "openai:gpt-test")
    assert on_run["run_id"] == str(run_id)
    assert (on_run["key_source"], on_run["key_hint"]) == ("organization", KEY[-4:])
    # Off a run's page the answer still counts, for the organisation, against no run.
    assert off_run["run_id"] is None and off_run["process"] == "chat"


async def test_over_the_monthly_cap_it_does_not_answer(store, projects, settings) -> None:
    project_id, _ = await finished_run(store, projects, settings)
    store.settings[ORG] = OrganizationSettings(monthly_cost_cap_usd=5)
    store.spent[ORG] = 5

    with pytest.raises(ChatRefused) as refused:
        await assistant.answer(store, projects, settings, project_id, Page(), ask("anything"))

    assert refused.value.status == 409
    assert "monthly cap" in str(refused.value)


async def test_the_last_turn_must_be_the_question(store, projects, settings) -> None:
    project_id, _ = await finished_run(store, projects, settings)
    with pytest.raises(ChatRefused) as refused:
        await assistant.answer(
            store, projects, settings, project_id, Page(), [Turn(role="assistant", content="hi")]
        )
    assert refused.value.status == 422


async def test_an_unknown_project_is_404(store, projects, settings) -> None:
    with pytest.raises(ChatRefused) as refused:
        await assistant.answer(store, projects, settings, uuid4(), Page(), ask("anything"))
    assert refused.value.status == 404


def test_a_long_requirement_list_says_what_it_left_out(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(assistant, "_REQUIREMENTS_CHARS", 300)
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

    text = assistant.requirement_lines(rows)

    assert text.startswith("- R-001 [draft] UN R148 00, paragraph 5.4.2, page 4: The lamp")
    assert "more not shown" in text
    assert "R-010" in text.splitlines()[-1]


# The HTTP surface.


@pytest.fixture
def client(store: InMemoryRunStore, projects: InMemoryProjectStore, settings: Settings):
    app.dependency_overrides[get_store] = lambda: store
    app.dependency_overrides[get_project_store] = lambda: projects
    app.dependency_overrides[get_settings] = lambda: settings
    yield TestClient(app)
    app.dependency_overrides.clear()


async def test_post_chat_answers(client: TestClient, store, projects, settings) -> None:
    project_id, run_id = await finished_run(store, projects, settings)

    response = client.post(
        "/chat",
        headers=AUTH,
        json={
            "project_id": str(project_id),
            "page": {"path": f"/runs/{run_id}", "run_id": str(run_id)},
            "messages": [{"role": "user", "content": "luminous intensity"}],
        },
    )

    assert response.status_code == 200
    body = response.json()
    assert "cited by" in body["answer"]
    assert body["model"] == "scripted"
    assert set(body["usage"]) == {"input_tokens", "output_tokens", "requests", "cost_usd"}
    assert isinstance(body["notices"], list)
    assert store.closed and projects.closed


async def test_get_chat_model_names_the_organisations_chat_model(
    client: TestClient, store, projects
) -> None:
    project_id = projects.add_project("P")
    store.process_models[(ORG, "chat")] = "anthropic:claude-test"

    response = client.get("/chat/model", headers=AUTH, params={"project_id": str(project_id)})

    assert response.json() == {"model": "anthropic:claude-test"}
    assert (
        client.get("/chat/model", headers=AUTH, params={"project_id": str(uuid4())}).status_code
        == 404
    )


async def test_without_a_chat_model_it_uses_the_default_not_the_run_model(store, settings) -> None:
    store.settings[ORG] = OrganizationSettings(model="anthropic:claude-opus-5-5")
    settings.chat_model = "anthropic:claude-haiku-5-5"

    assert await assistant.model_name(store, settings, ORG) == "anthropic:claude-haiku-5-5"


async def test_an_organisation_on_its_own_ollama_server_keeps_its_questions_there(
    store, settings
) -> None:
    store.settings[ORG] = OrganizationSettings(model="ollama:qwen3:32b")
    settings.chat_model = "anthropic:claude-haiku-5-5"

    assert await assistant.model_name(store, settings, ORG) == "ollama:qwen3:32b"
    store.process_models[(ORG, "chat")] = "anthropic:claude-haiku-5-5"
    assert await assistant.model_name(store, settings, ORG) == "anthropic:claude-haiku-5-5"


def test_post_chat_needs_the_secret(client: TestClient) -> None:
    body = {"project_id": str(uuid4()), "messages": [{"role": "user", "content": "x"}]}
    assert client.post("/chat", json=body).status_code == 401
    assert client.get("/chat/model", params={"project_id": str(uuid4())}).status_code == 401


@pytest.mark.parametrize(
    "messages",
    [[], [{"role": "system", "content": "x"}], [{"role": "user", "content": "x" * 4001}]],
)
def test_post_chat_refuses_a_malformed_conversation(client: TestClient, messages) -> None:
    response = client.post(
        "/chat", headers=AUTH, json={"project_id": str(uuid4()), "messages": messages}
    )
    assert response.status_code == 422


def test_post_chat_of_an_unknown_project_is_404(client: TestClient) -> None:
    response = client.post(
        "/chat",
        headers=AUTH,
        json={"project_id": str(uuid4()), "messages": [{"role": "user", "content": "x"}]},
    )
    assert response.status_code == 404
