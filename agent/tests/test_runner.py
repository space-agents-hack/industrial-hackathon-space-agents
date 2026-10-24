"""The loop end to end with the scripted model: start, write, check, pause for approval, resume."""

import hashlib
import json
from datetime import UTC, datetime, timedelta

import pytest

from agent_service import runner
from agent_service.domain import certivity
from agent_service.settings import Settings
from tests.fakes import ORG, TASK, InMemoryRunStore, case_run, seed_library

pytestmark = pytest.mark.anyio

QUIET = "Write the requirements."


async def advance(store: InMemoryRunStore, settings: Settings, run_id) -> str:
    plan = await runner.prepare(store, settings, run_id)
    return await runner.execute(store, settings, plan)


def submitted(store: InMemoryRunStore, run_id) -> dict:
    return json.loads(store.outputs[run_id] or "null")


async def test_a_run_writes_drafts_and_pauses_before_approving_them(store, settings) -> None:
    run_id = case_run(store)

    assert await advance(store, settings, run_id) == "awaiting_approval"

    [approval] = store.approvals
    assert approval.tool_name == "export_requirements"
    rows = await store.run_requirements(run_id)
    # Three obligations in the case's regulations, plus one the check rejected; none approved yet.
    assert [r.status for r in rows].count("draft") == 3
    assert [r.paragraph for r in rows if r.status == "rejected"] == ["6.1"]
    assert "approved" not in {r.status for r in rows}
    assert [r.ext_id for r in rows] == ["R-001", "R-002", "R-003", "R-004"]
    # The writer read the base version; the latest one is the sub-goal's.
    assert {(r.regulation, r.version_label) for r in rows} == {("UN R148", "00"), ("UN R48", "06")}
    assert store.kinds(run_id)[-2:] == ["approval_requested", "status"]
    assert store.models[run_id] == "scripted"


async def test_every_citation_is_copied_from_the_paragraph_it_links(store, settings) -> None:
    run_id = case_run(store)
    await advance(store, settings, run_id)

    paragraphs = {p.id: p for ps in store.paragraphs.values() for p in ps}
    for r in await store.run_requirements(run_id):
        assert r.paragraph_id is not None
        p = paragraphs[r.paragraph_id]
        assert (r.version_id, r.page, r.paragraph, r.paragraph_hash) == (
            p.version_id,
            p.page_start,
            p.label,
            p.content_hash,
        )


async def test_an_approved_export_approves_the_drafts_and_the_file_is_valid(
    store, settings
) -> None:
    run_id = case_run(store)
    await advance(store, settings, run_id)
    store.decide(run_id, "approved")

    assert await advance(store, settings, run_id) == "succeeded"

    statuses = [r.status for r in await store.run_requirements(run_id)]
    assert statuses.count("approved") == 3 and statuses.count("rejected") == 1
    data = submitted(store, run_id)
    assert (data["team_id"], data["case_id"]) == ("team-09", "dev-rear-lamp")
    kept = [r.ext_id for r in await store.run_requirements(run_id) if r.status != "rejected"]
    assert [r["id"] for r in data["requirements"]] == kept
    index = await store.regulation_index(ORG)
    problems = certivity._tool("validate").validate(data, index=index)
    assert problems == []
    exports = [
        p for p in store.payloads(run_id, "tool_call") if p["tool_name"] == "export_requirements"
    ]
    # One call in the log although the library announces it before the pause and after it.
    assert len(exports) == 1


async def test_a_denied_export_approves_nothing_and_still_gives_the_file(store, settings) -> None:
    run_id = case_run(store)
    await advance(store, settings, run_id)
    store.decide(run_id, "denied", note="Wait for the photometry review on Friday.")

    assert await advance(store, settings, run_id) == "succeeded"

    assert "approved" not in {r.status for r in await store.run_requirements(run_id)}
    assert len(submitted(store, run_id)["requirements"]) == 3
    said = " ".join(p["text"] for p in store.payloads(run_id, "text"))
    assert "Wait for the photometry review on Friday." in said
    assert "3 not approved" in said


