"""The code around the writer and the check (domain/writer.py), without the loop."""

import hashlib
from datetime import UTC, datetime
from uuid import uuid4

import pytest
from pydantic_ai.messages import ModelMessage, ModelResponse, RetryPromptPart, ToolCallPart
from pydantic_ai.models.function import AgentInfo, FunctionModel

from agent_service.domain import certivity, writer
from agent_service.records import LibraryVersion, Paragraph, Requirement

pytestmark = pytest.mark.anyio


def version(regulation: str = "UN R148", label: str = "00", role: str | None = "base"):
    return LibraryVersion(id=uuid4(), regulation=regulation, version_label=label, role=role)


def paragraph(position: int, page: int, text: str = "It shall.", label: str | None = None):
    return Paragraph(
        id=uuid4(),
        version_id=uuid4(),
        position=position,
        label=label or f"5.{position}",
        kind="paragraph",
        text=text,
        page_start=page,
        page_end=page,
        content_hash=hashlib.sha256(text.encode()).hexdigest(),
    )


def row(p: Paragraph, ext: str, text: str = "The lamp shall.", **changes) -> Requirement:
    fields = dict(
        id=uuid4(),
        case_id=uuid4(),
        organization_id=uuid4(),
        run_id=uuid4(),
        ext_id=ext,
        text=text,
        version_id=p.version_id,
        paragraph_id=p.id,
        paragraph_hash=p.content_hash,
        regulation="UN R148",
        version_label="00",
        page=p.page_start,
        paragraph=p.label,
    )
    return Requirement(**{**fields, **changes})


def test_windows_follow_pages_and_never_cut_a_paragraph() -> None:
    v = version()
    paragraphs = [paragraph(i, page) for i, page in enumerate([1, 3, 15, 16, 30, 31])]

    cut = writer.windows(v, paragraphs, max_pages=15)

    assert [[p.position for p in w.paragraphs] for w in cut] == [[0, 1, 2], [3, 4], [5]]
    assert [w.pages for w in cut] == ["1-15", "16-30", "31"]


def test_a_paragraph_longer_than_a_window_is_a_window_of_its_own() -> None:
    paragraphs = [paragraph(0, 1, "a" * 10), paragraph(1, 1, "b" * 100), paragraph(2, 1, "c")]

    cut = writer.windows(version(), paragraphs, max_chars=50)

    assert [[p.position for p in w.paragraphs] for w in cut] == [[0], [1], [2]]


def test_main_text_of_every_regulation_starts_before_any_annex() -> None:
    # A run that reaches its write reserve loses the windows not yet started: annex tails, not
    # the whole of the regulations named last.
    a, b = version("UN R1"), version("UN R2")
    a_main = [writer.Window(a, [paragraph(i, i)]) for i in range(3)]
    a_annex = [writer.Window(a, [paragraph(9, 9, label="Annex 3 1.2")])]
    b_main = [writer.Window(b, [paragraph(0, 1)])]
    b_annex = [
        writer.Window(b, [paragraph(5, 5, label="Appendix 2 1")]),
        writer.Window(b, [paragraph(6, 6, label="Annex 1 Part 1 2")]),
    ]

    queued = writer.queue_order([*a_main, *a_annex, *b_main, *b_annex])

    assert queued == [
        a_main[0],
        b_main[0],
        a_main[1],
        a_main[2],
        a_annex[0],
        b_annex[0],
        b_annex[1],
    ]


def test_the_window_shows_numbers_labels_pages_and_headings() -> None:
    p = paragraph(7, 12, "5.4.2. The lamp shall be red.", label="5.4.2")
    p = p.model_copy(update={"heading": "5. General"})

    text = writer.Window(version(), [p]).render()

    assert "## 5. General" in text
    assert "[#7] 5.4.2 (page 12)\n5.4.2. The lamp shall be red." in text


def test_the_base_version_is_cited_never_the_latest() -> None:
    base, latest = version(label="06"), version(label="07", role="latest")

    assert writer.citable_version([latest, base], "UN R148") is base
    with pytest.raises(writer.UnknownRegulation, match="not in the library"):
        writer.citable_version([base], "UN R999")
    with pytest.raises(writer.UnknownRegulation, match="none is the base"):
        writer.citable_version([latest, version(label="08", role=None)], "UN R148")


