"""The scope screen (SYS-44): what it reads of each regulation, that the model must judge every
one shown, and that a run screens the whole library before it writes. Made-up regulations."""

from uuid import uuid4

import pytest
from pydantic_ai import ModelRetry

from agent_service import runner
from agent_service.domain import screen
from agent_service.records import LibraryVersion, Paragraph
from tests.fakes import case_run

pytestmark = pytest.mark.anyio

VERSION = LibraryVersion(id=uuid4(), regulation="UN R<a>", title="Made-up", version_label="00")


def paragraph(position: int, label: str | None, text: str, heading: str = "") -> Paragraph:
    return Paragraph(
        id=uuid4(),
        version_id=VERSION.id,
        position=position,
        label=label,
        heading=heading,
        kind="paragraph" if label else "text",
        text=text,
        page_start=1,
        page_end=1,
        content_hash="h",
    )


def test_the_screen_reads_section_1_and_the_transitional_provisions_only() -> None:
    c = screen.candidate(
        VERSION,
        [
            paragraph(1, None, "Introduction."),
            paragraph(2, "1", "Scope. This applies to made-up panels."),
            paragraph(3, "1.1", "It does not apply to made-up doors."),
            paragraph(4, "10", "Conformity of production."),
            paragraph(5, "Annex 1 1.1", "An annex paragraph numbered 1.1."),
            paragraph(
                6,
                "13.1",
                "No approvals shall be granted after a date.",
                "13. Transitional provisions",
            ),
        ],
    )

    assert c.scope == "Scope. This applies to made-up panels.\nIt does not apply to made-up doors."
    assert c.transitional == "No approvals shall be granted after a date."
    assert "Transitional provisions (start):" in c.render()


def test_a_version_without_section_1_shows_its_opening_text_and_long_text_is_capped() -> None:
    c = screen.candidate(VERSION, [paragraph(1, None, "x" * (screen.SCOPE_CHARS + 10))])

    assert c.scope.endswith(" [...]")
    assert len(c.scope) == screen.SCOPE_CHARS + len(" [...]")
    assert c.transitional == ""


def verdict(regulation: str, kind: str = "applies", entries: list[str] | None = None):
    return screen.Verdict(
        regulation=regulation,
        verdict=kind,  # pyright: ignore[reportArgumentType]
        reason="r",
        scope_quote="q",
        profile_entries=entries or [],
    )


def test_every_regulation_shown_gets_exactly_one_verdict() -> None:
    batch = [
        screen.Candidate(VERSION, "s", ""),
        screen.Candidate(VERSION.model_copy(update={"regulation": "UN R<b>"}), "s", ""),
    ]

    class Ctx:
        deps = batch

    with pytest.raises(ModelRetry, match=r"Missing: UN R<b>.*Not shown here: UN R<c>"):
        screen._one_verdict_each(Ctx(), [verdict("UN R<a>"), verdict("UN R<c>")])  # pyright: ignore[reportPrivateUsage, reportArgumentType]
    kept = screen._one_verdict_each(  # pyright: ignore[reportPrivateUsage]
        Ctx(),  # pyright: ignore[reportArgumentType]
        [verdict("UN R<a>", "does_not"), verdict("UN R<b>"), verdict("UN R<a>")],
    )
    assert [(v.regulation, v.verdict) for v in kept] == [
        ("UN R<a>", "applies"),
        ("UN R<b>", "applies"),
    ]


def test_shared_entries_list_what_several_applying_regulations_cover() -> None:
    shared = screen.shared_entries(
        [
            verdict("UN R<a>", entries=["a sensor"]),
            verdict("UN R<b>", "possibly", entries=["a sensor", "a sensor"]),
            verdict("UN R<c>", "does_not", entries=["a sensor"]),
            verdict("UN R<d>", entries=["a cover"]),
        ]
    )

    assert shared == [{"profile_entry": "a sensor", "regulations": ["UN R<a>", "UN R<b>"]}]


async def test_a_run_screens_the_library_after_the_profile_and_before_writing(
    store, settings
) -> None:
    run_id = case_run(store)
    plan = await runner.prepare(store, settings, run_id)
    await runner.execute(store, settings, plan)

    called = [p["tool_name"] for p in store.payloads(run_id, "tool_call")]
    assert called.index("record_product_profile") < called.index("screen_regulations")
    assert called.index("screen_regulations") < called.index("write_requirements")
    [result] = [
        p for p in store.payloads(run_id, "tool_result") if p["tool_name"] == "screen_regulations"
    ]
    assert not result["is_error"]
