import asyncio
import json
from collections.abc import AsyncIterator, Iterator
from uuid import UUID, uuid4

import httpx
import pytest
from fastapi.testclient import TestClient

from agent_service import api, providers
from agent_service.api import app, get_http, get_store
from agent_service.records import OrganizationSettings
from agent_service.settings import Settings, get_settings
from tests.fakes import ORG, InMemoryRunStore

AUTH = {"Authorization": "Bearer test-secret"}
KEY = "sk-test-0123456789abcdef-SECRET"


@pytest.fixture
def client(store: InMemoryRunStore, settings: Settings):
    app.dependency_overrides[get_store] = lambda: store
    app.dependency_overrides[get_settings] = lambda: settings
    yield TestClient(app)
    app.dependency_overrides.clear()


def test_health_needs_no_secret_and_names_the_model(client: TestClient) -> None:
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json()["status"] == "ok"
    assert response.json()["model"] == "scripted"


@pytest.mark.parametrize("headers", [{}, {"Authorization": "Bearer wrong"}, {"Authorization": "x"}])
def test_advance_rejects_a_missing_or_wrong_secret(client: TestClient, headers) -> None:
    assert client.post(f"/runs/{uuid4()}/advance", headers=headers).status_code == 401


def test_advance_refuses_to_work_without_a_configured_secret(
    client: TestClient, settings: Settings
) -> None:
    # An unset secret must not mean "open to everyone".
    settings.agent_shared_secret = None
    assert client.post(f"/runs/{uuid4()}/advance", headers=AUTH).status_code == 503


def test_advance_of_an_unknown_run_is_404(client: TestClient) -> None:
    assert client.post(f"/runs/{uuid4()}/advance", headers=AUTH).status_code == 404


def test_advance_of_a_malformed_id_is_422(client: TestClient) -> None:
    assert client.post("/runs/not-a-uuid/advance", headers=AUTH).status_code == 422


def test_advance_streams_accepted_then_done(client: TestClient, store: InMemoryRunStore) -> None:
    run_id = store.add_run("Triage ECN-1001.")

    response = client.post(f"/runs/{run_id}/advance", headers=AUTH)

    assert response.status_code == 200
    assert response.headers["content-type"].startswith("application/x-ndjson")
    lines = [json.loads(line) for line in response.text.splitlines()]
    assert lines[0] == {"event": "accepted", "run_id": str(run_id)}
    assert lines[-1] == {"event": "done", "status": "awaiting_approval"}
    assert store.runs[run_id].status == "awaiting_approval"
    assert store.closed


def test_advance_of_a_run_waiting_for_a_person_is_409(
    client: TestClient, store: InMemoryRunStore
) -> None:
    run_id = store.add_run("Triage ECN-1001.")
    client.post(f"/runs/{run_id}/advance", headers=AUTH)

    response = client.post(f"/runs/{run_id}/advance", headers=AUTH)

    assert response.status_code == 409
    assert "pending" in response.json()["detail"]


def test_ready_needs_the_secret_and_reaches_the_store(client: TestClient) -> None:
    assert client.get("/ready").status_code == 401
    response = client.get("/ready", headers=AUTH)
    assert response.status_code == 200
    assert response.json() == {"status": "ok", "database": "ok", "model": "scripted"}


def test_ready_reports_a_database_that_does_not_answer(
    client: TestClient, store: InMemoryRunStore
) -> None:
    async def broken(_run_id):
        raise ConnectionError("down")

    store.get_run = broken  # type: ignore[method-assign]
    response = client.get("/ready", headers=AUTH)
    assert response.status_code == 503
    assert "ConnectionError" in response.json()["detail"]


# The admin and provider endpoints. Provider APIs are answered by an httpx.MockTransport.

ADMIN_ENDPOINTS = [
    ("POST", "/admin/users", {"email": "ana@example.test", "password": "long-enough-password"}),
    ("POST", "/admin/users/password", {"user_id": str(uuid4()), "password": "long-enough-pw"}),
    ("POST", "/providers/check", {"provider": "openai", "api_key": KEY}),
    ("GET", f"/providers/models?organization_id={ORG}&provider=openrouter", None),
]


