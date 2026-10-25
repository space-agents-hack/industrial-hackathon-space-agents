"""The scope screen (SYS-44): what it reads of each regulation, that the model must judge every
one shown, and that a run screens the whole library before it writes. Made-up regulations."""

import re
from types import SimpleNamespace
from uuid import uuid4

import pytest
from pydantic_ai import ModelRetry
from pydantic_ai.messages import ModelMessage, ModelResponse, ToolCallPart, UserPromptPart
from pydantic_ai.models.function import AgentInfo, FunctionModel
from pydantic_ai.usage import RunUsage

from agent_service import runner
from agent_service.domain import screen, tools, writer
from agent_service.records import LibraryVersion, Paragraph
from tests.fakes import TextSearch, case_run

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


def test_the_screen_reads_the_introduction_where_a_regulation_says_what_it_took_over() -> None:
    c = screen.candidate(
        VERSION,
        [
            paragraph(1, None, "Introduction. This Regulation combines Regulations Nos. A and B."),
            paragraph(2, "1", "Scope. This applies to made-up panels."),
            paragraph(3, None, "Unnumbered text inside the scope."),
        ],
    )

    assert c.introduction == "Introduction. This Regulation combines Regulations Nos. A and B."
    assert c.render().index("Introduction (start):") < c.render().index("Scope section:")
    # Without a section 1 the opening text is shown as the scope, not twice.
    assert screen.candidate(VERSION, [paragraph(1, None, "Opening.")]).introduction == ""


# ------------------------------------------------------------------------------------------
# Search evidence and the fixed rules (V-44, #53)
# ------------------------------------------------------------------------------------------


def test_a_regulation_is_ranked_by_its_best_paragraph_in_each_search() -> None:
    found = screen.evidence(
        [
            ("a signal", ["UN R<b>", "UN R<a>", "UN R<b>", "UN R<c>"]),
            ("an emitter", ["UN R<a>"]),
        ]
    )

    assert found["UN R<a>"] == [
        screen.Evidence("an emitter", rank=1, paragraphs=1, hit=1),
        screen.Evidence("a signal", rank=2, paragraphs=1, hit=3),
    ]
    assert found["UN R<b>"] == [screen.Evidence("a signal", rank=1, paragraphs=2, hit=3)]
    assert screen.reciprocal_rank(found["UN R<a>"]) == 1.5
    assert "UN R<d>" not in found


def test_a_regulation_the_case_names_is_found_by_code_or_number() -> None:
    named = ["spec.pdf p.2: approval mark E4 901R-01", "spec.pdf p.3: ECE R902", "UN R<a> on p.1"]

    assert screen.named_in_case("UN R901", named) == named[0]
    assert screen.named_in_case("UN R902", named) == named[1]
    assert screen.named_in_case("UN R<a>", named) == named[2]
    # Not a number that only contains it, nor one that is part of another.
    assert screen.named_in_case("UN R90", named) is None
    assert screen.named_in_case("UN R01", named) is None


def test_the_fixed_rules_read_named_applies_and_possibly_and_apply_rule_3() -> None:
    codes = ["UN R901", "UN R902", "UN R903", "UN R904", "UN R905", "UN R906"]
    verdicts = [
        verdict("UN R901"),
        verdict("UN R902", "possibly"),
        verdict("UN R903", "possibly"),
        verdict("UN R904", "does_not"),
        verdict("UN R905", "does_not"),
    ]
    found = screen.evidence(
        [
            ("a signal", ["UN R902", "UN R901"]),
            ("a bracket", [f"UN R{n}" for n in range(1, 7)]),
            ("a housing", ["UN R1", "UN R2", "UN R3", "UN R4", "UN R5", "UN R903"]),
        ]
    )
    named = ["spec.pdf p.1: UN R905"]

    decisions = screen.decide(codes, verdicts, found, named)

    read = {d.regulation: d.read for d in decisions}
    assert read == {
        "UN R901": True,
        "UN R902": True,
        # Ranked 6th at best: marked by rule 3 and left out, since the rule is live.
        "UN R903": False,
        "UN R904": False,
        "UN R905": True,  # does_not, but the case names it
        "UN R906": False,  # its screen call failed: no verdict, the orchestrator decides
    }
    assert [d.regulation for d in decisions if d.rule3] == ["UN R903"]
    assert decisions[4].because == "named in the case: spec.pdf p.1: UN R905"
    # Same verdicts and hits, same answer; in shadow, rule 3 marks the same one and reads it.
    assert screen.decide(codes, verdicts, found, named) == decisions
    assert screen.RULE3_LIVE
    shadow = screen.decide(codes, verdicts, found, named, live=False)
    assert [d.regulation for d in shadow if d.read] == ["UN R901", "UN R902", "UN R903", "UN R905"]
    assert [d.regulation for d in shadow if d.rule3] == ["UN R903"]


