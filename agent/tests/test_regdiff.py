"""The sub-goal diff (#5, SYS-19). Every regulation text here is made up: Certivity's files are
confidential and not in git. Each case is a pattern the worked example contains."""

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from uuid import UUID

import jsonschema
import pytest
from fastapi.testclient import TestClient

from agent_service.api import app, get_store, get_versions
from agent_service.domain import certivity, changes, regdiff
from agent_service.settings import Settings, get_settings
from tests.fakes import InMemoryRunStore

AUTH = {"Authorization": "Bearer test-secret"}
PACKAGE = Path(__file__).parent / "fixtures" / "certivity_package"


@dataclass(frozen=True)
class P:
    label: str
    text: str
    page_start: int = 1


def _versions(old: list[P], new: list[P]) -> tuple[regdiff.Version, regdiff.Version]:
    return (
        regdiff.build_version("UN R999", "1.0.0", old),
        regdiff.build_version("UN R999", "2.0.0", new),
    )


def _req(rid: str, text: str, paragraph: str, page: int = 1) -> dict:
    return {
        "id": rid,
        "text": text,
        "source": {"regulation": "UN R999", "page": page, "paragraph": paragraph},
    }


SCOPE = P("1", "1. Scope\n1.1. This Regulation applies to widgets.")
DEFS = P("2", "2. Definitions\nFor the purposes of this Regulation:")
SPEC = P("5", "5. Specifications")


def test_a_reworded_obligation_is_modified_with_the_new_wording_and_what_changed() -> None:
    old, new = _versions(
        [SPEC, P("5.1", "5.1. The widget shall glow for at least 5 s after it is switched on.", 4)],
        [SPEC, P("5.1", "5.1. The widget shall glow for at least 8 s after it is switched on.", 5)],
    )
    reqs = [_req("R-001", "When switched on, the widget shall glow for at least 5 s.", "5.1", 4)]

    [change] = regdiff.diff_versions(reqs, old, new)

    assert change.change == "modified"
    assert change.requirement_id == "R-001"
    assert change.new_text == "The widget shall glow for at least 8 s after it is switched on."
    assert "'5' became '8'" in change.reason
    assert (change.page, change.paragraph) == (5, "5.1")


def test_editorial_changes_and_renumbering_are_not_changes() -> None:
    # "70%" -> "70 per cent", "6 seconds" -> "6 s", a footnote marker that moved from 3 to 4,
    # and a sentence that moved from 5.1 to its new sub-paragraph 5.1.1 unchanged.
    old, new = _versions(
        [
            SPEC,
            P(
                "5.1",
                "5.1. The lamp shall dim to 70% within 6 seconds.\nThe Secretariat3 shall be told.",
            ),
        ],
        [
            SPEC,
            P("5.1", "5.1. Dimming"),
            P(
                "5.1.1",
                "5.1.1. The lamp shall dim to 70 per cent within 6 s.\n"
                "The Secretariat4 shall be told.",
            ),
        ],
    )
    reqs = [
        _req("R-001", "The lamp shall dim to 70% within 6 seconds.", "5.1"),
        _req("R-002", "The Secretariat shall be told.", "5.1"),
    ]

    assert regdiff.diff_versions(reqs, old, new) == []


def test_an_obligation_that_no_longer_appears_is_removed() -> None:
    old, new = _versions(
        [
            SPEC,
            P(
                "5.1",
                "5.1. The widget shall be blue.\nThe widget may be tested twice if requested.",
            ),
        ],
        [SPEC, P("5.1", "5.1. The widget shall be blue.")],
    )
    reqs = [
        _req("R-001", "The widget shall be blue.", "5.1"),
        _req("R-002", "When requested, the widget shall be allowed to be tested twice.", "5.1"),
    ]

    [change] = regdiff.diff_versions(reqs, old, new)

    assert (change.change, change.requirement_id, change.new_text) == ("removed", "R-002", None)
    assert "no longer appears" in change.reason


def test_a_changed_lead_in_does_not_change_the_requirement_of_one_item() -> None:
    old, new = _versions(
        [
            SPEC,
            P(
                "5.2",
                "5.2. The procedure for each test shall be as follows:\n"
                "(a) Place the widget on the bench.\n"
                "(b) Switch the widget on.",
            ),
        ],
        [
            SPEC,
            P(
                "5.2",
                "5.2. The procedure for each test with a cold widget shall be as follows:\n"
                "(a) Place the widget on the heated bench.\n"
                "(b) Switch the widget on.",
            ),
        ],
    )
    reqs = [
        _req("R-001", "The procedure for each test shall place the widget on the bench.", "5.2"),
        _req("R-002", "The procedure for each test shall switch the widget on.", "5.2"),
    ]

    [change] = regdiff.diff_versions(reqs, old, new)

    assert (change.change, change.requirement_id) == ("modified", "R-001")
    assert change.new_text == "(a) Place the widget on the heated bench."


