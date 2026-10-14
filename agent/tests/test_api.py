import asyncio
import json
from collections.abc import AsyncIterator, Iterator
from uuid import UUID, uuid4

import httpx
import pytest
from fastapi.testclient import TestClient

from agent_service import providers
from agent_service.api import app, get_http, get_store
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
