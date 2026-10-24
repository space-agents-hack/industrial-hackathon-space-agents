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


def test_uncovered_lists_obligations_nobody_cites() -> None:
    v = version()
    cited = paragraph(0, 4, "It shall be red.")
    missed = paragraph(1, 5, "It must be fitted.")
    plain = paragraph(2, 6, "A lamp is a device.")

    out = writer.uncovered([cited, missed, plain], [row(cited, "R-001")], v)

    assert out == [{"regulation": "UN R148", "paragraph": "5.1", "page": 5}]


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
                    {"response": [{"ref": ref, "text": "The lamp shall.", "test_case": "Look."}]},
                )
            ]
        )

    result = await writer.writer_agent.run(window.render(), model=FunctionModel(model), deps=window)

    assert [d.ref for d in result.output] == [3]
    assert len(calls) == 2


@pytest.mark.parametrize(("team_id", "case_id"), [("", "dev-rear-lamp"), ("team-09", "")])
def test_a_submission_without_team_or_case_is_refused(team_id: str, case_id: str) -> None:
    # validate.py accepts such a file; the platform would score it as nobody's.
    with pytest.raises(ValueError, match="team_id and case_id"):
        writer.submission(team_id, case_id, [])
