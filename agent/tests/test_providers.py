"""Building a model with an organisation's key. The HTTP side (checks and lists) is tested through
the endpoints in test_api.py."""

import pytest
from pydantic_ai.models import infer_model

from agent_service.providers import build_model, provider_of, scrub

KEY = "sk-test-0123456789abcdef"


@pytest.mark.parametrize(
    ("name", "provider"),
    [
        ("anthropic:claude-test", "anthropic"),
        ("openai:gpt-test", "openai"),
        ("openrouter:anthropic/claude-test", "openrouter"),
        ("deepseek:deepseek-chat", "deepseek"),
        ("scripted", None),
        ("google:gemini-test", None),
        ("anthropic", None),
    ],
)
def test_provider_of(name: str, provider: str | None) -> None:
    assert provider_of(name) == provider


@pytest.mark.parametrize(
    "name",
    [
        "anthropic:claude-test",
        "openai:gpt-test",
        "openrouter:anthropic/claude-test",
        "deepseek:deepseek-chat",
    ],
)
def test_a_key_builds_the_same_model_class_the_library_would(
    name: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    # If the library changes which class a prefix maps to, runs with an organisation's key would
    # quietly behave differently from runs with the environment's. This catches it.
    for var in ("ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OPENROUTER_API_KEY", "DEEPSEEK_API_KEY"):
        monkeypatch.setenv(var, "from-the-environment")
    built = build_model(name, KEY)
    inferred = infer_model(name)

    assert type(built) is type(inferred)
    assert not isinstance(built, str)
    assert built.model_name == inferred.model_name
    assert built.client.api_key == KEY  # pyright: ignore[reportAttributeAccessIssue]
    assert str(built.client.base_url) == str(inferred.client.base_url)  # pyright: ignore[reportAttributeAccessIssue]


def test_without_a_key_the_name_goes_to_the_library_unchanged() -> None:
    assert build_model("anthropic:claude-test", None) == "anthropic:claude-test"


def test_scripted_ignores_a_key() -> None:
    model = build_model("scripted", KEY)
    assert not isinstance(model, str)
    assert model.model_name == "scripted"


def test_scrub() -> None:
    assert scrub(f"bad key {KEY}!", KEY) == "bad key [redacted]!"
    assert scrub("nothing here", None) == "nothing here"
