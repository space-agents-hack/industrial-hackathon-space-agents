import hashlib
import json
from pathlib import Path
from typing import Any
from uuid import UUID

import pytest
from fastapi.testclient import TestClient

from agent_service.api import app, get_store
from agent_service.domain import certivity, prepare_deps
from agent_service.settings import Settings, get_settings
from tests.fakes import InMemoryRunStore

AUTH = {"Authorization": "Bearer test-secret"}
# Made up, in the shape of Certivity's package: the real files are confidential and not in git.
PACKAGE = Path(__file__).parent / "fixtures" / "certivity_package"


ORG = UUID("30000000-0000-0000-0000-000000000001")


def _library() -> list[dict[str, Any]]:
    # What regulation_index returns for an organisation that imported the made-up index.
    raw = json.loads((PACKAGE / "regulations" / "index.json").read_text())
    return [
        {
            "regulation": e["regulation"],
            "versions": [
                {"version_label": v["version_label"], "role": v["role"]} for v in e["versions"]
            ],
        }
        for e in raw
    ]


@pytest.fixture
def ref() -> certivity.Reference:
    return certivity.Reference.from_rows(certivity.read_package(PACKAGE), _library())


def _expected() -> dict[str, Any]:
    return json.loads((PACKAGE / "cases" / "demo-lamp" / "expected.json").read_text())


def test_the_code_is_byte_for_byte_what_sync_certivity_recorded() -> None:
    # An edited validate.py would no longer be the platform's validate.py, silently.
    root = certivity.PACKAGE_DIR
    lines = [line for line in (root / "SOURCE").read_text().splitlines() if line[:1] != "#"]
    assert lines, "SOURCE lists no files: run scripts/sync-certivity.sh"
    for line in lines:
        digest, name = line.split(maxsplit=1)
        actual = hashlib.sha256((root / name).read_bytes()).hexdigest()
        assert actual == digest, f"agent/certivity/{name} differs from SOURCE; re-run the sync"


def test_no_certivity_data_is_in_the_repository() -> None:
    # Their data is for the hackathon only and must be deletable: it belongs in the database.
    data = [p for p in certivity.PACKAGE_DIR.rglob("*.json") if "schemas" not in p.parts]
    assert data == []


def test_read_package_names_every_file_by_its_case() -> None:
    rows = certivity.read_package(PACKAGE)
    # Not the index: that is imported into the regulation library in the app (ADR-0006).
    assert {(r["kind"], r["case_id"]) for r in rows} == {
        ("expected", "demo-lamp"),
        ("requirements_old", "subgoal-demo"),
    }


def test_the_release_gets_the_same_rows_as_json(capsys: pytest.CaptureFixture[str]) -> None:
    # The release workflow writes these with psql (scripts/load-certivity.sql), keyed the same way.
    from agent_service.domain import load_certivity

    assert load_certivity._json_command(PACKAGE) == 0
    rows = json.loads(capsys.readouterr().out)
    assert rows == json.loads(json.dumps(certivity.read_package(PACKAGE)))
    assert set(rows[0]) == {"kind", "case_id", "content", "certivity_commit"}


def test_the_expected_answer_is_valid_and_scores_full_marks(ref: certivity.Reference) -> None:
    result = certivity.check(json.dumps(_expected()), ref)

    assert result["valid"] is True
    assert (result["kind"], result["case_id"], result["items"]) == ("main", "demo-lamp", 3)
    for level in ("regulation_level", "page_level"):
        assert result["score"][level]["f1"] == 1.0


def test_problems_come_with_their_json_path(ref: certivity.Reference) -> None:
    data = _expected()
    data["requirements"][1]["id"] = data["requirements"][0]["id"]
    data["requirements"][2]["source"]["regulation"] = "UN R999"
    data["requirements"][0]["source"]["page"] = 0

    result = certivity.check(json.dumps(data), ref)

    assert result["valid"] is False
    paths = [p["path"] for p in result["problems"]]
    assert paths == [
        "$.requirements[0].source.page",
        "$.requirements[1].id",
        "$.requirements[2].source.regulation",
    ]
    # Still scored: a few bad rows do not make the rest of the file meaningless.
    assert result["score"] is not None