async def test_a_case_named_other_than_certivitys_id_is_named_in_the_run(store, settings) -> None:
    # case_id is the case's name in the app; a wrong one is scored against nothing.
    seed_library(store)
    await store.replace_certivity_reference(
        [{"kind": "expected", "case_id": "dev-rear-lamp", "content": {}, "certivity_commit": "x"}]
    )
    case_id = store.add_parsed_case("Rear lamp RPL-2", "A red rear position lamp.")
    run_id = store.add_run(TASK, case_id=case_id)
    await advance(store, settings, run_id)
    store.decide(run_id, "approved")
    await advance(store, settings, run_id)

    said = " ".join(p["text"] for p in store.payloads(run_id, "text"))
    assert "case_id 'Rear lamp RPL-2' has no answer key (those with one: dev-rear-lamp)" in said


async def test_a_regulation_that_does_not_speak_about_the_product_is_not_read(
    store, settings
) -> None:
    store.add_version("UN R43", "01", [("5.1", "5.1. Safety glazing shall not shatter.", 3)])
    run_id = case_run(store)

    await advance(store, settings, run_id)

    assert "UN R43" not in {r.regulation for r in await store.run_requirements(run_id)}


async def test_a_project_that_chose_its_regulations_reads_only_those(store, settings) -> None:
    run_id = case_run(store)
    case_id = store.runs[run_id].case_id
    assert case_id is not None
    store.case_choice[case_id] = {"UN R48"}

    await advance(store, settings, run_id)

    assert {r.regulation for r in await store.run_requirements(run_id)} == {"UN R48"}


async def test_sub_agents_do_not_spend_the_runs_request_limit(store, settings) -> None:
    # list, search, write, check, reject, export, then submit: 7 orchestrator requests. The 3
    # writers and the check call would make it 11 if they counted.
    settings.max_model_requests = 7
    run_id = case_run(store)
    await advance(store, settings, run_id)
    store.decide(run_id, "approved")

    assert await advance(store, settings, run_id) == "succeeded"
    assert store.usage[run_id]["requests"] == 7


async def test_an_empty_library_ends_with_an_empty_file_and_no_approval(store, settings) -> None:
    case_id = store.add_parsed_case("dev-rear-lamp", "A lamp.")
    run_id = store.add_run(QUIET, case_id=case_id)

    assert await advance(store, settings, run_id) == "succeeded"

    assert store.approvals == []
    assert submitted(store, run_id)["requirements"] == []


async def test_a_run_without_a_case_fails_saying_so(store, settings) -> None:
    seed_library(store)
    run_id = store.add_run(TASK)

    assert await advance(store, settings, run_id) == "failed"

    assert "no case" in (store.errors[run_id] or "")
    assert store.requirements == []


async def test_a_run_cannot_resume_while_an_approval_is_pending(store, settings) -> None:
    run_id = case_run(store)
    await advance(store, settings, run_id)

    with pytest.raises(runner.CannotAdvance, match="1 approval"):
        await runner.prepare(store, settings, run_id)
    assert store.runs[run_id].status == "awaiting_approval"


async def test_a_run_is_claimed_once(store, settings) -> None:
    run_id = store.add_run(QUIET)
    await runner.prepare(store, settings, run_id)

    with pytest.raises(runner.CannotAdvance, match="already running"):
        await runner.prepare(store, settings, run_id)


async def test_a_finished_run_cannot_be_advanced(store, settings) -> None:
    run_id = store.add_run(QUIET)
    await advance(store, settings, run_id)

    with pytest.raises(runner.CannotAdvance, match="already succeeded"):
        await runner.prepare(store, settings, run_id)


async def test_an_unknown_run_is_not_found(store, settings) -> None:
    from uuid import uuid4

    with pytest.raises(runner.RunNotFound):
        await runner.prepare(store, settings, uuid4())


async def test_a_run_with_a_dead_heartbeat_is_failed_not_rerun(store, settings) -> None:
    run_id = case_run(store)
    store.runs[run_id] = store.runs[run_id].model_copy(
        update={
            "status": "running",
            "updated_at": datetime.now(UTC) - timedelta(seconds=settings.stale_after_s + 5),
        }
    )

    with pytest.raises(runner.CannotAdvance, match="stopped without finishing"):
        await runner.prepare(store, settings, run_id)

    assert store.runs[run_id].status == "failed"
    assert store.payloads(run_id, "tool_call") == []


