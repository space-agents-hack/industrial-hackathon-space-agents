"""What an organisation changes about its runs: settings over the service's defaults, the monthly
cost cap, and its own provider key."""

import logging
from collections.abc import AsyncIterator
from uuid import uuid4

import pytest
from pydantic_ai.messages import ModelMessage, ModelResponse
from pydantic_ai.models import Model
from pydantic_ai.models.function import AgentInfo, DeltaToolCalls, FunctionModel

from agent_service import providers, runner
from agent_service.providers import Endpoint
from agent_service.records import OrganizationSettings
from agent_service.settings import RunSettings, Settings, effective
from tests.fakes import ORG, InMemoryRunStore, case_run

pytestmark = pytest.mark.anyio

# Ends without an approval: no library, so nothing to write.
HARMLESS = "Write the requirements."
ORG_KEY = "sk-org-0123456789abcdef-SECRET"


async def advance(store: InMemoryRunStore, settings: Settings, run_id) -> str:
    plan = await runner.prepare(store, settings, run_id)
    return await runner.execute(store, settings, plan)


# Settings resolution.


def test_without_a_row_the_service_defaults_apply(settings: Settings) -> None:
    settings.monthly_cost_cap_usd = 25
    assert effective(settings, None) == RunSettings("scripted", 30, 25)


def test_an_organisation_overrides_only_what_it_set(settings: Settings) -> None:
    settings.monthly_cost_cap_usd = 25
    org = OrganizationSettings(model="anthropic:claude-test", max_model_requests=None)
    assert effective(settings, org) == RunSettings("anthropic:claude-test", 30, 25)


def test_a_cap_of_zero_is_kept_not_mistaken_for_unset(settings: Settings) -> None:
    settings.monthly_cost_cap_usd = 25
    assert (
        effective(settings, OrganizationSettings(monthly_cost_cap_usd=0)).monthly_cost_cap_usd == 0
    )


async def test_the_organisation_request_limit_reaches_the_run(store, settings) -> None:
    store.settings[ORG] = OrganizationSettings(max_model_requests=2)
    run_id = case_run(store)

    assert await advance(store, settings, run_id) == "failed"
    assert "usage limit" in (store.errors[run_id] or "")


async def test_another_organisations_settings_do_not_apply(store, settings) -> None:
    store.settings[uuid4()] = OrganizationSettings(max_model_requests=1)
    run_id = store.add_run(HARMLESS)

    assert await advance(store, settings, run_id) == "succeeded"


# The monthly cost cap.


async def test_a_new_run_past_the_cap_fails_before_any_model_call(store, settings) -> None:
    settings.monthly_cost_cap_usd = 10
    store.spent[ORG] = 10.5
    run_id = case_run(store)

    with pytest.raises(runner.CannotAdvance) as refused:
        await runner.prepare(store, settings, run_id)

    message = (
        "This organisation has reached its monthly cap of $10.00 ($10.50 spent this month). "
        "An admin can raise it in Admin, Models and limits."
    )
    assert str(refused.value) == message
    assert store.runs[run_id].status == "failed"
    assert store.errors[run_id] == message
    assert run_id not in store.models, "the run was claimed"
    assert store.kinds(run_id) == ["error", "status"]


async def test_reaching_the_cap_exactly_counts_as_reached(store, settings) -> None:
    store.settings[ORG] = OrganizationSettings(monthly_cost_cap_usd=5)
    store.spent[ORG] = 5
    run_id = store.add_run(HARMLESS)

    with pytest.raises(runner.CannotAdvance, match=r"monthly cap of \$5\.00"):
        await runner.prepare(store, settings, run_id)


async def test_the_organisation_cap_replaces_the_service_cap(store, settings) -> None:
    settings.monthly_cost_cap_usd = 10
    store.settings[ORG] = OrganizationSettings(monthly_cost_cap_usd=100)
    store.spent[ORG] = 50
    run_id = store.add_run(HARMLESS)

    assert await advance(store, settings, run_id) == "succeeded"


async def test_without_a_cap_spending_is_not_limited(store, settings) -> None:
    store.spent[ORG] = 1_000_000
    run_id = store.add_run(HARMLESS)

    assert await advance(store, settings, run_id) == "succeeded"


async def test_another_organisations_spending_does_not_count(store, settings) -> None:
    settings.monthly_cost_cap_usd = 10
    store.spent[uuid4()] = 500
    run_id = store.add_run(HARMLESS)

    assert await advance(store, settings, run_id) == "succeeded"


async def test_an_approved_run_resumes_even_past_the_cap(store, settings) -> None:
    settings.monthly_cost_cap_usd = 10
    run_id = case_run(store)
    assert await advance(store, settings, run_id) == "awaiting_approval"
    # Other runs spent the rest of the month's budget while this one waited for a person.
    store.spent[ORG] = 12
    store.decide(run_id, "approved")

    assert await advance(store, settings, run_id) == "succeeded"
    assert {r.status for r in await store.run_requirements(run_id)} == {"approved", "rejected"}


# The organisation's own key.


