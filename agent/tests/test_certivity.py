import hashlib
import json
from typing import Any

import pytest
from fastapi.testclient import TestClient

from agent_service.api import app
from agent_service.domain import certivity
from agent_service.domain.tools import toolset
from agent_service.settings import Settings, get_settings

AUTH = {"Authorization": "Bearer test-secret"}
PACKAGE = certivity.PACKAGE_DIR


def _expected_main() -> dict[str, Any]:
    return json.loads((PACKAGE / "cases" / "dev-rear-lamp" / "expected.json").read_text())


def test_the_copy_is_byte_for_byte_what_sync_certivity_recorded() -> None:
    # An edited validate.py would no longer be the platform's validate.py, silently.
    lines = [line for line in (PACKAGE / "SOURCE").read_text().splitlines() if line[:1] != "#"]
    assert lines, "SOURCE lists no files: run scripts/sync-certivity.sh"
    for line in lines:
        digest, name = line.split(maxsplit=1)
        actual = hashlib.sha256((PACKAGE / name).read_bytes()).hexdigest()
        assert actual == digest, f"agent/certivity/{name} differs from SOURCE; re-run the sync"


def test_the_expected_answer_is_valid_and_scores_full_marks() -> None:
    result = certivity.check(json.dumps(_expected_main()))

    assert result["valid"] is True
    assert (result["kind"], result["case_id"], result["items"]) == ("main", "dev-rear-lamp", 190)
    for level in ("regulation_level", "page_level"):
        assert result["score"][level]["f1"] == 1.0


def test_problems_come_with_their_json_path() -> None:
    data = _expected_main()
    data["requirements"][1]["id"] = data["requirements"][0]["id"]
    data["requirements"][2]["source"]["regulation"] = "UN R999"
    data["requirements"][3]["source"]["page"] = 0

    result = certivity.check(json.dumps(data))

    assert result["valid"] is False
    paths = [p["path"] for p in result["problems"]]
    assert paths == [
        "$.requirements[1].id",
        "$.requirements[2].source.regulation",
        "$.requirements[3].source.page",
    ]
    # Still scored: a few bad rows do not make the rest of the file meaningless.
    assert result["score"] is not None


def test_json_inside_a_model_answer_is_found_and_its_span_is_exact() -> None:
    body = json.dumps(_expected_main())
    text = f"Here is the submission:\n```json\n{body}\n```\nTell me if you need more."

    result = certivity.check(text)

    begin, end = result["json_span"]
    assert text[begin:end] == body
    assert result["valid"] is True
    assert any("surrounding text" in note for note in result["notes"])


@pytest.mark.parametrize("text", ["", "The rear lamp needs UN R48.", "{not json"])
def test_text_without_a_json_document_is_one_problem_not_a_crash(text: str) -> None:
    result = certivity.check(text)
    assert (result["valid"], result["kind"], result["problem_count"]) == (False, None, 1)


def test_a_case_without_expected_file_is_validated_but_not_scored() -> None:
    data = {**_expected_main(), "case_id": "held-out-case"}
    result = certivity.check(json.dumps(data))
    assert result["valid"] is True
    assert result["score"] is None
    assert any("no local score" in note for note in result["notes"])


def test_subgoal_checks_requirement_ids_against_the_old_requirements() -> None:
    expected = json.loads((PACKAGE / "subgoal" / "dev" / "expected.json").read_text())
    assert certivity.check(json.dumps(expected))["valid"] is True

    modified = next(c for c in expected["changes"] if c["change"] == "modified")
    modified["requirement_id"] = "R-9999"
    result = certivity.check(json.dumps(expected))
    assert result["valid"] is False
    assert "requirements_old.json" in result["problems"][0]["message"]


def test_the_agent_tool_never_sees_the_score() -> None:
    # A model shown the dev score can tune its answer to the one case that has an answer key.
    assert certivity.check(json.dumps(_expected_main()), with_score=False)["score"] is None
    assert "certivity_check" in toolset.tools
    assert not toolset.tools["certivity_check"].requires_approval


@pytest.fixture
def client(settings: Settings):
    app.dependency_overrides[get_settings] = lambda: settings
    yield TestClient(app)
    app.dependency_overrides.clear()


def test_checks_endpoint_needs_the_secret(client: TestClient) -> None:
    assert client.post("/checks", json={"text": "{}"}).status_code == 401


def test_checks_endpoint_returns_the_result(client: TestClient) -> None:
    response = client.post("/checks", headers=AUTH, json={"text": json.dumps(_expected_main())})
    assert response.status_code == 200
    assert response.json()["valid"] is True
    assert response.json()["score"]["page_level"]["n_expected"] == 53