async def test_a_run_that_exceeds_its_time_is_recorded_as_failed(store, settings) -> None:
    run_id = case_run(store)
    settings.run_timeout_s = 0

    assert await advance(store, settings, run_id) == "failed"

    assert "Ran out of time" in (store.errors[run_id] or "")
    assert store.kinds(run_id)[-2:] == ["error", "status"]


async def test_a_loop_that_does_not_converge_stops_at_the_request_limit(store, settings) -> None:
    run_id = case_run(store)
    settings.max_model_requests = 2

    assert await advance(store, settings, run_id) == "failed"

    assert "usage limit" in (store.errors[run_id] or "")


async def test_a_run_failed_as_stale_is_not_overwritten_when_its_old_request_finishes(
    store, settings
) -> None:
    # The old request is still working when a Retry, seeing no heartbeat, marks the run failed.
    run_id = store.add_run(QUIET)
    plan = await runner.prepare(store, settings, run_id)
    await store.set_status(run_id, "failed", only_if="running", error="stale")

    assert await runner.execute(store, settings, plan) == "failed"

    assert store.runs[run_id].status == "failed"
    assert store.errors[run_id] == "stale"
    assert "succeeded" not in [p["status"] for p in store.payloads(run_id, "status")]


async def test_a_paused_run_whose_saved_conversation_no_longer_reads_is_failed(
    store, settings
) -> None:
    run_id = case_run(store)
    await advance(store, settings, run_id)
    store.decide(run_id, "approved")
    store.conversations[run_id] = {"messages": [{"kind": "from-a-future-version"}]}

    with pytest.raises(runner.CannotAdvance, match="incompatible version"):
        await runner.prepare(store, settings, run_id)

    assert store.runs[run_id].status == "failed"


async def test_the_run_keeps_its_heartbeat_without_the_http_response(store, settings) -> None:
    touched: list[object] = []
    original = store.touch

    async def counting_touch(run_id):
        touched.append(run_id)
        await original(run_id)

    store.touch = counting_touch  # type: ignore[method-assign]
    settings.heartbeat_s = 0.001
    run_id = case_run(store)

    await advance(store, settings, run_id)

    assert touched, "execute() should beat on its own"


async def test_case_files_reach_the_model_and_each_one_is_in_the_trace(store, settings) -> None:
    run_id = store.add_run(QUIET)
    store.attach(run_id, "spec.md", "md", b"# Rear lamp\nVehicle category M1.")
    store.attach(run_id, "notes.doc", "doc", b"legacy")

    await advance(store, settings, run_id)

    spec, legacy = store.payloads(run_id, "case_file")
    assert spec["filename"] == "spec.md" and spec["characters"] > 0 and spec["error"] is None
    assert "no reader" in legacy["error"]
    # The trace says what was read before the model's first word.
    assert store.kinds(run_id)[1:3] == ["case_file", "case_file"]
    saved = str(store.conversations[run_id])
    assert "Vehicle category M1." in saved
    assert "## Case file: spec.md (md)" in saved


async def test_a_run_without_files_starts_from_the_task_alone(store, settings) -> None:
    run_id = store.add_run(QUIET)

    await advance(store, settings, run_id)

    assert store.payloads(run_id, "case_file") == []


async def test_case_files_reach_the_model_in_the_order_they_were_added(store, settings) -> None:
    run_id = store.add_run(QUIET)
    for n in range(1, 12):
        store.attach(run_id, f"part{n}.md", "md", f"Part {n}.".encode())

    await advance(store, settings, run_id)

    names = [p["filename"] for p in store.payloads(run_id, "case_file")]
    assert names == [f"part{n}.md" for n in range(1, 12)]


async def test_a_file_that_changed_since_upload_is_read_and_flagged(store, settings) -> None:
    run_id = store.add_run(QUIET)
    store.attach(run_id, "spec.md", "md", b"M1", sha256=hashlib.sha256(b"M2").hexdigest())
    store.attach(run_id, "same.md", "md", b"M1", sha256=hashlib.sha256(b"M1").hexdigest())

    await advance(store, settings, run_id)

    changed, same = store.payloads(run_id, "case_file")
    assert changed["characters"] == 2 and any("differs" in n for n in changed["notes"])
    assert not any("differs" in n for n in same["notes"])