class BuildSpy:
    def __init__(self) -> None:
        self.calls: list[tuple[str, str | None]] = []
        self.endpoints: list[Endpoint | None] = []

    def __call__(
        self, name: str, api_key: str | None, endpoint: Endpoint | None = None
    ) -> Model | str:
        self.calls.append((name, api_key))
        self.endpoints.append(endpoint)
        # The scripted model stands in for the provider so nothing leaves the machine.
        return providers.build_model("scripted", None)


@pytest.fixture
def spy(monkeypatch: pytest.MonkeyPatch) -> BuildSpy:
    spy = BuildSpy()
    monkeypatch.setattr(runner, "build_model", spy)
    return spy


async def test_the_organisations_key_is_used_for_its_model(store, settings, spy) -> None:
    store.settings[ORG] = OrganizationSettings(model="anthropic:claude-test")
    store.keys[(ORG, "anthropic")] = ORG_KEY
    store.keys[(ORG, "openai")] = "sk-not-this-one-0123456789"
    run_id = store.add_run(HARMLESS)

    assert await advance(store, settings, run_id) == "succeeded"

    assert spy.calls == [("anthropic:claude-test", ORG_KEY)]
    # The run records the model it actually used, not the service default.
    assert store.models[run_id] == "anthropic:claude-test"


async def test_a_model_asked_for_one_run_replaces_the_organisations(store, settings, spy) -> None:
    # Comparing models on the same case (SYS-33): the run's own choice wins, with the
    # organisation's key for that provider, and the run records what it really used.
    store.settings[ORG] = OrganizationSettings(model="anthropic:claude-opus-test")
    store.keys[(ORG, "anthropic")] = ORG_KEY
    run_id = store.add_run(HARMLESS, requested_model="anthropic:claude-sonnet-test")

    assert await advance(store, settings, run_id) == "succeeded"

    assert spy.calls == [("anthropic:claude-sonnet-test", ORG_KEY)]
    assert store.models[run_id] == "anthropic:claude-sonnet-test"


async def test_without_a_key_the_environment_is_used(store, settings, spy) -> None:
    settings.agent_model = "openai:gpt-test"
    store.keys[(uuid4(), "openai")] = "another-organisations-key-0123"
    run_id = store.add_run(HARMLESS)

    assert await advance(store, settings, run_id) == "succeeded"

    assert spy.calls == [("openai:gpt-test", None)]
    assert store.models[run_id] == "openai:gpt-test"


async def test_scripted_never_reads_a_key(store, settings, spy) -> None:
    store.keys[(ORG, "anthropic")] = ORG_KEY
    run_id = store.add_run(HARMLESS)

    await advance(store, settings, run_id)

    assert spy.calls == [("scripted", None)]


async def test_the_organisations_ollama_server_is_used_for_its_model(store, settings, spy) -> None:
    store.settings[ORG] = OrganizationSettings(model="ollama:qwen3:32b")
    server = Endpoint("https://ollama.example.test", "bearer", None, ORG_KEY)
    store.endpoints[(ORG, "ollama")] = server
    store.keys[(ORG, "ollama")] = "never-read-as-a-key-0123456789"
    run_id = store.add_run(HARMLESS)

    assert await advance(store, settings, run_id) == "succeeded"

    # The token is passed as the secret to scrub every error of; the server builds the model.
    assert spy.calls == [("ollama:qwen3:32b", ORG_KEY)]
    assert spy.endpoints == [server]


def _leaky_model(key: str) -> FunctionModel:
    def fail(_messages: list[ModelMessage], _info: AgentInfo) -> ModelResponse:
        raise RuntimeError(f"401 from provider: invalid api key {key!r}")

    async def fail_stream(
        _messages: list[ModelMessage], _info: AgentInfo
    ) -> AsyncIterator[str | DeltaToolCalls]:
        raise RuntimeError(f"401 from provider: invalid api key {key!r}")
        yield ""  # pragma: no cover

    return FunctionModel(fail, stream_function=fail_stream)


async def test_a_provider_error_quoting_the_key_is_scrubbed_everywhere(
    store, settings, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    store.settings[ORG] = OrganizationSettings(model="anthropic:claude-test")
    store.keys[(ORG, "anthropic")] = ORG_KEY
    monkeypatch.setattr(runner, "build_model", lambda _name, key, _endpoint=None: _leaky_model(key))
    run_id = store.add_run(HARMLESS)

    with caplog.at_level(logging.DEBUG):
        assert await advance(store, settings, run_id) == "failed"

    error = store.errors[run_id] or ""
    assert "invalid api key" in error
    assert providers.REDACTED in error
    assert ORG_KEY not in error
    assert ORG_KEY not in repr(store.events)
    assert "invalid api key" in caplog.text
    assert ORG_KEY not in caplog.text


async def test_a_real_provider_model_with_the_key_stays_offline_and_quiet(store, settings) -> None:
    # The real path, unpatched: the library's guard (conftest) refuses the request.
    store.settings[ORG] = OrganizationSettings(model="anthropic:claude-test")
    store.keys[(ORG, "anthropic")] = ORG_KEY
    run_id = store.add_run(HARMLESS)

    assert await advance(store, settings, run_id) == "failed"

    assert ORG_KEY not in (store.errors[run_id] or "")
    assert ORG_KEY not in repr(store.events)
