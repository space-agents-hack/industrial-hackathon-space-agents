"""The sub-goal's writer step (#42, SYS-45): a model writes each change's text as a requirement, and
code decides whether the text may replace the regulation's wording. Every regulation, requirement
and text here is made up."""

from dataclasses import dataclass
from typing import Any

import pytest
from pydantic_ai.messages import ModelMessage, ModelResponse, ToolCallPart
from pydantic_ai.models.function import AgentInfo, FunctionModel

from agent_service.domain import regdiff, subgoal_review, subgoal_write

pytestmark = pytest.mark.anyio


@dataclass(frozen=True)
class P:
    label: str
    text: str
    page_start: int = 1


OLD = [
    P("7", "7. Photometry"),
    P(
        "7.1",
        "7.1. The lamp shall emit red light.\nThe lamp shall have an intensity of at most 20 cd.",
        4,
    ),
]
NEW = [
    P("7", "7. Photometry"),
    P(
        "7.1",
        "7.1. The lamp shall emit red light.\nThe lamp shall have an intensity of at most 25 cd.",
        4,
    ),
    P("7.2", "7.2. Marking\nIt shall bear the maker's name, and may bear a part number.", 5),
]
REQUIREMENTS = [
    {
        "id": "R-001",
        "text": "The rear lamp shall have an intensity of no more than 20 cd.",
        "source": {"regulation": "UN R999", "page": 4, "paragraph": "7.1"},
    }
]


def diffed() -> tuple[regdiff.Version, list[regdiff.Change]]:
    old = regdiff.build_version("UN R999", "1.0.0", OLD)
    new = regdiff.build_version("UN R999", "2.0.0", NEW)
    return new, regdiff.diff_versions(REQUIREMENTS, old, new)


def item(change: str) -> subgoal_write.Item:
    new, changes = diffed()
    [found] = [
        i for i in subgoal_write.items(changes, REQUIREMENTS, new) if i.change.change == change
    ]
    return found


def answering(*answers: list[dict[str, Any]] | Exception) -> tuple[FunctionModel, list[int]]:
    calls = [0]

    def respond(messages: list[ModelMessage], info: AgentInfo) -> ModelResponse:
        answer = answers[min(calls[0], len(answers) - 1)]
        calls[0] += 1
        if isinstance(answer, Exception):
            raise answer
        return ModelResponse(parts=[ToolCallPart("record_texts", {"response": answer})])

    return FunctionModel(respond), calls


async def written(model: FunctionModel) -> tuple[subgoal_write.Report, list[regdiff.Change]]:
    new, changes = diffed()

    async def progress(_: str) -> None:
        return None

    report = await subgoal_write.write(
        changes, REQUIREMENTS, new, model, subgoal_review.Limits(batch_size=4), progress
    )
    return report, changes


def test_the_rules_find_one_modified_and_one_added_change() -> None:
    _, changes = diffed()

    assert [(c.change, c.requirement_id, c.paragraph) for c in changes] == [
        ("modified", "R-001", "7.1"),
        ("added", None, "7.2"),
    ]
    assert changes[0].old_text == "The lamp shall have an intensity of at most 20 cd."


# ------------------------------------------------------------------------------------------
# The check
# ------------------------------------------------------------------------------------------


def test_an_updated_requirement_in_its_own_words_passes() -> None:
    text = "The rear lamp shall have an intensity of no more than 25 cd."

    assert subgoal_write.problems(item("modified"), [text]) == []


def test_a_text_that_keeps_the_deleted_value_fails() -> None:
    found = subgoal_write.problems(
        item("modified"), ["The rear lamp shall have an intensity of no more than 20 cd."]
    )

    assert any("missing: 25" in p for p in found)
    assert any("deleted are still there: 20" in p for p in found)


def test_a_text_that_adds_what_the_regulation_does_not_say_fails() -> None:
    text = (
        "The rear lamp shall have an intensity of at most 25 cd, measured at night in fog with "
        "a calibrated photometer chosen by the manufacturer."
    )

    assert any("does not contain" in p for p in subgoal_write.problems(item("modified"), [text]))