def test_a_version_that_is_not_in_the_index_is_named(ref: certivity.Reference) -> None:
    data = _expected()
    data["requirements"][0]["source"]["version"] = "9.9"
    message = certivity.check(json.dumps(data), ref)["problems"][0]["message"]
    assert "1.0.0" in message


def test_json_inside_a_model_answer_is_found_and_its_span_is_exact(
    ref: certivity.Reference,
) -> None:
    body = json.dumps(_expected())
    text = f"Here is the submission:\n```json\n{body}\n```\nTell me if you need more."

    result = certivity.check(text, ref)

    begin, end = result["json_span"]
    assert text[begin:end] == body
    assert result["valid"] is True
    assert any("surrounding text" in note for note in result["notes"])


@pytest.mark.parametrize("text", ["", "The rear lamp needs UN R48.", "{not json"])
def test_text_without_a_json_document_is_one_problem_not_a_crash(
    text: str, ref: certivity.Reference
) -> None:
    result = certivity.check(text, ref)
    assert (result["valid"], result["kind"], result["problem_count"]) == (False, None, 1)


def test_a_case_without_expected_file_is_validated_but_not_scored(
    ref: certivity.Reference,
) -> None:
    data = {**_expected(), "case_id": "held-out-case"}
    result = certivity.check(json.dumps(data), ref)
    assert result["valid"] is True
    assert result["score"] is None
    note = next(n for n in result["notes"] if "no local score" in n)
    # A case named in the app as something other than Certivity's id: the note names the fix.
    assert "'demo-lamp'" in note


def test_subgoal_checks_requirement_ids_against_the_old_requirements(
    ref: certivity.Reference,
) -> None:
    expected = json.loads((PACKAGE / "subgoal" / "demo" / "expected.json").read_text())
    assert certivity.check(json.dumps(expected), ref)["valid"] is True

    expected["changes"][0]["requirement_id"] = "R-9999"
    result = certivity.check(json.dumps(expected), ref)
    assert result["valid"] is False
    assert "requirements_old.json" in result["problems"][0]["message"]


def test_without_the_reference_in_the_database_the_check_says_so() -> None:
    result = certivity.check(json.dumps(_expected()), certivity.EMPTY)
    # The schema check still runs: it needs no data.
    assert result["valid"] is True
    assert result["score"] is None
    assert any("answer keys are not in the database" in note for note in result["notes"])
    assert any("regulation library is empty" in note for note in result["notes"])


def test_the_score_is_split_by_regulation(ref: certivity.Reference) -> None:
    # Which regulation was missed, and where the pages went: the totals alone do not say.
    data = _expected()
    data["requirements"] = data["requirements"][:2]  # UN R901 is missed
    data["requirements"][1]["source"]["page"] = 9  # a wrong page; its paragraph still counts
    data["requirements"].append(
        {
            "id": "R-009",
            "text": "Extra.",
            "source": {"regulation": "UN R902", "version": "1", "page": 1},
        }
    )

    rows = {r["regulation"]: r for r in certivity.check(json.dumps(data), ref)["breakdown"]}

    assert rows["UN R900"] == {
        "regulation": "UN R900",
        "requirements": 2,
        "expected_requirements": 2,
        "pages": 2,
        "pages_correct": 2,
        "expected_pages": 2,
        "expected_pages_found": 2,
    }
    assert (rows["UN R901"]["requirements"], rows["UN R901"]["expected_pages_found"]) == (0, 0)
    assert (rows["UN R902"]["expected_requirements"], rows["UN R902"]["pages_correct"]) == (0, 0)


