"""The sub-goal diff (#5, SYS-19). Every regulation text here is made up: Certivity's files are
confidential and not in git. Each case is a pattern the worked example contains."""

import json
from dataclasses import dataclass
from pathlib import Path

import jsonschema

from agent_service.domain import certivity, regdiff

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


def test_new_text_is_added_only_in_parts_of_the_regulation_the_old_requirements_come_from() -> None:
    annex = P("Annex 1", "Annex 1\nTest procedures", 20)
    old, new = _versions(
        [SPEC, P("5.1", "5.1. The widget shall be blue."), annex],
        [
            SPEC,
            P("5.1", "5.1. The widget shall be blue."),
            P("5.2", "5.2. The widget shall hum."),
            annex,
            P("Annex 1 1.1", "1.1. The tester shall hold the widget at arm's length.", 20),
            P("Annex 1 Appendix 1 1.1", "1.1. The report shall list every widget.", 22),
        ],
    )
    main_only = [_req("R-001", "The widget shall be blue.", "5.1")]

    added = [c.paragraph for c in regdiff.diff_versions(main_only, old, new)]

    assert added == ["5.2"]
    assert regdiff.part("Annex 1 Appendix 1 1.1") == "annex 1 appendix 1"
    assert regdiff.part("Annex 1 1.1") == "annex 1"
    assert regdiff.part("5.2") == ""

    # A list that cites the annex keeps its new text, but not that of the annex's appendix.
    with_annex = [*main_only, _req("R-002", "The tester shall be present.", "Annex 1 1.1", 20)]
    added = [c.paragraph for c in regdiff.diff_versions(with_annex, old, new)]

    assert added == ["5.2", "Annex 1 1.1"]


def test_a_requirement_list_that_cannot_be_traced_limits_no_part() -> None:
    old, new = _versions(
        [SPEC, P("5.1", "5.1. The widget shall be blue.")],
        [
            SPEC,
            P("5.1", "5.1. The widget shall be blue."),
            P("Annex 1 1.1", "1.1. It shall hum.", 9),
        ],
    )

    assert regdiff.covered_parts([], old) is None
    assert [c.paragraph for c in regdiff.diff_versions([], old, new)] == ["Annex 1 1.1"]


def test_an_edit_outside_the_requirements_own_words_is_not_a_change() -> None:
    old, new = _versions(
        [
            SPEC,
            P("5.1", "5.1. In addition, the widget shall be blue."),
            P("5.2", '5.2. Records shall go to the database "WDB"1 within three months.'),
            P("5.3", "5.3. The widget shall glow in daylight."),
        ],
        [
            SPEC,
            P("5.1", "5.1. The widget shall be blue."),
            P("5.2", '5.2. Records shall go to the database "WDB"4 within 3 months.'),
            P("5.3", "5.3. The widget shall glow."),
        ],
    )
    reqs = [
        _req("R-001", "The widget shall be blue.", "5.1"),
        _req("R-002", 'Records shall go to the database "WDB" within three months.', "5.2"),
        _req("R-003", "In daylight, the widget shall glow.", "5.3"),
    ]

    changes = regdiff.diff_versions(reqs, old, new)

    # Only the requirement that carried the cut words changed.
    assert [(c.requirement_id, c.change) for c in changes] == [("R-003", "modified")]


def test_a_bare_number_cited_on_an_introduction_page_is_the_introduction_paragraph() -> None:
    old = regdiff.build_version(
        "UN R999",
        "1.0.0",
        [
            P("Introduction 2", "2. The widget shall hum quietly.", 1),
            P("1", "1. Scope", 3),
            P("2", "2. Definitions", 3),
            P("2.1", '2.1. "Widget" means a device that hums.', 3),
        ],
    )
    req = _req("R-001", "The widget shall hum quietly.", "2", page=1)

    assert [s.label for s in regdiff.evidence(req, old)] == ["Introduction 2"]


def test_a_new_duty_inside_a_modified_paragraph_is_also_added_a_new_condition_is_not() -> None:
    old, new = _versions(
        [
            SPEC,
            P(
                "5.1",
                "5.1. The widget shall hum when:\n(a) the widget is switched on;\n"
                "(b) the room is cold.",
            ),
        ],
        [
            SPEC,
            P(
                "5.1",
                "5.1. The widget shall hum when:\n(a) the widget is switched on;\n"
                "(b) the room is freezing.\n"
                "The hum is at least 30 dB.\nThe manufacturer shall document the hum.",
            ),
        ],
    )
    reqs = [_req("R-001", "The widget shall hum when switched on or the room is cold.", "5.1")]

    changes = regdiff.diff_versions(reqs, old, new)

    # The new limit, with no modal of its own, is part of the rule; the new duty is not.
    assert [(c.requirement_id, c.change) for c in changes] == [
        ("R-001", "modified"),
        (None, "added"),
    ]
    assert changes[1].new_text == "The manufacturer shall document the hum."


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