def test_a_modified_requirement_gets_exactly_one_text() -> None:
    texts = ["The rear lamp shall emit red light.", "The rear lamp shall have at most 25 cd."]

    assert any("exactly one" in p for p in subgoal_write.problems(item("modified"), texts))


def test_a_text_over_the_schemas_cap_fails() -> None:
    long = "The rear lamp shall have an intensity of at most 25 cd. " * 40

    assert any("characters" in p for p in subgoal_write.problems(item("modified"), [long]))


# ------------------------------------------------------------------------------------------
# The step
# ------------------------------------------------------------------------------------------


async def test_added_text_is_split_per_obligation_and_modified_text_is_rewritten() -> None:
    model, _ = answering(
        [
            {"id": "C1", "texts": ["The rear lamp shall have an intensity of no more than 25 cd."]},
            {
                "id": "C2",
                "texts": [
                    "The lamp shall bear the maker's name.",
                    "The lamp may bear a part number.",
                ],
            },
        ]
    )

    report, rules = await written(model)

    assert [(c.change, c.requirement_id, c.new_text) for c in report.changes] == [
        ("modified", "R-001", "The rear lamp shall have an intensity of no more than 25 cd."),
        ("added", None, "The lamp shall bear the maker's name."),
        ("added", None, "The lamp may bear a part number."),
    ]
    # The type, reason, page and paragraph are the rules' own; only the text is written.
    assert [(c.reason, c.page, c.paragraph) for c in report.changes[1:]] == [
        (rules[1].reason, 5, "7.2"),
    ] * 2
    assert (report.written, report.split, report.kept_rules) == (2, 1, [])


async def test_a_text_that_still_fails_after_one_retry_keeps_the_rules_wording() -> None:
    model, calls = answering(
        [
            {"id": "C1", "texts": ["The rear lamp shall have an intensity of no more than 20 cd."]},
            {"id": "C2", "texts": ["The lamp shall bear the maker's name."]},  # drops the "may"
        ]
    )

    report, rules = await written(model)

    assert calls[0] == 2
    assert report.changes[0].new_text == rules[0].new_text
    # Leaving out an obligation of the new text fails too: the change is not all there.
    assert report.changes[1].new_text == rules[1].new_text
    assert report.kept_rules == ["R-001", "added at 7.2"]


async def test_a_writer_that_cannot_be_reached_leaves_the_rules_file() -> None:
    model, _ = answering(RuntimeError("provider down"))

    report, rules = await written(model)

    assert report.changes == rules
    assert report.failed and "provider down" in report.failed[0]


# ------------------------------------------------------------------------------------------
# The rules' own text over the cap
# ------------------------------------------------------------------------------------------


def test_a_long_modified_requirement_keeps_its_changed_items_whole_within_the_cap() -> None:
    filler = [
        f"({chr(97 + k)}) Condition number {k} holds in the normal case of use, " + "x " * 60
        for k in range(20)
    ]
    old_text = "8.1. The lamp shall stay lit, provided:\n" + "\n".join([*filler, "(u) It is dry."])
    new_text = "8.1. The lamp shall stay lit, provided:\n" + "\n".join([*filler, "(u) It is wet."])
    old = regdiff.build_version("UN R999", "1.0.0", [P("8.1", old_text, 6)])
    new = regdiff.build_version("UN R999", "2.0.0", [P("8.1", new_text, 6)])
    requirement = {
        "id": "R-002",
        "text": regdiff._LABEL_PREFIX.sub("", old_text),
        "source": {"paragraph": "8.1", "page": 6},
    }

    [change] = [c for c in regdiff.diff_versions([requirement], old, new) if c.requirement_id]

    assert change.new_text is not None and len(change.new_text) <= 2000
    assert change.new_text.startswith("The lamp shall stay lit, provided:")
    assert change.new_text.endswith("(u) It is wet.")
    assert "[...]" in change.new_text
    # What the writer step reads is the full new wording, not the shortened one.
    assert change.source_text is not None and len(change.source_text) > 2000
