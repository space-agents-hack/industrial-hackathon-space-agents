import json
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient

from agent_service.api import app, get_store
from agent_service.settings import Settings, get_settings
from tests.fakes import InMemoryRunStore

AUTH = {"Authorization": "Bearer test-secret"}


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