class ProviderApi:
    """Answers by URL; records what was asked so tests can check headers and counts."""

    def __init__(self) -> None:
        self.answers: dict[str, httpx.Response | Exception] = {}
        self.requests: list[httpx.Request] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        answer = self.answers.get(str(request.url))
        if answer is None:
            return httpx.Response(599, text=f"unexpected request to {request.url}")
        if isinstance(answer, Exception):
            raise answer
        return answer


@pytest.fixture
def provider_api() -> Iterator[ProviderApi]:
    api = ProviderApi()

    async def http() -> AsyncIterator[httpx.AsyncClient]:
        async with httpx.AsyncClient(transport=httpx.MockTransport(api)) as client:
            yield client

    app.dependency_overrides[get_http] = http
    providers.clear_catalogue_cache()
    yield api
    providers.clear_catalogue_cache()


@pytest.mark.parametrize(("method", "path", "body"), ADMIN_ENDPOINTS)
@pytest.mark.parametrize("headers", [{}, {"Authorization": "Bearer wrong"}])
def test_admin_endpoints_need_the_secret(
    client: TestClient, provider_api: ProviderApi, method, path, body, headers
) -> None:
    response = client.request(method, path, json=body, headers=headers)
    assert response.status_code == 401
    assert provider_api.requests == []


def test_a_new_user_is_created(client: TestClient, store: InMemoryRunStore) -> None:
    response = client.post(
        "/admin/users",
        json={"email": " Ana@Example.test ", "password": "long-enough-password"},
        headers=AUTH,
    )
    assert response.status_code == 200
    body = response.json()
    assert body["created"] is True
    assert store.users[UUID(body["user_id"])] == ("ana@example.test", "long-enough-password")
    assert store.closed


def test_an_existing_user_is_returned_and_left_alone(
    client: TestClient, store: InMemoryRunStore
) -> None:
    user_id, _ = asyncio.run(store.create_user("ana@example.test", "original-password"))

    response = client.post(
        "/admin/users",
        json={"email": "ana@example.test", "password": "a-different-password"},
        headers=AUTH,
    )

    assert response.json() == {"user_id": str(user_id), "created": False}
    assert store.users[user_id][1] == "original-password"


@pytest.mark.parametrize(
    "body",
    [
        {"email": "not-an-email", "password": "long-enough-password"},
        {"email": "ana@localhost", "password": "long-enough-password"},
        {"email": "ana@example.test", "password": "short-pw"},
        {"email": "ana@example.test", "password": "x" * 73},
        {"email": "ana@example.test"},
    ],
)
def test_a_new_user_needs_an_email_and_a_strong_password(
    client: TestClient, store: InMemoryRunStore, body
) -> None:
    response = client.post("/admin/users", json=body, headers=AUTH)
    assert response.status_code == 422
    assert store.users == {}
    # A rejected password is not repeated back in the error.
    assert body.get("password", "\0") not in response.text


def test_a_password_is_set(client: TestClient, store: InMemoryRunStore) -> None:
    user_id, _ = asyncio.run(store.create_user("ana@example.test", "original-password"))

    response = client.post(
        "/admin/users/password",
        json={"user_id": str(user_id), "password": "a-brand-new-password"},
        headers=AUTH,
    )

    assert response.status_code == 200
    assert store.users[user_id][1] == "a-brand-new-password"


def test_a_password_for_an_unknown_user_is_404(client: TestClient) -> None:
    response = client.post(
        "/admin/users/password",
        json={"user_id": str(uuid4()), "password": "a-brand-new-password"},
        headers=AUTH,
    )
    assert response.status_code == 404


@pytest.mark.parametrize(
    "body",
    [
        {"user_id": "not-a-uuid", "password": "a-brand-new-password"},
        {"user_id": str(uuid4()), "password": "too-short"},
    ],
)
def test_a_new_password_is_validated(client: TestClient, body) -> None:
    response = client.post("/admin/users/password", json=body, headers=AUTH)
    assert response.status_code == 422
    assert body["password"] not in response.text