def test_the_submission_is_built_from_rows_and_leaves_rejected_ones_out() -> None:
    v = version()
    a, b = paragraph(0, 4, label="5.4.2"), paragraph(1, 9, label="Annex 3 Part 1 1.2")
    rows = [row(a, "R-001"), row(b, "R-002", test_case="Measure it."), row(a, "R-003")]
    rows[2] = rows[2].model_copy(update={"status": "rejected"})

    data = writer.submission("team-7", "dev-rear-lamp", rows)

    assert [r["id"] for r in data["requirements"]] == ["R-001", "R-002"]
    assert data["requirements"][1] == {
        "id": "R-002",
        "text": "The lamp shall.",
        "source": {
            "regulation": "UN R148",
            "version": "00",
            "page": 9,
            "paragraph": "Annex 3 Part 1 1.2",
        },
        "test_case": "Measure it.",
    }
    index = [{"regulation": v.regulation, "versions": [{"version_label": "00", "role": "base"}]}]
    assert certivity._tool("validate").validate(data, index=index) == []


def test_a_version_the_library_does_not_have_fails_validation() -> None:
    data = writer.submission("t", "c", [row(paragraph(0, 4), "R-001", version_label="99")])

    problems = certivity._tool("validate").validate(
        data, index=[{"regulation": "UN R148", "versions": [{"version_label": "00"}]}]
    )

    assert [p.path for p in problems] == ["$.requirements[0].source.version"]


def test_code_finds_duplicates_and_stale_citations() -> None:
    a, b = paragraph(0, 4), paragraph(1, 5)
    rows = [
        row(a, "R-001", "The lamp shall be red."),
        row(a, "R-002", "The lamp  shall be RED."),
        row(b, "R-003", page=99),
        row(b, "R-004", paragraph_id=None),
        row(b, "R-005", "It is green.", paragraph_superseded_at=datetime(2026, 10, 24, tzinfo=UTC)),
    ]

    found = writer.code_findings(rows, {a.id: a, b.id: b})

    assert set(found) == {"R-002", "R-003", "R-004", "R-005"}
    assert "re-extracted with different text on 2026-10-24" in found["R-005"]
    assert found["R-002"].startswith("Duplicate of R-001")
    assert "no longer matches" in found["R-003"]
    assert "no longer in the library" in found["R-004"]


def test_code_finds_a_duplicate_in_other_words_but_keeps_different_conditions() -> None:
    # Made up. One device or two, 45 or 30 degrees: two obligations. The same words reordered,
    # with a plural or an article more: one.
    a = paragraph(0, 4)
    rows = [
        row(a, "R-001", "Where there is one device, the angle shall be 45° to the left and right."),
        row(a, "R-002", "Where there are two devices, the angle shall be 45° out and 30° in."),
        row(a, "R-003", "The angle shall be 45° to the right and left, where there is one device."),
        row(a, "R-004", "The housing shall not be opened."),
        row(a, "R-005", "The housing shall be opened."),
    ]

    found = writer.code_findings(rows, {a.id: a})

    assert set(found) == {"R-003"}
    assert found["R-003"].startswith("Duplicate of R-001")


def test_uncovered_lists_obligations_nobody_cites() -> None:
    v = version()
    cited = paragraph(0, 4, "It shall be red.")
    missed = paragraph(1, 5, "It must be fitted.")
    plain = paragraph(2, 6, "A lamp is a device.")

    out = writer.uncovered([cited, missed, plain], [row(cited, "R-001")], v)

    assert out == [{"regulation": "UN R148", "paragraph": "5.1", "page": 5}]
    # One a writer set aside clause by clause is its decision, not a gap to write again.
    assert writer.uncovered([cited, missed], [row(cited, "R-001")], v, {missed.id: "x"}) == []


async def test_a_writer_citing_a_paragraph_outside_its_window_is_asked_again() -> None:
    window = writer.Window(version(), [paragraph(3, 4)])
    calls: list[int] = []

    def model(messages: list[ModelMessage], info: AgentInfo) -> ModelResponse:
        retried = any(
            isinstance(p, RetryPromptPart) for m in messages for p in getattr(m, "parts", [])
        )
        calls.append(1)
        ref = 3 if retried else 99
        return ModelResponse(
            parts=[
                ToolCallPart(
                    "record_requirements",
                    {
                        "requirements": [
                            {
                                "ref": ref,
                                "clauses": ["c3.1"],
                                "text": "The lamp shall.",
                                "test_case": "Look.",
                            }
                        ]
                    },
                )
            ]
        )

    result = await writer.writer_agent.run(window.render(), model=FunctionModel(model), deps=window)

    assert [d.ref for d in result.output.requirements] == [3]
    assert len(calls) == 2