def test_new_obligations_are_added_but_not_new_definitions_or_titles() -> None:
    old, new = _versions(
        [
            SCOPE,
            DEFS,
            P("2.1", '2.1. "Widget" means a device.'),
            SPEC,
            P("5.1", "5.1. The widget shall be blue."),
        ],
        [
            SCOPE,
            DEFS,
            P("2.1", '2.1. "Widget" means a device.'),
            P("2.2", '2.2. "Gadget" means a widget that shall be green.'),
            SPEC,
            P("5.1", "5.1. The widget shall be blue."),
            P("5.2", "5.2. Gadgets", 7),
            P("5.2.1", "5.2.1. The gadget shall be green.", 7),
            P(
                "5.3",
                "5.3. The procedure for each gadget test shall be as follows:\n"
                "(a) Place the gadget on the bench.\n"
                "(b) Switch the gadget on.",
                8,
            ),
            P(
                "5.4",
                "5.4. A test is not required when:\n(a) the gadget is off; or\n(b) it is raining.",
                8,
            ),
        ],
    )

    changes = regdiff.diff_versions([_req("R-001", "The widget shall be blue.", "5.1")], old, new)
    added = [(c.paragraph, c.new_text) for c in changes]

    assert all(c.change == "added" and c.requirement_id is None for c in changes)
    assert added == [
        ("5.2.1", "The gadget shall be green."),
        (
            "5.3",
            "The procedure for each gadget test shall be as follows: "
            "(a) Place the gadget on the bench.",
        ),
        (
            "5.3",
            "The procedure for each gadget test shall be as follows: (b) Switch the gadget on.",
        ),
        ("5.4", "A test is not required when: (a) the gadget is off; or (b) it is raining."),
    ]


def test_the_submission_is_valid_against_certivitys_schema() -> None:
    old, new = _versions(
        [SPEC, P("5.1", "5.1. The widget shall be blue.\nThe widget may be tested twice.")],
        [SPEC, P("5.1", "5.1. The widget shall be red."), P("5.2", "5.2. The widget shall hum.")],
    )
    reqs = [
        _req("R-001", "The widget shall be blue.", "5.1"),
        _req("R-002", "The widget shall be allowed to be tested twice.", "5.1"),
    ]
    out = regdiff.submission("team-00", "subgoal-demo", regdiff.diff_versions(reqs, old, new))
    schema = json.loads(
        (certivity.PACKAGE_DIR / "schemas" / "submission_subgoal.schema.json").read_text()
    )

    jsonschema.validate(out, schema)
    assert [c["change"] for c in out["changes"]] == ["modified", "removed", "added"]


# ------------------------------------------------------------------------------------------
# The endpoint: two library versions and a sub-goal case in, a sub-goal file out
# ------------------------------------------------------------------------------------------

ORG = UUID("00000000-0000-0000-0000-00000000000a")
OTHER_ORG = UUID("00000000-0000-0000-0000-00000000000b")
REG = UUID("00000000-0000-0000-0000-000000000100")
OLD_ID = UUID("00000000-0000-0000-0000-000000000001")
NEW_ID = UUID("00000000-0000-0000-0000-000000000002")
FOREIGN_ID = UUID("00000000-0000-0000-0000-000000000003")
OTHER_REG_ID = UUID("00000000-0000-0000-0000-000000000004")

# What "extracting" each stored file gives. The fake store returns the path as the file's bytes,
# so no PDF is needed: the extraction itself is regdiff's and tested above.
LAMP = {
    "old.pdf": [
        SPEC,
        P("5.1", "5.1. The lamp shall be red.", 4),
        P("5.2", "5.2. The lamp shall be visible at 100 m.", 5),
    ],
    "new.pdf": [
        SPEC,
        P("5.1", "5.1. The lamp shall be red.", 4),
        P("5.2", "5.2. The lamp shall be visible at 150 m.", 5),
        P("5.3", "5.3. The lamp shall be dimmable.", 5),
    ],
}


