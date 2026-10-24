"""Building a model with an organisation's key. The HTTP side (checks and lists) is tested through
the endpoints in test_api.py."""

import httpx
import pydantic_ai.models
import pytest
from pydantic_ai import Agent
from pydantic_ai.models import infer_model
from pydantic_ai.models.openai import OpenAIChatModel

from agent_service import providers
from agent_service.providers import Endpoint, build_model, provider_of, scrub

KEY = "sk-test-0123456789abcdef"


@pytest.mark.parametrize(
    ("name", "provider"),
    [
        ("anthropic:claude-test", "anthropic"),
        ("openai:gpt-test", "openai"),
        ("openrouter:anthropic/claude-test", "openrouter"),
        ("deepseek:deepseek-chat", "deepseek"),
        ("ollama:llama3.1:8b", "ollama"),
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


# Ollama: the organisation's own server.


@pytest.mark.parametrize(
    "url",
    [
        "http://gpu-box:11434",
        "http://gpu-box:11434/",
        "http://gpu-box:11434/v1",
        "http://gpu-box:11434/v1/",
        "http://gpu-box:11434/api",
    ],
)
def test_an_ollama_url_means_the_server_however_it_was_pasted(url: str) -> None:
    assert Endpoint(url).root() == "http://gpu-box:11434"


def test_an_ollama_server_builds_a_chat_model_on_its_openai_path() -> None:
    model = build_model("ollama:llama3.1:8b", None, Endpoint("http://gpu-box:11434"))

    assert isinstance(model, OpenAIChatModel)
    # Everything after the first colon is the model, tag included.
    assert model.model_name == "llama3.1:8b"
    assert str(model.client.base_url) == "http://gpu-box:11434/v1/"


def test_without_a_server_ollama_goes_to_the_library_and_its_environment() -> None:
    # OLLAMA_BASE_URL then applies: the agent and the server on the same machine.
    assert build_model("ollama:llama3.1:8b", None) == "ollama:llama3.1:8b"
    # A key alone is not a server.
    assert build_model("ollama:llama3.1:8b", KEY) == "ollama:llama3.1:8b"


CHAT_ANSWER = {
    "id": "x",
    "object": "chat.completion",
    "created": 0,
    "model": "llama3.1:8b",
    "choices": [
        {"index": 0, "finish_reason": "stop", "message": {"role": "assistant", "content": "hi"}}
    ],
    "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2},
}


@pytest.mark.anyio
@pytest.mark.parametrize(
    ("endpoint", "authorization"),
    [
        (Endpoint("http://gpu-box:11434"), "Bearer none"),
        (Endpoint("https://proxy.test/ollama", "bearer", None, KEY), f"Bearer {KEY}"),
        # base64("eng:" + KEY)
        (
            Endpoint("https://proxy.test/ollama", "basic", "eng", KEY),
            "Basic ZW5nOnNrLXRlc3QtMDEyMzQ1Njc4OWFiY2RlZg==",
        ),
    ],
)
async def test_one_authorization_header_reaches_the_server_on_a_run(
    endpoint: Endpoint, authorization: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    # What a proxy in front of Ollama sees. Two Authorization headers, or the client's
    # placeholder bearer winning over basic auth, would be refused there and nowhere else.
    seen: list[httpx.Request] = []
    # The request is answered by the mock transport below; nothing leaves the machine.
    monkeypatch.setattr(pydantic_ai.models, "ALLOW_MODEL_REQUESTS", True)

    def answer(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200, json=CHAT_ANSWER)

    async with httpx.AsyncClient(transport=httpx.MockTransport(answer)) as http:
        model = providers._ollama_model("llama3.1:8b", endpoint, http)  # pyright: ignore[reportPrivateUsage]
        result = await Agent(model).run("hello")

    assert result.output == "hi"
    [request] = seen
    assert str(request.url) == f"{endpoint.root()}/v1/chat/completions"
    assert request.headers.get_list("authorization") == [authorization]