@pytest.mark.parametrize(("team_id", "case_id"), [("", "dev-rear-lamp"), ("team-09", "")])
def test_a_submission_without_team_or_case_is_refused(team_id: str, case_id: str) -> None:
    # validate.py accepts such a file; the platform would score it as nobody's.
    with pytest.raises(ValueError, match="team_id and case_id"):
        writer.submission(team_id, case_id, [])


def test_a_paragraph_is_cut_into_one_clause_per_obligation() -> None:
    text = (
        "4.1. Every device of class A, when tested according to the test procedure, shall meet:\n"
        "(a) The dimension requirements; and\n"
        "(b) The strength requirements.\n"
    )
    assert writer.clauses(text) == ["The dimension requirements; and", "The strength requirements."]
    two = "4.2. The housing shall be sealed. It shall not be opened without a tool. See Annex 2."
    assert writer.clauses(two) == [
        "The housing shall be sealed.",
        "It shall not be opened without a tool.",
    ]
    assert writer.clauses("2.1. 'Housing' means the outer shell.") == []
    # A list whose "shall" is in the paragraph above, and an enumeration inside one sentence.
    marks = (
        "3.5. Bear the following markings.\n(a) On the module:\n(i) The trade name;\n(ii) The code."
    )
    assert writer.clauses(marks) == ["The trade name;", "The code."]
    inline = "4.1. Each module shall bear (i) the trade name, (ii) the code and (iii) the voltage."
    assert writer.clauses(inline) == ["the trade name", "the code", "the voltage."]
    reference = "4.2. It shall carry the code as prescribed in paragraph 3.5. (a), (ii)."
    assert writer.clauses(reference) == ["It shall carry the code as prescribed in paragraph 3.5."]


def answering(*answers: dict[str, object]) -> tuple[FunctionModel, list[int]]:
    """A writer that gives these answers in turn, the last one again if asked more often."""
    calls: list[int] = []

    def model(messages: list[ModelMessage], info: AgentInfo) -> ModelResponse:
        calls.append(1)
        args = answers[min(len(calls), len(answers)) - 1]
        return ModelResponse(parts=[ToolCallPart(info.output_tools[0].name, args)])

    return FunctionModel(model), calls


RED = "5.3. It shall be red. It shall not flash."
ONE = {"ref": 3, "clauses": ["c3.1"], "text": "It shall be red.", "test_case": "Look."}


async def test_a_writer_that_leaves_a_clause_unanswered_is_asked_for_it() -> None:
    window = writer.Window(version(), [paragraph(3, 4, RED)])
    assert window.clause_ids == {"c3.1", "c3.2"}
    model, calls = answering(
        {"requirements": [ONE]},
        {"requirements": [ONE], "set_aside": [{"clause": "c3.2", "reason": "not_this_product"}]},
    )

    result = await writer.writer_agent.run(window.render(), model=model, deps=window)

    assert len(calls) == 2
    assert [a.clause for a in result.output.set_aside] == ["c3.2"]


async def test_the_last_try_is_kept_even_with_clauses_unanswered() -> None:
    # A failed window loses every requirement in it; an unanswered clause only itself.
    window = writer.Window(version(), [paragraph(3, 4, RED)])
    model, calls = answering({"requirements": [ONE]})

    result = await writer.writer_agent.run(window.render(), model=model, deps=window)

    assert len(calls) == 2  # asked once, then kept
    assert [d.text for d in result.output.requirements] == ["It shall be red."]