CHECK_URLS = {
    "anthropic": "https://api.anthropic.com/v1/models",
    "openai": "https://api.openai.com/v1/models",
    "openrouter": "https://openrouter.ai/api/v1/key",
    "deepseek": "https://api.deepseek.com/models",
}


@pytest.mark.parametrize("provider", list(CHECK_URLS))
def test_a_good_key_is_accepted(
    client: TestClient, provider_api: ProviderApi, provider: str
) -> None:
    provider_api.answers[CHECK_URLS[provider]] = httpx.Response(200, json={"data": []})

    response = client.post(
        "/providers/check", json={"provider": provider, "api_key": KEY}, headers=AUTH
    )

    assert response.json() == {"ok": True, "detail": "The provider accepted this key."}
    [request] = provider_api.requests
    if provider == "anthropic":
        assert request.headers["x-api-key"] == KEY
        assert request.headers["anthropic-version"] == "2023-06-01"
    else:
        assert request.headers["authorization"] == f"Bearer {KEY}"


@pytest.mark.parametrize("status", [401, 403])
def test_a_rejected_key_says_so(client: TestClient, provider_api: ProviderApi, status) -> None:
    provider_api.answers[CHECK_URLS["openai"]] = httpx.Response(
        status, json={"error": f"Incorrect API key provided: {KEY}"}
    )

    response = client.post(
        "/providers/check", json={"provider": "openai", "api_key": KEY}, headers=AUTH
    )

    assert response.status_code == 200
    assert response.json() == {"ok": False, "detail": "The provider rejected this key."}
    assert KEY not in response.text


def test_an_unreachable_provider_is_not_ok(client: TestClient, provider_api: ProviderApi) -> None:
    provider_api.answers[CHECK_URLS["deepseek"]] = httpx.ConnectError(f"refused, key was {KEY}")

    response = client.post(
        "/providers/check", json={"provider": "deepseek", "api_key": KEY}, headers=AUTH
    )

    body = response.json()
    assert body["ok"] is False
    assert body["detail"].startswith("Could not reach deepseek (ConnectError")
    assert KEY not in response.text


def test_a_provider_that_does_not_answer_in_time_is_not_ok(
    client: TestClient, provider_api: ProviderApi
) -> None:
    provider_api.answers[CHECK_URLS["anthropic"]] = httpx.ReadTimeout("slow")

    response = client.post(
        "/providers/check", json={"provider": "anthropic", "api_key": KEY}, headers=AUTH
    )

    assert response.json() == {"ok": False, "detail": "anthropic did not answer within 10 s."}


@pytest.mark.parametrize(
    "body",
    [
        {"provider": "scripted", "api_key": KEY},
        {"provider": "google", "api_key": KEY},
        {"provider": "openai", "api_key": "   "},
        {"provider": "openai"},
    ],
)
def test_a_key_check_is_validated(client: TestClient, provider_api: ProviderApi, body) -> None:
    response = client.post("/providers/check", json=body, headers=AUTH)
    assert response.status_code == 422
    assert provider_api.requests == []
    assert KEY not in response.text


OPENROUTER_CATALOGUE = {
    "data": [
        {
            "id": "openai/gpt-test",
            "name": "OpenAI: GPT Test",
            "pricing": {"prompt": "0.00000125", "completion": "0.00001"},
        },
        {
            "id": "anthropic/claude-test",
            "name": "Anthropic: Claude Test",
            "pricing": {"prompt": "0.000003", "completion": "0.000015"},
        },
        {
            "id": "openrouter/auto",
            "name": "Auto Router",
            "pricing": {"prompt": "-1", "completion": "-1"},
        },
        {"id": "mystery/no-price", "name": "Mystery"},
        {"id": "free/model", "name": "a free model", "pricing": {"prompt": "0", "completion": "0"}},
    ]
}


