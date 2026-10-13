"""The loop end to end with the scripted model: start, pause for approval, resume."""

from datetime import UTC, datetime, timedelta

import pytest

from agent_service import runner
from agent_service.settings import Settings
from tests.fakes import InMemoryRunStore

pytestmark = pytest.mark.anyio

COLLIDING = "Triage ECN-1001 and put it on hold if anything collides."
HARMLESS = "Triage ECN-1002."


async def advance(store: InMemoryRunStore, settings: Settings, run_id) -> str:
    plan = await runner.prepare(store, settings, run_id)
    return await runner.execute(store, settings, plan)


async def test_a_risky_step_pauses_the_run_before_it_executes(store, settings) -> None:
    run_id = store.add_run(COLLIDING)

    assert await advance(store, settings, run_id) == "awaiting_approval"

    [approval] = store.approvals
    assert approval.tool_name == "plm_set_ecn_status"
    assert approval.args["ecn_id"] == "ECN-1001"
    assert approval.args["status"] == "hold"
    assert "ASM-310" in approval.args["reason"]
    # The write was requested, not performed: no result for it yet.
    results = [p["tool_name"] for p in store.payloads(run_id, "tool_result")]
    assert "plm_set_ecn_status" not in results
    assert results.count("cad_check_fit") == 2
    assert store.kinds(run_id)[0] == "status"
    assert store.kinds(run_id)[-2:] == ["approval_requested", "status"]
    assert store.models[run_id] == "scripted"
    assert store.usage[run_id]["requests"] == 4


async def test_an_approved_step_runs_once_and_the_run_finishes(store, settings) -> None:
    run_id = store.add_run(COLLIDING)
    await advance(store, settings, run_id)
    store.decide(run_id, "approved")

    assert await advance(store, settings, run_id) == "succeeded"

    assert "now on hold" in (store.outputs[run_id] or "")
    [resolved] = store.payloads(run_id, "approval_resolved")
    assert resolved["decision"] == "approved"
    status_calls = [
        p for p in store.payloads(run_id, "tool_call") if p["tool_name"] == "plm_set_ecn_status"
    ]
    status_results = [
        p for p in store.payloads(run_id, "tool_result") if p["tool_name"] == "plm_set_ecn_status"
    ]
    # One call in the log although the library announces it before the pause and after it.
    assert len(status_calls) == 1
    assert len(status_results) == 1
    assert status_results[0]["result"]["status"] == "hold"
    assert status_results[0]["is_error"] is False
    # Usage carries across the pause instead of restarting at zero.
    assert store.usage[run_id]["requests"] == 5


async def test_a_denied_step_never_runs_and_the_agent_reports_it(store, settings) -> None:
    run_id = store.add_run(COLLIDING)
    await advance(store, settings, run_id)
    store.decide(run_id, "denied", note="Wait for the redesign review on Friday.")

    assert await advance(store, settings, run_id) == "succeeded"

    assert "Wait for the redesign review on Friday." in (store.outputs[run_id] or "")
    assert "unchanged" in (store.outputs[run_id] or "")
    results = [p["tool_name"] for p in store.payloads(run_id, "tool_result")]
    assert "plm_set_ecn_status" not in results


async def test_a_task_with_no_risky_step_runs_straight_through(store, settings) -> None:
    run_id = store.add_run(HARMLESS)

    assert await advance(store, settings, run_id) == "succeeded"

    assert store.approvals == []
    assert "did not change the status" in (store.outputs[run_id] or "")


async def test_a_run_cannot_resume_while_an_approval_is_pending(store, settings) -> None:
    run_id = store.add_run(COLLIDING)
    await advance(store, settings, run_id)

    with pytest.raises(runner.CannotAdvance, match="1 approval"):
        await runner.prepare(store, settings, run_id)
    assert store.runs[run_id].status == "awaiting_approval"


async def test_a_run_is_claimed_once(store, settings) -> None:
    run_id = store.add_run(HARMLESS)
    await runner.prepare(store, settings, run_id)

    with pytest.raises(runner.CannotAdvance, match="already running"):
        await runner.prepare(store, settings, run_id)


async def test_a_finished_run_cannot_be_advanced(store, settings) -> None:
    run_id = store.add_run(HARMLESS)
    await advance(store, settings, run_id)

    with pytest.raises(runner.CannotAdvance, match="already succeeded"):
        await runner.prepare(store, settings, run_id)


async def test_an_unknown_run_is_not_found(store, settings) -> None:
    from uuid import uuid4

    with pytest.raises(runner.RunNotFound):
        await runner.prepare(store, settings, uuid4())


async def test_a_run_with_a_dead_heartbeat_is_failed_not_rerun(store, settings) -> None:
    run_id = store.add_run(COLLIDING, status="running")
    store.runs[run_id] = store.runs[run_id].model_copy(
        update={"updated_at": datetime.now(UTC) - timedelta(seconds=settings.stale_after_s + 5)}
    )

    with pytest.raises(runner.CannotAdvance, match="stopped without finishing"):
        await runner.prepare(store, settings, run_id)

    assert store.runs[run_id].status == "failed"
    assert store.payloads(run_id, "tool_call") == []


async def test_a_run_that_exceeds_its_time_is_recorded_as_failed(store, settings) -> None:
    run_id = store.add_run(COLLIDING)
    settings.run_timeout_s = 0

    assert await advance(store, settings, run_id) == "failed"

    assert "Ran out of time" in (store.errors[run_id] or "")
    assert store.kinds(run_id)[-2:] == ["error", "status"]


async def test_a_loop_that_does_not_converge_stops_at_the_request_limit(store, settings) -> None:
    run_id = store.add_run(COLLIDING)
    settings.max_model_requests = 2

    assert await advance(store, settings, run_id) == "failed"

    assert "usage limit" in (store.errors[run_id] or "")


async def test_an_unknown_record_fails_the_run_instead_of_inventing_an_answer(
    store, settings
) -> None:
    run_id = store.add_run("Triage ECN-4040.")

    assert await advance(store, settings, run_id) == "failed"

    assert store.outputs[run_id] is None
    assert any(p["is_error"] for p in store.payloads(run_id, "tool_result"))
