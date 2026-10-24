"""A run on a sub-goal case (#42, SYS-45): Certivity's folder in, the changes file out, the main
goal's workflow with the rules diff and the reviewer inside. Every regulation, requirement and PDF
here is made up; `paragraphs.extract` is replaced so a "PDF" is just a key to its paragraphs."""

import hashlib
import json
from dataclasses import dataclass, field
from typing import Any
from uuid import UUID, uuid4

import httpx
import pytest
from pydantic_ai.messages import ModelMessage, ModelResponse, ToolCallPart
from pydantic_ai.models.function import AgentInfo, FunctionModel
from pydantic_ai.usage import RunUsage

from agent_service import runner
from agent_service.domain import paragraphs, regdiff, subgoal, subgoal_review
from agent_service.settings import Settings
from tests.fakes import ORG, InMemoryRunStore

pytestmark = pytest.mark.anyio


@dataclass(frozen=True)
class P:
    label: str
    text: str
    page_start: int = 1


@dataclass(frozen=True)
class FakeExtraction:
    paragraphs: list[P]
    version_label: str | None
    page_count: int = 3
    warnings: list[str] = field(default_factory=list)


SPEC = P("5", "5. Specifications")
OLD = [
    SPEC,
    P(
        "5.1",
        "5.1. The widget shall be red.\nThe widget shall weigh at most 2 kg.\n"
        "The widget shall be marked with its maker's name.",
        2,
    ),
]
NEW = [
    SPEC,
    P(
        "5.1",
        "5.1. The widget shall be red.\nThe widget shall weigh at most 3 kg.\n"
        "The widget shall be marked with its maker's name and address.",
        3,
    ),
]
VERSIONS = {b"old-pdf": FakeExtraction(OLD, "1.0.0"), b"new-pdf": FakeExtraction(NEW, "2.0.0")}

REQUIREMENTS = [
    {
        "id": "R-001",
        "text": "The widget shall be red.",
        "source": {"regulation": "UN R999", "page": 2, "paragraph": "5.1"},
    },
    # Reworded so word overlap traces it to the wrong sentence ("red" shares more of its words
    # than the weight sentence does): the case the reviewer is for.
    {
        "id": "R-002",
        "text": "A widget's mass must not exceed two kilograms.",
        "source": {"regulation": "UN R999", "page": 2, "paragraph": "5.1"},
    },
    {
        "id": "R-003",
        "text": "The widget shall be marked with its maker's name.",
        "source": {"regulation": "UN R999", "page": 2, "paragraph": "5.1"},
    },
]
ANSWER_KEY = {"team_id": "x", "case_id": "y", "changes": []}