def test_openrouter_models_come_from_the_public_catalogue_with_prices_per_million(
    client: TestClient, provider_api: ProviderApi
) -> None:
    provider_api.answers["https://openrouter.ai/api/v1/models"] = httpx.Response(
        200, json=OPENROUTER_CATALOGUE
    )
    url = f"/providers/models?organization_id={ORG}&provider=openrouter"

    response = client.get(url, headers=AUTH)

    assert response.status_code == 200
    assert response.json()["models"] == [
        {
            "id": "openrouter:free/model",
            "label": "a free model",
            "prompt_usd_per_mtok": 0.0,
            "completion_usd_per_mtok": 0.0,
        },
        {
            "id": "openrouter:anthropic/claude-test",
            "label": "Anthropic: Claude Test",
            "prompt_usd_per_mtok": 3.0,
            "completion_usd_per_mtok": 15.0,
        },
        {
            "id": "openrouter:openai/gpt-test",
            "label": "OpenAI: GPT Test",
            "prompt_usd_per_mtok": 1.25,
            "completion_usd_per_mtok": 10.0,
        },
    ]
    # No key is needed or sent for the public list.
    assert "authorization" not in provider_api.requests[0].headers

    # Cached: a second page load does not fetch it again.
    assert client.get(url, headers=AUTH).json() == response.json()
    assert len(provider_api.requests) == 1


def test_an_unreachable_catalogue_is_a_502_and_not_cached(
    client: TestClient, provider_api: ProviderApi
) -> None:
    url = f"/providers/models?organization_id={ORG}&provider=openrouter"
    provider_api.answers["https://openrouter.ai/api/v1/models"] = httpx.Response(503)
    assert client.get(url, headers=AUTH).status_code == 502

    provider_api.answers["https://openrouter.ai/api/v1/models"] = httpx.Response(
        200, json=OPENROUTER_CATALOGUE
    )
    assert len(client.get(url, headers=AUTH).json()["models"]) == 3


@pytest.mark.parametrize("provider", ["anthropic", "openai", "deepseek"])
def test_listing_without_a_connected_key_is_409(
    client: TestClient, store: InMemoryRunStore, provider_api: ProviderApi, provider: str
) -> None:
    # A key in another organisation does not count.
    store.keys[(uuid4(), provider)] = KEY
    response = client.get(
        f"/providers/models?organization_id={ORG}&provider={provider}", headers=AUTH
    )
    assert response.status_code == 409
    assert response.json() == {"detail": f"No {provider} key is connected for this organisation."}
    assert provider_api.requests == []


def test_anthropic_models_are_listed_with_the_organisations_key(
    client: TestClient, store: InMemoryRunStore, provider_api: ProviderApi
) -> None:
    store.keys[(ORG, "anthropic")] = KEY
    provider_api.answers["https://api.anthropic.com/v1/models?limit=1000"] = httpx.Response(
        200,
        json={
            "data": [
                {"id": "claude-opus-4-1", "display_name": "Claude Opus 4.1"},
                {"id": "claude-unknown-9", "display_name": "Claude Unknown 9"},
            ],
            "has_more": False,
        },
    )

    response = client.get(
        f"/providers/models?organization_id={ORG}&provider=anthropic", headers=AUTH
    )

    assert response.status_code == 200
    assert response.json()["models"] == [
        {
            "id": "anthropic:claude-opus-4-1",
            "label": "Claude Opus 4.1",
            # From the price list the runner uses to record cost (genai-prices).
            "prompt_usd_per_mtok": 15.0,
            "completion_usd_per_mtok": 75.0,
        },
        {
            "id": "anthropic:claude-unknown-9",
            "label": "Claude Unknown 9",
            "prompt_usd_per_mtok": None,
            "completion_usd_per_mtok": None,
        },
    ]
    assert provider_api.requests[0].headers["x-api-key"] == KEY
    assert KEY not in response.text