def test_the_agent_tool_never_sees_the_score(ref: certivity.Reference) -> None:
    # A model shown the dev score can tune its answer to the one case that has an answer key.
    checked = certivity.check(json.dumps(_expected()), ref, with_score=False)
    assert (checked["score"], checked["breakdown"]) == (None, None)


@pytest.mark.anyio
async def test_a_run_gets_the_reference_from_the_store(
    store: InMemoryRunStore, settings: Settings
) -> None:
    await store.replace_certivity_reference(certivity.read_package(PACKAGE))
    store.library[ORG] = _library()
    deps = await prepare_deps(store, store.runs[store.add_run("Write.", org=ORG)], settings)
    assert "demo-lamp" in deps.reference.expected
    assert deps.reference.index == _library()


@pytest.mark.anyio
async def test_a_run_whose_store_cannot_read_the_reference_still_starts(
    store: InMemoryRunStore, settings: Settings
) -> None:
    async def broken() -> list[dict[str, Any]]:
        raise RuntimeError("relation does not exist")

    store.certivity_reference = broken  # type: ignore[method-assign]
    run = store.runs[store.add_run("Write.")]
    assert (await prepare_deps(store, run, settings)).reference is certivity.EMPTY


@pytest.fixture
def client(store: InMemoryRunStore, settings: Settings):
    app.dependency_overrides[get_store] = lambda: store
    app.dependency_overrides[get_settings] = lambda: settings
    yield TestClient(app)
    app.dependency_overrides.clear()


def test_checks_endpoint_needs_the_secret(client: TestClient) -> None:
    assert client.post("/checks", json={"text": "{}"}).status_code == 401


@pytest.mark.anyio
async def test_checks_endpoint_scores_with_the_stored_reference(
    client: TestClient, store: InMemoryRunStore
) -> None:
    await store.replace_certivity_reference(certivity.read_package(PACKAGE))
    store.library[ORG] = _library()
    data = _expected()
    data["requirements"][0]["source"]["regulation"] = "UN R999"
    body = {"text": json.dumps(data), "organization_id": str(ORG)}

    response = client.post("/checks", headers=AUTH, json=body)

    assert response.status_code == 200
    # The citation is checked against this organisation's library.
    assert response.json()["problems"][0]["path"] == "$.requirements[0].source.regulation"
    assert response.json()["score"]["page_level"]["n_expected"] == 3


@pytest.mark.anyio
async def test_another_organisations_library_is_not_used(
    client: TestClient, store: InMemoryRunStore
) -> None:
    store.library[ORG] = _library()
    other = UUID("30000000-0000-0000-0000-000000000002")
    data = _expected()
    data["requirements"][0]["source"]["regulation"] = "UN R999"
    body = {"text": json.dumps(data), "organization_id": str(other)}
    result = client.post("/checks", headers=AUTH, json=body).json()
    assert result["valid"] is True
    assert any("regulation library is empty" in note for note in result["notes"])


def test_an_index_row_from_before_adr_0006_is_ignored() -> None:
    rows = [
        {
            "kind": "index",
            "case_id": "",
            "content": [{"regulation": "UN R1"}],
            "certivity_commit": "old",
        }
    ]
    assert certivity.Reference.from_rows(rows).index is None


def test_a_chosen_expected_file_is_scored_against_like_score_local_expected(
    ref: certivity.Reference,
) -> None:
    # The user's own answer key: used whatever the submission's case_id, as --expected is.
    submission = {**_expected(), "case_id": "held-out-case"}
    mine = {**_expected(), "requirements": _expected()["requirements"][:1]}
    result = certivity.check(json.dumps(submission), ref, expected=mine)
    assert result["score"]["page_level"]["n_expected"] == 1
    assert any("expected.json you chose" in note for note in result["notes"])


@pytest.mark.anyio
async def test_checks_endpoint_takes_an_expected_file(client: TestClient) -> None:
    body = {"text": json.dumps(_expected()), "expected": _expected()}
    result = client.post("/checks", headers=AUTH, json=body).json()
    assert result["score"]["regulation_level"]["f1"] == 1.0