async def test_an_obligation_must_name_what_of_the_profile_it_covers() -> None:
    # Certivity's tips (Clemente, 23:01): an obligation that covers no function or component of
    # the part is noise. Code holds `covers` to the profile; case and end punctuation are forgiven.
    profile = writer.ProductProfile(part="A made-up widget.", functions=["Emits a made-up signal"])
    window = writer.Window(version(), [paragraph(3, 4, RED)], covers_from=writer.coverable(profile))
    aside = [{"clause": "c3.2", "reason": "not_this_product"}]
    first = {"ref": 3, "covers": "a heating function", "clauses": ["c3.1"], "what": "Red."}
    model, calls = answering(
        {"obligations": [first], "set_aside": aside},
        {"obligations": [{**first, "covers": "emits a made-up signal."}], "set_aside": aside},
    )

    result = await writer.disposition_agent.run(window.render(), model=model, deps=window)

    assert len(calls) == 2
    assert [o.covers for o in result.output.obligations] == ["emits a made-up signal."]
    assert writer.coverable(profile) == ("Emits a made-up signal", writer.WHOLE_PART)


async def test_a_translator_reads_the_table_an_obligation_refers_to() -> None:
    # The values of an obligation are often in a table outside its window.
    v = version()
    rule = paragraph(3, 4, "5.3. It shall meet the values of Table 2.")
    table = paragraph(80, 40, "Table 2: at least 5 N.", label="Annex 2 1")
    window = writer.Window(v, [rule])
    found = writer.Disposition(obligations=[writer.Obligation(ref=3, clauses=["c3.1"], what="x")])
    [job] = writer.translation_jobs(window, found, [rule, table])
    assert "Clause {c3.1}: It shall meet the values of Table 2." in job.render()
    calls: list[str] = []

    def model(messages: list[ModelMessage], info: AgentInfo) -> ModelResponse:
        if not calls:
            calls.append("read")
            return ModelResponse(
                parts=[ToolCallPart("read_version_paragraphs", {"labels": ["Annex 2 1"]})]
            )
        assert "at least 5 N" in str(messages)
        draft = {"ref": 3, "text": "It shall withstand at least 5 N.", "test_case": "Pull."}
        return ModelResponse(parts=[ToolCallPart("record_translations", {"response": [draft]})])

    result = await writer.translator_agent.run(job.render(), model=FunctionModel(model), deps=job)

    assert [d.text for d in result.output] == ["It shall withstand at least 5 N."]


def test_obligations_are_translated_ten_at_a_time() -> None:
    p = paragraph(3, 4, "5.3. It shall.")
    window = writer.Window(version(), [p])
    found = writer.Disposition(
        obligations=[writer.Obligation(ref=3, what=f"item {i}") for i in range(23)]
    )
    jobs = writer.translation_jobs(window, found, [p])
    assert [len(j.obligations) for j in jobs] == [10, 10, 3]


async def test_a_translator_writes_one_requirement_per_obligation() -> None:
    # The first stage splits; a second split multiplied the output (Clemente, 2026-10-25).
    window = writer.Window(version(), [paragraph(3, 4, RED)])
    found = writer.Disposition(obligations=[writer.Obligation(ref=3, clauses=["c3.1"], what="x")])
    [job] = writer.translation_jobs(window, found, [])
    two = [
        {"ref": 3, "text": "It shall be red.", "test_case": "Look."},
        {"ref": 3, "text": "It shall be visibly red.", "test_case": "Look."},
    ]
    calls: list[int] = []

    def model(messages: list[ModelMessage], info: AgentInfo) -> ModelResponse:
        calls.append(1)
        return ModelResponse(parts=[ToolCallPart("record_translations", {"response": two})])

    result = await writer.translator_agent.run(job.render(), model=FunctionModel(model), deps=job)

    assert len(calls) == 2  # asked once, then the first one per obligation is kept
    assert [d.text for d in result.output] == ["It shall be red."]


async def test_an_obligation_over_two_clauses_may_give_one_requirement_per_clause() -> None:
    # One flat requirement per obligation lost recall where the first stage grouped clauses.
    window = writer.Window(version(), [paragraph(3, 4, RED)])
    found = writer.Disposition(
        obligations=[writer.Obligation(ref=3, clauses=["c3.1", "c3.2"], what="x")]
    )
    [job] = writer.translation_jobs(window, found, [])
    two = [
        {"ref": 3, "clauses": ["c3.1"], "text": "It shall be red.", "test_case": "Look."},
        {"ref": 3, "clauses": ["c3.2"], "text": "It shall not flash.", "test_case": "Look."},
    ]

    def model(messages: list[ModelMessage], info: AgentInfo) -> ModelResponse:
        return ModelResponse(parts=[ToolCallPart("record_translations", {"response": two})])

    result = await writer.translator_agent.run(job.render(), model=FunctionModel(model), deps=job)

    assert [d.text for d in result.output] == ["It shall be red.", "It shall not flash."]