def test_openai_models_that_cannot_chat_are_left_out(
    client: TestClient, store: InMemoryRunStore, provider_api: ProviderApi
) -> None:
    store.keys[(ORG, "openai")] = KEY
    ids = ["gpt-4o", "text-embedding-3-small", "whisper-1", "o3", "tts-1", "dall-e-3"]
    provider_api.answers["https://api.openai.com/v1/models"] = httpx.Response(
        200, json={"data": [{"id": i, "object": "model"} for i in ids]}
    )

    response = client.get(f"/providers/models?organization_id={ORG}&provider=openai", headers=AUTH)

    assert [m["id"] for m in response.json()["models"]] == ["openai:gpt-4o", "openai:o3"]
    assert provider_api.requests[0].headers["authorization"] == f"Bearer {KEY}"


def test_a_stored_key_the_provider_rejects_is_a_502(
    client: TestClient, store: InMemoryRunStore, provider_api: ProviderApi
) -> None:
    store.keys[(ORG, "deepseek")] = KEY
    provider_api.answers["https://api.deepseek.com/models"] = httpx.Response(401)

    response = client.get(
        f"/providers/models?organization_id={ORG}&provider=deepseek", headers=AUTH
    )

    assert response.status_code == 502
    assert "rejected the stored key" in response.json()["detail"]


@pytest.mark.parametrize(
    "query",
    [
        f"organization_id={ORG}&provider=scripted",
        "organization_id=not-a-uuid&provider=openrouter",
        "provider=openrouter",
        f"organization_id={ORG}",
    ],
)
def test_a_model_list_request_is_validated(
    client: TestClient, provider_api: ProviderApi, query: str
) -> None:
    assert client.get(f"/providers/models?{query}", headers=AUTH).status_code == 422
    assert provider_api.requests == []


def test_ingest_parses_a_case_and_streams_the_counts(
    client: TestClient, store: InMemoryRunStore
) -> None:
    case_id = uuid4()
    store.add_case_file(case_id, "spec.md", "md", b"M1")
    store.add_case_file(case_id, "broken.pdf", "pdf", b"not a pdf")

    response = client.post(f"/cases/{case_id}/ingest", headers=AUTH)

    lines = [json.loads(line) for line in response.text.splitlines()]
    assert lines[0] == {"event": "accepted", "case_id": str(case_id)}
    assert lines[-1] == {"event": "done", "parsed": "1", "failed": "1"}
    assert store.closed


def test_ingest_uses_the_organisations_transcription_model(
    client: TestClient, store: InMemoryRunStore, monkeypatch: pytest.MonkeyPatch
) -> None:
    # Admin, Other agents and processes (SYS-33): the organisation's row beats INGEST_MODEL,
    # with the organisation's key for that model's provider.
    built: list[tuple[str, str | None]] = []
    real = providers.build_model

    def build(name: str, key: str | None, endpoint: object = None):
        built.append((name, key))
        return real("scripted", None)

    monkeypatch.setattr(providers, "build_model", build)
    store.process_models[(ORG, "transcription")] = "anthropic:claude-org-choice"
    store.keys[(ORG, "anthropic")] = KEY
    case_id = uuid4()
    store.add_case_file(case_id, "spec.md", "md", b"M1")

    response = client.post(f"/cases/{case_id}/ingest", headers=AUTH)

    assert response.status_code == 200
    assert built == [("anthropic:claude-org-choice", KEY)]


def test_health_names_each_process_default(client: TestClient, settings: Settings) -> None:
    processes = client.get("/health").json()["processes"]
    assert processes["transcription"] == settings.ingest_model
    assert processes["embedding"] == settings.embedding_model


def test_ingest_needs_the_secret_and_a_case_with_files(client: TestClient) -> None:
    assert client.post(f"/cases/{uuid4()}/ingest").status_code == 401
    assert client.post(f"/cases/{uuid4()}/ingest", headers=AUTH).status_code == 404


# Ollama: a server the organisation runs, reached at its URL, sometimes behind a proxy.