@pytest.fixture(autouse=True)
def fake_pdfs(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(paragraphs, "extract", lambda pdf: VERSIONS[pdf])


def subgoal_case(store: InMemoryRunStore, *files: tuple[str, str, bytes]) -> UUID:
    case_id = uuid4()
    store.case_names[case_id] = "subgoal-test"
    store.case_kinds[case_id] = "subgoal"
    store.organization_names[ORG] = "team-test"
    for name, fmt, data in files:
        store.add_case_file(case_id, name, fmt, data)
    return case_id


def requirements_file() -> tuple[str, str, bytes]:
    return ("requirements_old.json", "json", json.dumps(REQUIREMENTS).encode())


def listing(old_sha: str | None = None) -> tuple[str, str, bytes]:
    entries = [
        {
            "name": "old.pdf",
            "pdf_url": "https://example.test/old.pdf",
            "sha256": old_sha or hashlib.sha256(b"old-pdf").hexdigest(),
        },
        {
            "name": "new.pdf",
            "pdf_url": "https://example.test/new.pdf",
            "sha256": hashlib.sha256(b"new-pdf").hexdigest(),
        },
    ]
    return ("files.json", "json", json.dumps(entries).encode())


async def advance(store: InMemoryRunStore, settings: Settings, run_id: UUID) -> str:
    plan = await runner.prepare(store, settings, run_id)
    return await runner.execute(store, settings, plan)


def rules_file() -> dict[str, Any]:
    old = regdiff.build_version("UN R999", "1.0.0", OLD)
    new = regdiff.build_version("UN R999", "2.0.0", NEW)
    changes = regdiff.diff_versions(REQUIREMENTS, old, new)
    return regdiff.submission("team-test", "subgoal-test", changes)


def tools(store: InMemoryRunStore, run_id: UUID) -> list[str]:
    return [p["tool_name"] for p in store.payloads(run_id, "tool_call")]


# ------------------------------------------------------------------------------------------
# Ingest: what each file of the folder is taken for
# ------------------------------------------------------------------------------------------


async def test_ingest_says_what_each_file_is_and_holds_back_the_answer_key(store) -> None:
    case_id = subgoal_case(
        store,
        requirements_file(),
        listing(),
        ("old.pdf", "pdf", b"old-pdf"),
        ("expected.json", "json", json.dumps(ANSWER_KEY).encode()),
        ("notes.json", "json", b'{"a": 1}'),
    )

    counts = await subgoal.ingest_case(store, case_id)

    assert counts == {"parsed": 3, "failed": 2}
    by_name = {f.filename: f for f in store.cases[case_id]}
    assert "old version: 3, citing UN R999" in " ".join(by_name["requirements_old.json"].notes)
    assert "old.pdf, new.pdf" in " ".join(by_name["files.json"].notes)
    assert "version 1.0.0" in " ".join(by_name["old.pdf"].notes)
    assert by_name["expected.json"].status == "failed"
    assert "answer key" in (by_name["expected.json"].error or "")
    assert by_name["notes.json"].status == "failed"


# ------------------------------------------------------------------------------------------
# The run
# ------------------------------------------------------------------------------------------


async def test_a_run_on_two_uploaded_pdfs_gives_the_rules_file_through_the_main_workflow(
    store, settings
) -> None:
    # Uploaded new first: the names decide which is old, not the order.
    case_id = subgoal_case(
        store,
        ("new.pdf", "pdf", b"new-pdf"),
        requirements_file(),
        ("old.pdf", "pdf", b"old-pdf"),
    )
    run_id = store.add_run("Find the changes.", case_id=case_id)

    assert await advance(store, settings, run_id) == "succeeded"

    # The scripted reviewer agrees with the comparison, so the file is exactly the rules' file:
    # what the CLI writes for the same inputs.
    assert json.loads(store.outputs[run_id] or "null") == rules_file()
    assert tools(store, run_id) == [
        "read_case",
        "extract_versions",
        "compare_versions",
        "review_changes",
    ]
    # No pause: nothing is submitted, a person uploads the file (SYS-13).
    assert store.approvals == []


async def test_a_run_fetches_the_versions_from_files_json_and_keeps_them_in_the_case(
    store, settings, monkeypatch: pytest.MonkeyPatch
) -> None:
    served = {"/old.pdf": b"old-pdf", "/new.pdf": b"new-pdf"}
    fetched: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        fetched.append(request.url.path)
        return httpx.Response(200, content=served[request.url.path])

    monkeypatch.setattr(
        subgoal, "http_client", lambda: httpx.AsyncClient(transport=httpx.MockTransport(handler))
    )
    case_id = subgoal_case(store, requirements_file(), listing())

    assert await advance(store, settings, store.add_run("x", case_id=case_id)) == "succeeded"
    assert fetched == ["/old.pdf", "/new.pdf"]
    kept = {f.filename: f for f in store.cases[case_id] if f.format == "pdf"}
    assert set(kept) == {"old.pdf", "new.pdf"}
    assert store.objects[kept["old.pdf"].storage_path] == b"old-pdf"
    assert kept["old.pdf"].storage_path.startswith(f"{ORG}/{case_id}/")

    # The next run reads what the case now holds: the links may have expired.
    second = store.add_run("x", case_id=case_id)
    assert await advance(store, settings, second) == "succeeded"
    assert fetched == ["/old.pdf", "/new.pdf"]
    assert json.loads(store.outputs[second] or "null") == rules_file()


async def test_a_pdf_that_is_not_the_one_files_json_lists_fails_the_run(
    store, settings, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(
        subgoal,
        "http_client",
        lambda: httpx.AsyncClient(
            transport=httpx.MockTransport(lambda r: httpx.Response(200, content=b"old-pdf"))
        ),
    )
    case_id = subgoal_case(store, requirements_file(), listing(old_sha="0" * 64))
    run_id = store.add_run("x", case_id=case_id)

    assert await advance(store, settings, run_id) == "failed"
    assert "checksum" in (store.errors[run_id] or "")
    assert not [f for f in store.cases[case_id] if f.format == "pdf"]


async def test_the_answer_key_in_the_case_changes_nothing_in_the_file(store, settings) -> None:
    pdfs = (("old.pdf", "pdf", b"old-pdf"), ("new.pdf", "pdf", b"new-pdf"))
    plain = subgoal_case(store, requirements_file(), *pdfs)
    key = {"team_id": "t", "case_id": "c", "changes": [{"change": "removed"}]}
    with_key = subgoal_case(
        store, requirements_file(), ("expected.json", "json", json.dumps(key).encode()), *pdfs
    )
    a, b = store.add_run("x", case_id=plain), store.add_run("x", case_id=with_key)

    assert await advance(store, settings, a) == await advance(store, settings, b) == "succeeded"
    assert store.outputs[a] == store.outputs[b]
    read = store.payloads(b, "tool_result")[0]["result"]
    assert "expected.json: an answer key, not used." in read


async def test_a_case_without_requirements_fails_saying_what_to_add(store, settings) -> None:
    case_id = subgoal_case(store, ("old.pdf", "pdf", b"old-pdf"), ("new.pdf", "pdf", b"new-pdf"))
    run_id = store.add_run("x", case_id=case_id)

    assert await advance(store, settings, run_id) == "failed"
    assert "requirements_old.json" in (store.errors[run_id] or "")


async def test_with_the_review_off_the_rules_answer_stands_and_the_trace_says_so(
    store, settings
) -> None:
    case_id = subgoal_case(
        store, requirements_file(), ("old.pdf", "pdf", b"old-pdf"), ("new.pdf", "pdf", b"new-pdf")
    )
    run_id = store.add_run("x", case_id=case_id)
    off = settings.model_copy(update={"subgoal_review": False})

    assert await advance(store, off, run_id) == "succeeded"
    assert "review_changes" not in tools(store, run_id)
    assert any("Not reviewed" in p["text"] for p in store.payloads(run_id, "text"))
    assert json.loads(store.outputs[run_id] or "null") == rules_file()


# ------------------------------------------------------------------------------------------
# The reviewer: what a verdict may change
# ------------------------------------------------------------------------------------------


def aligned() -> tuple[regdiff.Version, regdiff.Version, list[regdiff.Change]]:
    old = regdiff.build_version("UN R999", "1.0.0", OLD)
    new = regdiff.build_version("UN R999", "2.0.0", NEW)
    return old, new, regdiff.diff_versions(REQUIREMENTS, old, new)


def answering(verdicts: list[dict[str, Any]] | Exception) -> FunctionModel:
    def respond(messages: list[ModelMessage], info: AgentInfo) -> ModelResponse:
        if isinstance(verdicts, Exception):
            raise verdicts
        return ModelResponse(parts=[ToolCallPart("report_verdicts", {"response": verdicts})])

    return FunctionModel(respond)


async def run_review(
    model: FunctionModel,
) -> tuple[subgoal_review.Report, list[regdiff.Change]]:
    old, new, rules = aligned()
    found = subgoal_review.candidates(REQUIREMENTS, old, new)
    order = {r["id"]: i for i, r in enumerate(REQUIREMENTS)}

    async def progress(_: str) -> None:
        return None

    report = await subgoal_review.review(
        found, old, new, rules, model, subgoal_review.Limits(batch_size=2), progress, order
    )
    return report, rules


def test_the_rules_miss_a_reworded_requirement_traced_to_the_wrong_sentence() -> None:
    # The premise of the reviewer, checked so the next tests mean something.
    _, _, rules = aligned()
    assert {c.requirement_id for c in rules} == {"R-003"}


def test_only_requirements_whose_cited_paragraph_changed_are_reviewed() -> None:
    same = P("6.1", "6.1. The widget shall be kept dry.", 4)
    old = regdiff.build_version("UN R999", "1.0.0", [*OLD, same])
    new = regdiff.build_version("UN R999", "2.0.0", [*NEW, same])
    regdiff.align(old, new)
    dry = {"id": "R-9", "text": "Keep the widget dry.", "source": {"paragraph": "6.1", "page": 4}}

    found = subgoal_review.candidates([*REQUIREMENTS, dry], old, new)

    assert [c.id for c in found] == ["R-001", "R-002", "R-003"]


async def test_a_verified_quote_flags_what_the_rules_missed_with_the_regulations_wording() -> None:
    report, _ = await run_review(
        answering(
            [
                {
                    "requirement_id": "R-002",
                    "verdict": "modified",
                    "old_quote": "The widget shall weigh at most 2 kg.",
                    "new_quote": "The widget shall weigh at most 3 kg.",
                    "reason": "The limit rose from 2 kg to 3 kg.",
                }
            ]
        )
    )

    by_id = {c.requirement_id: c for c in report.changes}
    flagged = by_id["R-002"]
    assert flagged.change == "modified"
    # Re-diffed by code from the quoted sentence: the regulation's own wording, page from code.
    assert flagged.new_text == "The widget shall weigh at most 3 kg."
    assert (flagged.page, flagged.paragraph) == (3, "5.1")
    assert "R-003" in by_id
    assert [c.requirement_id for c in report.changes if c.change != "added"] == ["R-002", "R-003"]


async def test_a_quote_that_is_not_in_the_pdfs_changes_nothing() -> None:
    report, rules = await run_review(
        answering(
            [
                {
                    "requirement_id": "R-002",
                    "verdict": "modified",
                    "old_quote": "The widget shall never weigh more than two kilograms.",
                    "new_quote": "The widget shall never weigh more than three kilograms.",
                    "reason": "Invented.",
                }
            ]
        )
    )

    assert report.changes == rules
    assert report.unverified == ["R-002"]


async def test_a_flag_is_dropped_only_when_the_corrected_trace_and_the_reviewer_agree() -> None:
    old, new, rules = aligned()
    # A made-up flag on R-001, whose sentence did not change.
    wrong = regdiff.Change("modified", "R-001", "x", "made up", 3, "5.1")
    found = subgoal_review.candidates(REQUIREMENTS, old, new)
    [r1] = [c for c in found if c.id == "R-001"]
    unchanged = subgoal_review.Verdict(
        requirement_id="R-001",
        verdict="unchanged",
        old_quote="The widget shall be red.",
        reason="Same colour.",
    )
    report = subgoal_review.Report(rules, RunUsage())

    merged = subgoal_review.merge([wrong, *rules], [(r1, unchanged)], old, new, report, {})

    assert "R-001" not in {c.requirement_id for c in merged}
    # The reviewer alone cannot drop a flag: with a quote that is not in the old text it stays.
    report = subgoal_review.Report(rules, RunUsage())
    misquoted = unchanged.model_copy(update={"old_quote": "The widget shall be painted red."})
    kept = subgoal_review.merge([wrong, *rules], [(r1, misquoted)], old, new, report, {})
    assert "R-001" in {c.requirement_id for c in kept}


async def test_a_failed_batch_is_tried_again_then_keeps_the_rules_answer() -> None:
    report, rules = await run_review(answering(RuntimeError("provider down")))

    assert report.changes == rules
    assert report.failed and all("provider down" in f for f in report.failed)
    assert report.reviewed == 0