def _o(ref: int, *clauses: str, covers: str = "", what: str = "x") -> writer.Obligation:
    return writer.Obligation(ref=ref, clauses=list(clauses), covers=covers, what=what)


def _aside(clause: str) -> writer.SetAside:
    return writer.SetAside(clause=clause, reason="not_this_product")


def test_the_union_keeps_a_clause_one_sample_kept_and_no_longer_sets_it_aside() -> None:
    a = writer.Disposition(obligations=[_o(3, "c3.1", covers="Lens")], set_aside=[_aside("c3.2")])
    b = writer.Disposition(obligations=[_o(3, "c3.1", "c3.2")], set_aside=[])

    found, agreement = writer.vote_dispositions([a, b], need=1)

    assert [(o.ref, o.clauses, o.covers) for o in found.obligations] == [
        (3, ["c3.1"], "Lens"),
        (3, ["c3.2"], ""),
    ]
    assert found.set_aside == []
    assert agreement == {"vote: kept by all": 1, "vote: kept by some": 1, "vote: dropped": 0}


def test_the_majority_drops_what_one_sample_of_two_kept_and_keeps_its_reason() -> None:
    a = writer.Disposition(obligations=[_o(3, "c3.1")], set_aside=[_aside("c3.2")])
    b = writer.Disposition(obligations=[_o(3, "c3.1", "c3.2", "c3.2")], set_aside=[])

    found, agreement = writer.vote_dispositions([a, b], need=2)

    # The clause list is deduplicated: the translator's cap is one requirement per clause.
    assert [o.clauses for o in found.obligations] == [["c3.1"]]
    assert [s.clause for s in found.set_aside] == ["c3.2"]
    assert agreement["vote: dropped"] == 1


def test_rows_without_clauses_are_voted_on_by_how_many() -> None:
    # Three table rows on one paragraph in one sample, two in the other: a vote on the count.
    a = writer.Disposition(obligations=[_o(7, what=f"row {i}") for i in range(3)])
    b = writer.Disposition(obligations=[_o(7, what=f"row {i}") for i in range(2)])

    union, _ = writer.vote_dispositions([a, b], need=1)
    majority, _ = writer.vote_dispositions([a, b], need=2)

    assert [o.what for o in union.obligations] == ["row 0", "row 1", "row 2"]
    assert [o.what for o in majority.obligations] == ["row 0", "row 1"]


def test_a_translator_is_given_the_paragraphs_an_obligation_refers_to() -> None:
    v = version()
    rule = paragraph(3, 4, "5.3. It shall meet paragraph 6.2. and paragraph 1 of Annex 2.")
    main = paragraph(40, 9, "6.2. At least 5 N.", label="6.2")
    annex = paragraph(80, 40, "1. Pull for 10 s.", label="Annex 2 1")
    unrelated = paragraph(81, 41, "1. Something else.", label="1")
    window = writer.Window(v, [rule])
    found = writer.Disposition(obligations=[_o(3, "c3.1")])

    [job] = writer.translation_jobs(window, found, [rule, main, annex, unrelated])

    assert [p.label for p in job.referred_to()] == ["6.2", "Annex 2 1"]
    assert "At least 5 N." in job.render() and "Pull for 10 s." in job.render()


def test_a_reference_inside_an_annex_resolves_in_that_annex_first() -> None:
    v = version()
    rule = paragraph(90, 50, "2. As described in paragraph 1.", label="Annex 3 2")
    body = paragraph(1, 1, "1. Scope.", label="1")
    same_annex = paragraph(89, 50, "1. The test bench.", label="Annex 3 1")
    window = writer.Window(v, [rule])
    found = writer.Disposition(obligations=[_o(90)])

    [job] = writer.translation_jobs(window, found, [body, same_annex, rule])

    assert [p.label for p in job.referred_to()] == ["Annex 3 1"]


def test_an_uncovered_obligation_a_search_found_says_for_what() -> None:
    v = version()
    missed = paragraph(1, 5, "It must be fitted.")

    out = writer.uncovered([missed], [], v, focus={missed.id: ["an LED"]})

    assert out == [{"regulation": "UN R148", "paragraph": "5.1", "page": 5, "found_by": ["an LED"]}]