OLLAMA = "https://ollama.example.test:8443/proxy"
OLLAMA_TAGS = {
    "models": [
        {"name": "qwen3:32b", "model": "qwen3:32b", "details": {"parameter_size": "32.8B"}},
        {"name": "llama3.1:8b", "model": "llama3.1:8b", "details": {"family": "llama"}},
        {
            "name": "nomic-embed-text:latest",
            "model": "nomic-embed-text:latest",
            "details": {"family": "nomic-bert", "families": ["nomic-bert"]},
        },
        {"name": "bge-m3:latest", "model": "bge-m3:latest", "details": {"families": ["bert"]}},
    ]
}


def _ollama_check(**fields: object) -> dict[str, object]:
    return {"organization_id": str(ORG), "provider": "ollama", "base_url": OLLAMA, **fields}


def test_an_ollama_server_is_checked_with_its_credentials(
    client: TestClient, provider_api: ProviderApi
) -> None:
    provider_api.answers[f"{OLLAMA}/api/tags"] = httpx.Response(200, json=OLLAMA_TAGS)

    response = client.post(
        "/providers/endpoint/check",
        json=_ollama_check(auth_scheme="basic", username="eng", secret=KEY),
        headers=AUTH,
    )

    assert response.json() == {"ok": True, "detail": "The server answered with 2 chat model(s)."}
    [request] = provider_api.requests
    assert request.headers["authorization"].startswith("Basic ")
    assert KEY not in response.text


def test_an_ollama_check_reuses_the_stored_secret_when_none_is_typed(
    client: TestClient, store: InMemoryRunStore, provider_api: ProviderApi
) -> None:
    store.endpoints[(ORG, "ollama")] = providers.Endpoint(OLLAMA, "bearer", None, KEY)
    provider_api.answers[f"{OLLAMA}/api/tags"] = httpx.Response(200, json={"models": []})

    response = client.post(
        "/providers/endpoint/check", json=_ollama_check(auth_scheme="bearer"), headers=AUTH
    )

    assert response.json()["ok"] is True
    assert provider_api.requests[0].headers["authorization"] == f"Bearer {KEY}"
    assert store.closed


def test_an_ollama_check_without_a_secret_to_reuse_is_422(
    client: TestClient, store: InMemoryRunStore, provider_api: ProviderApi
) -> None:
    # Stored with basic auth: its password is no bearer token.
    store.endpoints[(ORG, "ollama")] = providers.Endpoint(OLLAMA, "basic", "eng", KEY)

    response = client.post(
        "/providers/endpoint/check", json=_ollama_check(auth_scheme="bearer"), headers=AUTH
    )

    assert response.status_code == 422
    assert provider_api.requests == []


@pytest.mark.parametrize(
    ("answer", "detail"),
    [
        (httpx.Response(401), "The server refused these credentials."),
        (httpx.Response(200, text="<html>router login</html>"), "not like Ollama"),
        (httpx.ConnectError("connection refused"), "Could not reach ollama"),
    ],
)
def test_an_ollama_server_that_does_not_answer_right_says_why(
    client: TestClient, provider_api: ProviderApi, answer, detail: str
) -> None:
    provider_api.answers[f"{OLLAMA}/api/tags"] = answer

    response = client.post(
        "/providers/endpoint/check",
        json=_ollama_check(auth_scheme="bearer", secret=KEY),
        headers=AUTH,
    )

    assert response.json()["ok"] is False
    assert detail in response.json()["detail"]
    # Whatever answered at the URL is not echoed back.
    assert "router login" not in response.text


@pytest.mark.parametrize(
    "fields",
    [
        {"base_url": "http://admin:pw@ollama.internal:11434"},
        {"base_url": "file:///etc/passwd"},
        {"base_url": "http://ollama.internal:11434/?x=1"},
        {"auth_scheme": "digest"},
        {"provider": "openai"},
    ],
)
def test_an_ollama_check_is_validated(
    client: TestClient, provider_api: ProviderApi, fields: dict[str, str]
) -> None:
    body = {**_ollama_check(auth_scheme="none"), **fields}
    response = client.post("/providers/endpoint/check", json=body, headers=AUTH)
    assert response.status_code == 422
    assert provider_api.requests == []
    assert "pw@" not in response.text