class FakeVersions:
    def __init__(self) -> None:
        def v(id_: UUID, org: UUID, reg: UUID, label: str, path: str) -> changes.StoredVersion:
            return changes.StoredVersion(id_, org, reg, "UN R900", label, path)

        self.rows = {
            OLD_ID: v(OLD_ID, ORG, REG, "1.0.0", "old.pdf"),
            NEW_ID: v(NEW_ID, ORG, REG, "2.0.0", "new.pdf"),
            FOREIGN_ID: v(FOREIGN_ID, OTHER_ORG, REG, "3.0.0", "new.pdf"),
            OTHER_REG_ID: v(OTHER_REG_ID, ORG, UUID(int=999), "1.0.0", "new.pdf"),
        }
        self.closed = False

    async def version(self, version_id: UUID) -> changes.StoredVersion | None:
        return self.rows.get(version_id)

    async def download(self, path: str) -> bytes:
        return path.encode()

    async def aclose(self) -> None:
        self.closed = True


@pytest.fixture
def versions(monkeypatch: pytest.MonkeyPatch) -> FakeVersions:
    monkeypatch.setattr(regdiff, "interim_paragraphs", lambda pdf: ("", "", LAMP[pdf.decode()]))
    return FakeVersions()


@pytest.fixture
def client(store: InMemoryRunStore, settings: Settings, versions: FakeVersions):
    app.dependency_overrides[get_store] = lambda: store
    app.dependency_overrides[get_settings] = lambda: settings
    app.dependency_overrides[get_versions] = lambda: versions
    yield TestClient(app)
    app.dependency_overrides.clear()


def _body(**overrides: Any) -> dict[str, Any]:
    return {
        "organization_id": str(ORG),
        "old_version_id": str(OLD_ID),
        "new_version_id": str(NEW_ID),
        "case_id": "subgoal-demo",
        "team_id": "team-00",
        **overrides,
    }


@pytest.mark.anyio
async def test_the_endpoint_uses_the_loaded_case_and_names_the_library_versions(
    client: TestClient, store: InMemoryRunStore, versions: FakeVersions
) -> None:
    await store.replace_certivity_reference(certivity.read_package(PACKAGE))

    cases = client.get("/subgoal/cases", headers=AUTH).json()
    assert cases == {"cases": [{"case_id": "subgoal-demo", "regulation": "UN R900"}]}
    response = client.post("/subgoal/changes", headers=AUTH, json=_body())

    assert response.status_code == 200
    body = response.json()
    assert body["counts"] == {"modified": 1, "removed": 0, "added": 1}
    first, added = body["submission"]["changes"]
    assert (first["requirement_id"], first["change"]) == ("R-002", "modified")
    assert first["reason"].startswith("Paragraph 5.2 of UN R900 was amended in version 2.0.0")
    assert (added["change"], added["new_text"]) == ("added", "The lamp shall be dimmable.")
    assert certivity.check(
        json.dumps(body["submission"]), certivity.Reference.from_rows(store.reference)
    )["valid"]
    assert versions.closed


def test_an_uploaded_requirements_file_needs_no_loaded_case(client: TestClient) -> None:
    mine = [
        {"id": "A-1", "text": "The lamp shall be red.", "source": {"page": 4, "paragraph": "5.1"}}
    ]
    response = client.post(
        "/subgoal/changes", headers=AUTH, json=_body(case_id="mine", requirements_old=mine)
    )

    assert response.status_code == 200
    assert response.json()["counts"] == {"modified": 0, "removed": 0, "added": 1}


@pytest.mark.parametrize(
    ("overrides", "status"),
    [
        ({}, 404),  # no requirements_old loaded for the case
        ({"new_version_id": str(FOREIGN_ID), "requirements_old": []}, 404),  # other organisation
        ({"new_version_id": str(OTHER_REG_ID), "requirements_old": []}, 400),  # other regulation
        ({"new_version_id": str(OLD_ID), "requirements_old": []}, 400),  # same version twice
    ],
)
def test_the_endpoint_refuses_what_it_cannot_compare(
    client: TestClient, overrides: dict[str, Any], status: int
) -> None:
    response = client.post("/subgoal/changes", headers=AUTH, json=_body(**overrides))
    assert response.status_code == status
    assert isinstance(response.json()["detail"], str)


def test_the_endpoint_needs_the_secret(client: TestClient) -> None:
    assert client.post("/subgoal/changes", json=_body()).status_code == 401
    assert client.get("/subgoal/cases").status_code == 401