async def _screen(
    store, settings, monkeypatch, failing: str | None = None, own_model: bool = False
):
    """A screen over four made-up regulations and a one-component profile. `failing` is a query
    whose search raises."""
    search = TextSearch(store)
    monkeypatch.setattr(store, "search_store", lambda: search)
    run_id = case_run(store)
    store.versions.clear()  # the fake's own library: these four only
    for n, scope in [
        (901, "This applies to signal emitters."),
        (902, "This applies to electronic emitters of a stated type."),
        (903, "This applies to made-up doors."),
        (904, "This applies to made-up seats."),
    ]:
        store.add_version(f"UN R{n}", "00", [("1", scope, 1), ("2", "Definitions.", 2)])
    d = tools.Deps(
        store=store,
        run=store.runs[run_id],
        case_name="a-case",
        case_parts=[],
        team_id="team-00",
        settings=settings,
        profile=writer.ProductProfile(
            part="A made-up widget.",
            functions=["emits signal"],
            components=[
                writer.Component(
                    name="emitter",
                    functions=["emits signal"],
                    technology="electronic",
                    build="not_stated",
                )
            ],
            named_in_case=["spec.pdf p.4: UN R904"],
        ),
    )
    shown: list[str] = []
    answers = {"UN R901": "applies", "UN R902": "possibly", "UN R903": "possibly"}

    def judge(messages: list[ModelMessage], info: AgentInfo) -> ModelResponse:
        text = "\n".join(
            c
            for m in messages
            for p in m.parts
            if isinstance(p, UserPromptPart)
            for c in ([p.content] if isinstance(p.content, str) else p.content)
            if isinstance(c, str)
        )
        shown.append(text)
        codes = re.findall(r"^## (.+?): ", text, re.M)
        out = [
            {
                "regulation": c,
                "verdict": answers.get(c, "does_not"),
                "reason": "r",
                "scope_quote": "q",
            }
            for c in codes
        ]
        return ModelResponse(parts=[ToolCallPart("report_screen", {"response": out})])

    if failing is not None:
        real = tools._search

        async def search_or_fail(deps, http, query, k):
            if query == failing:
                raise RuntimeError("search down")
            return await real(deps, http, query, k)

        monkeypatch.setattr(tools, "_search", search_or_fail)
    run_model = FunctionModel(judge)
    if own_model:
        # SCREEN_MODEL: the screen's own model judges; the run's model is never asked.
        d.screen_model = run_model

        def never(messages: list[ModelMessage], info: AgentInfo) -> ModelResponse:
            raise AssertionError("the run's model screened")

        run_model = FunctionModel(never)
    ctx = SimpleNamespace(deps=d, model=run_model, usage=RunUsage())
    result = await tools.screen_regulations(ctx)  # pyright: ignore[reportArgumentType]
    return result, d, search, shown


async def test_the_screen_searches_each_entry_and_returns_what_to_read(
    store, settings, monkeypatch
) -> None:
    result, d, search, shown = await _screen(store, settings, monkeypatch)

    assert {r["regulation"]: r["because"] for r in result["to_read"]} == {
        "UN R901": "its scope applies",
        "UN R902": "its scope possibly applies",
        "UN R904": "named in the case: spec.pdf p.4: UN R904",
    }
    # No search finds the doors regulation: rule 3 leaves it out, and says so where it is listed.
    assert [r["regulation"] for r in result["rule3"]] == ["UN R903"]
    assert result["rule3_live"] is True
    assert [r["regulation"] for r in result["not_read"]] == ["UN R903"]
    assert "no search ranks it" in result["not_read"][0]["because"]
    # One search per function and per component, and the screen saw where each ranked.
    assert sorted(q or "" for q in search.queries) == ["emits signal", "emitter, electronic"]
    assert 'ranked 1 of 2 regulations for "emitter"' in "".join(shown)
    assert "No search for a function or component of the profile found it." in "".join(shown)
    rule3 = [e for e in store.payloads(d.run.id, "text") if "Rule 3" in e["text"]]
    assert rule3 and "live, left out" in rule3[0]["text"]


async def test_a_failed_search_puts_rule_3_back_in_shadow(store, settings, monkeypatch) -> None:
    # The component's search is the only one that finds UN R902. Without it R902 has no rank,
    # which is not evidence against it: rule 3 marks it and the doors one, and leaves out neither.
    result, d, _, _ = await _screen(store, settings, monkeypatch, failing="emitter, electronic")
    assert result["rule3_live"] is False
    assert [r["regulation"] for r in result["rule3"]] == ["UN R902", "UN R903"]
    assert {"UN R902", "UN R903"} <= {r["regulation"] for r in result["to_read"]}
    rule3 = [e for e in store.payloads(d.run.id, "text") if "Rule 3" in e["text"]]
    assert rule3 and "shadow" in rule3[0]["text"]


async def test_the_screen_runs_on_its_own_model_with_the_same_rules(
    store, settings, monkeypatch
) -> None:
    # Clemente, 2026-10-25: the same screen on Sonnet, keeping the guardrails (the fixed rules).
    on_run_model, *_ = await _screen(store, settings, monkeypatch)
    store.runs.clear()
    on_own_model, *_ = await _screen(store, settings, monkeypatch, own_model=True)

    assert on_own_model["not_screened"] == []
    assert on_own_model["to_read"] == on_run_model["to_read"]