def test_an_ollama_server_is_not_checked_as_a_key(
    client: TestClient, provider_api: ProviderApi
) -> None:
    response = client.post(
        "/providers/check", json={"provider": "ollama", "api_key": KEY}, headers=AUTH
    )
    assert response.status_code == 422
    assert provider_api.requests == []


def test_ollama_models_are_the_chat_models_pulled_on_the_server_and_free(
    client: TestClient, store: InMemoryRunStore, provider_api: ProviderApi
) -> None:
    store.endpoints[(ORG, "ollama")] = providers.Endpoint(f"{OLLAMA}/v1/", "none")
    provider_api.answers[f"{OLLAMA}/api/tags"] = httpx.Response(200, json=OLLAMA_TAGS)

    response = client.get(f"/providers/models?organization_id={ORG}&provider=ollama", headers=AUTH)

    assert response.json()["models"] == [
        {
            "id": "ollama:llama3.1:8b",
            "label": "llama3.1:8b",
            "prompt_usd_per_mtok": 0.0,
            "completion_usd_per_mtok": 0.0,
        },
        {
            "id": "ollama:qwen3:32b",
            "label": "qwen3:32b (32.8B)",
            "prompt_usd_per_mtok": 0.0,
            "completion_usd_per_mtok": 0.0,
        },
    ]
    assert "authorization" not in provider_api.requests[0].headers


def test_ollama_models_without_a_server_is_409(
    client: TestClient, store: InMemoryRunStore, provider_api: ProviderApi
) -> None:
    store.endpoints[(uuid4(), "ollama")] = providers.Endpoint(OLLAMA)
    response = client.get(f"/providers/models?organization_id={ORG}&provider=ollama", headers=AUTH)
    assert response.status_code == 409
    assert provider_api.requests == []


def test_an_ollama_server_refusing_the_stored_credentials_is_a_502(
    client: TestClient, store: InMemoryRunStore, provider_api: ProviderApi
) -> None:
    store.endpoints[(ORG, "ollama")] = providers.Endpoint(OLLAMA, "bearer", None, KEY)
    provider_api.answers[f"{OLLAMA}/api/tags"] = httpx.Response(403)

    response = client.get(f"/providers/models?organization_id={ORG}&provider=ollama", headers=AUTH)

    assert response.status_code == 502
    assert "Update the server in Admin, Providers" in response.json()["detail"]


@pytest.mark.parametrize(
    ("org_model", "ingest_model", "transcribes"),
    [
        ("ollama:qwen3:32b", "anthropic:claude-haiku-test", False),
        ("ollama:qwen3:32b", "ollama:qwen2.5vl:7b", True),
        ("anthropic:claude-test", "anthropic:claude-haiku-test", True),
    ],
)
def test_an_organisation_on_its_own_server_never_sends_case_files_to_a_hosted_model(
    client: TestClient,
    store: InMemoryRunStore,
    settings: Settings,
    monkeypatch: pytest.MonkeyPatch,
    org_model: str,
    ingest_model: str,
    transcribes: bool,
) -> None:
    store.settings[ORG] = OrganizationSettings(model=org_model)
    store.endpoints[(ORG, "ollama")] = providers.Endpoint(OLLAMA)
    settings.ingest_model = ingest_model
    seen: list[object] = []

    async def fake_ingest(_store, _case_id, *, transcribe, **_kwargs) -> dict[str, int]:
        seen.append(transcribe)
        return {"parsed": 1, "failed": 0}

    monkeypatch.setattr(api.case_ingest, "ingest_case", fake_ingest)
    case_id = uuid4()
    store.add_case_file(case_id, "scan.pdf", "pdf", b"%PDF")

    client.post(f"/cases/{case_id}/ingest", headers=AUTH)

    assert (seen[0] is not None) == transcribes
