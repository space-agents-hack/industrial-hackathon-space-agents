"""Advance one run as far as it can go in a single request: to the end, or to the next point
where a person has to approve something.

Two halves, split so the HTTP layer can refuse a request with a proper status code before it
starts streaming:

  prepare()  checks the run can advance and claims it. Raises RunNotFound or CannotAdvance.
  execute()  runs the agent and records everything. Never raises; a failure is a run status.

Which model, which key and which limits a run uses come from its organisation (organization_settings
and provider_connections), falling back to this service's environment for anything it did not set.

What this does NOT do: re-run anything after a crash. A run whose function died stays "running"
until its heartbeat goes stale, and is then marked failed. Resuming it automatically could execute
an already-approved write a second time, and only the domain knows whether that is safe.
"""

import asyncio
import contextlib
import hashlib
import json
import logging
import sys
import traceback
from collections.abc import AsyncIterable
from dataclasses import dataclass, replace
from datetime import UTC, datetime
from typing import Any
from uuid import UUID

from pydantic import ValidationError
from pydantic_ai import (
    AgentStreamEvent,
    Conversation,
    ConversationTypeAdapter,
    DeferredToolRequests,
    DeferredToolResults,
    FunctionToolCallEvent,
    FunctionToolResultEvent,
    PartEndEvent,
    RunContext,
    TextPart,
    ToolDenied,
    ToolReturnPart,
    UsageLimitExceeded,
    UsageLimits,
)
from pydantic_ai.models import Model
from pydantic_ai.usage import RunUsage
from pydantic_core import to_jsonable_python

from agent_service import domain
from agent_service.domain import case_ingest, ingest, subgoal, subgoal_review
from agent_service.metering import Credential, Meter, metered
from agent_service.providers import build_model, credentials, scrub
from agent_service.records import Approval, ApprovalRequest, Run, RunFile, RunStatus
from agent_service.settings import RunSettings, Settings, effective
from agent_service.store import RunStore

log = logging.getLogger(__name__)

# A tool result is copied into the event log for people to read. The model's own copy lives in
# the saved conversation, so clipping here loses nothing the agent needs.
_MAX_EVENT_RESULT_CHARS = 8000


class RunNotFound(Exception):
    pass


class CannotAdvance(Exception):
    """The run exists but is not in a state this request can move forward."""


@dataclass
class Plan:
    run: Run
    config: RunSettings
    # None when starting; the saved conversation and the decisions when resuming.
    conversation: Conversation | None = None
    decisions: list[Approval] | None = None


async def prepare(store: RunStore, settings: Settings, run_id: UUID) -> Plan:
    run = await store.get_run(run_id)
    if run is None:
        raise RunNotFound(str(run_id))

    if run.status == "queued":
        config = await _config(store, settings, run)
        if (refusal := await _over_cap(store, run, config)) is not None:
            await _fail(store, run_id, refusal, expected="queued")
            raise CannotAdvance(refusal)
        if not await store.claim(run_id, "queued", config.model):
            raise CannotAdvance("Another request started this run first.")
        return Plan(run, config)

    if run.status == "awaiting_approval":
        approvals = await store.list_approvals(run_id)
        pending = [a for a in approvals if a.status == "pending"]
        if pending:
            raise CannotAdvance(f"{len(pending)} approval(s) still pending.")
        saved = await store.load_conversation(run_id)
        if saved is None:
            raise CannotAdvance("The run is paused but has no saved conversation to resume from.")
        try:
            conversation = ConversationTypeAdapter.validate_python(saved)
        except ValidationError:
            # The library releases about weekly. A run paused under an older version whose saved
            # shape no longer reads would otherwise fail every retry with a 500 and never leave
            # "awaiting approval".
            message = (
                "The saved conversation was written by an incompatible version of the agent. "
                "Start a new run."
            )
            await _fail(store, run_id, message, expected="awaiting_approval")
            raise CannotAdvance(message) from None
        # No cap check here, on purpose: a person has already approved the next step, and
        # stopping now would leave the approved write undone halfway through the task. A run
        # that started under the cap is allowed to finish past it.
        config = await _config(store, settings, run)
        if not await store.claim(run_id, "awaiting_approval", config.model):
            raise CannotAdvance("Another request resumed this run first.")
        return Plan(run, config, conversation, approvals)

    if run.status == "running":
        idle = (datetime.now(UTC) - run.updated_at).total_seconds()
        if idle <= settings.stale_after_s:
            raise CannotAdvance("The run is already running.")
        message = (
            f"The agent stopped without finishing (no heartbeat for {idle:.0f} s). "
            "Nothing was re-run. Start a new run."
        )
        await _fail(store, run_id, message, expected="running")
        raise CannotAdvance(message)

    raise CannotAdvance(f"The run is already {run.status}.")


async def _config(store: RunStore, settings: Settings, run: Run) -> RunSettings:
    config = effective(settings, await store.organization_settings(run.organization_id))
    # A model asked for on the case page, for this run only. Its key is still the organisation's,
    # looked up by its provider like any other; a model without a key fails the run with that
    # message, as the organisation's own model would.
    if run.requested_model:
        config = replace(config, model=run.requested_model)
    return config


async def _over_cap(store: RunStore, run: Run, config: RunSettings) -> str | None:
    """The reason to refuse a new run, or None.

    Checked once, when a run starts. Runs already working are not counted until they record
    their cost, so several started together can overshoot the cap by what they spend; the cap
    stops the next run, not the current one.
    """
    cap = config.monthly_cost_cap_usd
    if cap is None:
        return None
    spent = await store.month_cost(run.organization_id)
    if spent < cap:
        return None
    return (
        f"This organisation has reached its monthly cap of ${cap:,.2f} (${spent:,.2f} spent this "
        "month). An admin can raise it in Admin, Models and limits."
    )


async def execute(store: RunStore, settings: Settings, plan: Plan) -> RunStatus:
    run_id = plan.run.id
    # The heartbeat belongs to the run, not to the HTTP response: if the caller hangs up, the run
    # keeps working and must keep saying so, or a Retry would declare it dead while it writes.
    heartbeat = asyncio.create_task(_heartbeat(store, run_id, settings.heartbeat_s))
    try:
        return await _execute(store, settings, plan)
    finally:
        heartbeat.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await heartbeat


async def _heartbeat(store: RunStore, run_id: UUID, every_s: float) -> None:
    while True:
        await asyncio.sleep(every_s)
        # A missed beat is not a reason to stop the run.
        with contextlib.suppress(Exception):
            await store.touch(run_id)


async def _execute(store: RunStore, settings: Settings, plan: Plan) -> RunStatus:
    run_id = plan.run.id
    # Read here, inside the handler, so every message below can be scrubbed of it.
    key: str | None = None
    # Every model call of this segment (writer, check, search vectors), written when it ends
    # however it ends: a run that fails after an hour of writers spent that money too.
    meter = Meter(plan.run.organization_id, run_id=run_id, case_id=plan.run.case_id)
    try:
        await store.add_event(run_id, "status", {"status": "running"})
        name = plan.config.model
        case_id = plan.run.case_id
        if case_id is not None and await store.case_kind(case_id) == subgoal.KIND:
            # The reviewer is a check (SYS-29's kind of work): the organisation's check model if
            # it chose one in Admin, else SUBGOAL_REVIEW_MODEL; billed as checking either way.
            # The scripted model stays scripted, so tests and a key-less stage never call out.
            chosen = await store.organization_model(plan.run.organization_id, "check")
            if chosen:
                name = chosen
            elif name != "scripted":
                name = settings.subgoal_review_model
            key, endpoint = await credentials(store, plan.run.organization_id, name)
            credential = Credential.for_model(name, key, endpoint.root() if endpoint else None)
            model = metered(build_model(name, key, endpoint), meter, "check", name, credential)
            async with asyncio.timeout(settings.run_timeout_s):
                return await _run_subgoal(store, settings, plan, model)
        key, endpoint = await credentials(store, plan.run.organization_id, name)
        credential = Credential.for_model(name, key, endpoint.root() if endpoint else None)
        model = metered(build_model(name, key, endpoint), meter, "writer", name, credential)
        async with asyncio.timeout(settings.run_timeout_s):
            return await _run_agent(store, settings, plan, model, meter)
    except TimeoutError:
        return await _fail(
            store, run_id, f"Ran out of time (limit {settings.run_timeout_s:.0f} s)."
        )
    except UsageLimitExceeded as exc:
        return await _fail(store, run_id, scrub(f"Stopped at a usage limit: {exc}", key))
    except Exception as exc:
        # Not log.exception: the traceback carries the exception's message, which is exactly
        # what may quote the key.
        trace = "".join(traceback.format_exception(exc))
        log.error("run %s failed\n%s", run_id, scrub(trace, key))
        return await _fail(store, run_id, scrub(f"{type(exc).__name__}: {exc}", key)[:2000])
    finally:
        await meter.flush(store)


async def _run_subgoal(
    store: RunStore, settings: Settings, plan: Plan, model: Model | str
) -> RunStatus:
    """A sub-goal case's run (domain/subgoal.py): a fixed sequence of steps, not a model loop,
    so it never pauses and has no conversation to save."""
    run = plan.run
    team_id, case_name = await domain.submission_ids(store, run)
    loop = asyncio.get_running_loop()
    limits = subgoal_review.Limits(
        batch_size=settings.subgoal_review_batch,
        concurrency=settings.subgoal_review_concurrency,
        timeout_s=settings.subgoal_review_timeout_s,
        # No new reviewer batch past this, so the file is written before RUN_TIMEOUT_S: the rules'
        # answer for what was not reviewed is better than no file.
        deadline=loop.time() + settings.run_timeout_s - 30,
    )
    try:
        outcome = await subgoal.execute(
            store,
            run,
            team_id=team_id,
            case_name=case_name,
            reviewer=model if settings.subgoal_review else None,
            reviewer_note=None if settings.subgoal_review else "review is off (SUBGOAL_REVIEW)",
            review=limits,
            writer=model if settings.subgoal_write else None,
        )
    except subgoal.SubgoalRefused as exc:
        return await _fail(store, run.id, str(exc))
    return await _finish(
        store, run.id, "succeeded", output=outcome.output, usage=_usage(outcome.usage)
    )


async def _run_agent(
    store: RunStore, settings: Settings, plan: Plan, model: Model | str, meter: Meter
) -> RunStatus:
    run_id = plan.run.id
    resumed_call_ids: set[str] = set()
    deferred_results: DeferredToolResults | None = None

    if plan.conversation is not None:
        deferred_results, resumed_call_ids = await _apply_decisions(store, plan)

    async def record(
        _ctx: RunContext[domain.Deps], events: AsyncIterable[AgentStreamEvent]
    ) -> None:
        async for event in events:
            if isinstance(event, PartEndEvent) and isinstance(event.part, TextPart):
                if event.part.content.strip():
                    await store.add_event(run_id, "text", {"text": event.part.content})
            elif isinstance(event, FunctionToolCallEvent):
                # On resume the library announces the approved call again. It is already in the
                # log from before the pause.
                if event.part.tool_call_id in resumed_call_ids:
                    continue
                await store.add_event(
                    run_id,
                    "tool_call",
                    {
                        "tool_call_id": event.part.tool_call_id,
                        "tool_name": event.part.tool_name,
                        "args": event.part.args_as_dict(),
                    },
                )
            elif isinstance(event, FunctionToolResultEvent):
                part = event.part
                # A denied call never ran; the approval_resolved event already says so.
                if isinstance(part, ToolReturnPart) and part.outcome == "denied":
                    continue
                is_error = not isinstance(part, ToolReturnPart) or part.outcome != "success"
                await store.add_event(
                    run_id,
                    "tool_result",
                    {
                        "tool_call_id": part.tool_call_id,
                        "tool_name": part.tool_name,
                        "result": _clip(part.content),
                        "is_error": is_error,
                    },
                )

    # On resume the case files are already in the saved conversation; reading them again would
    # send them twice.
    prompt = None if plan.conversation is not None else await _first_message(store, plan.run)
    result = await domain.agent.run(
        prompt,
        conversation=plan.conversation,
        deferred_tool_results=deferred_results,
        model=model,
        deps=await domain.prepare_deps(store, plan.run, settings, meter),
        usage_limits=UsageLimits(request_limit=plan.config.max_model_requests),
        event_stream_handler=record,
    )

    # Saved at the end as well as at a pause: it is the full record of what the model saw.
    await store.save_conversation(
        run_id, ConversationTypeAdapter.dump_python(result.conversation, mode="json")
    )
    usage = _usage(result.usage)

    if isinstance(result.output, DeferredToolRequests):
        if result.output.calls:
            raise RuntimeError("Tools that run outside this service are not supported.")
        requests = [
            ApprovalRequest(
                tool_call_id=c.tool_call_id, tool_name=c.tool_name, args=c.args_as_dict()
            )
            for c in result.output.approvals
        ]
        for approval in await store.request_approvals(run_id, requests):
            await store.add_event(
                run_id,
                "approval_requested",
                {
                    "approval_id": str(approval.id),
                    "tool_call_id": approval.tool_call_id,
                    "tool_name": approval.tool_name,
                    "args": approval.args,
                },
            )
        return await _finish(store, run_id, "awaiting_approval", usage=usage)

    return await _finish(store, run_id, "succeeded", output=result.output, usage=usage)


async def _first_message(store: RunStore, run: Run) -> str | list[ingest.Part]:
    """The task alone, or the task followed by the run's case files (issue #8).

    One `case_file` event per file, written before the model sees anything, says what was read
    and what was not, so a person can tell from the trace whether the agent had the whole case.
    """
    if run.case_id is not None:
        # A case's files were parsed once, at upload (domain/case_ingest.py); read what is stored.
        content = await case_ingest.case_content(store, run.case_id)
        for report in content.reports:
            await store.add_event(run.id, "case_file", report.payload())
        if not content.reports:
            return run.task
        return ingest.first_message(run.task, content)

    rows = sorted(await store.run_files(run.id), key=_upload_position)
    if not rows:
        return run.task
    files: list[ingest.CaseFile] = []
    failed: list[ingest.FileReport] = []
    for row in rows:
        fmt = ingest.format_of(f"x.{row.format}")
        if fmt is None:
            failed.append(_unreadable(row, f"Format {row.format!r} has no reader in this agent."))
            continue
        try:
            data = await store.download(row.storage_path)
        except Exception as exc:
            failed.append(_unreadable(row, f"Download failed: {type(exc).__name__}: {exc}"[:500]))
            continue
        notes: tuple[str, ...] = ()
        if row.sha256 and hashlib.sha256(data).hexdigest() != row.sha256:
            notes = ("The stored file differs from the one the browser hashed at upload.",)
        files.append(ingest.CaseFile(row.filename, fmt, data, notes))
    # Parsing is CPU work; in a thread, the heartbeat keeps beating during a long PDF.
    content = await asyncio.to_thread(ingest.read_case, files)
    content.reports += failed
    for report in content.reports:
        await store.add_event(run.id, "case_file", report.payload())
    return ingest.first_message(run.task, content)


def _upload_position(row: RunFile) -> tuple[int, str]:
    """The web names each object `{n}-{name}` in the order the engineer added the files.

    The rows cannot say it: start_run() inserts them in one transaction, so `created_at` is the
    same for all and ordering by it falls back to the random id (found by the code review thread).
    """
    head, dash, _ = row.storage_path.rpartition("/")[2].partition("-")
    return (int(head) if dash and head.isdigit() else sys.maxsize, row.filename)


def _unreadable(row: RunFile, error: str) -> ingest.FileReport:
    return ingest.FileReport(row.filename, row.format, row.bytes, error=error)


async def _apply_decisions(store: RunStore, plan: Plan) -> tuple[DeferredToolResults, set[str]]:
    assert plan.conversation is not None
    requested = plan.conversation.deferred_tool_requests
    wanted = {c.tool_call_id for c in requested.approvals} if requested else set()
    decided = {a.tool_call_id: a for a in plan.decisions or [] if a.tool_call_id in wanted}
    missing = wanted - decided.keys()
    if missing:
        raise RuntimeError(f"No decision recorded for tool call(s) {sorted(missing)}.")

    results = DeferredToolResults()
    for call_id, approval in decided.items():
        await store.add_event(
            plan.run.id,
            "approval_resolved",
            {
                "tool_call_id": call_id,
                "tool_name": approval.tool_name,
                "decision": approval.status,
                "note": approval.note,
            },
        )
        results.approvals[call_id] = (
            True
            if approval.status == "approved"
            else ToolDenied(approval.note or "Denied by a reviewer.")
        )
    return results, set(decided)


async def _finish(
    store: RunStore,
    run_id: UUID,
    status: RunStatus,
    *,
    output: str | None = None,
    usage: dict[str, Any] | None = None,
) -> RunStatus:
    if not await store.set_status(run_id, status, only_if="running", output=output, usage=usage):
        log.warning("run %s was no longer running; not overwriting it with %s", run_id, status)
        return "failed"
    await store.add_event(run_id, "status", {"status": status})
    return status


async def _fail(
    store: RunStore, run_id: UUID, message: str, *, expected: RunStatus = "running"
) -> RunStatus:
    # If recording the failure fails too (database unreachable), there is nowhere left to write
    # it; the log line is the last trace.
    try:
        if await store.set_status(run_id, "failed", only_if=expected, error=message):
            await store.add_event(run_id, "error", {"message": message})
            await store.add_event(run_id, "status", {"status": "failed"})
    except Exception:
        log.exception("could not record failure of run %s: %s", run_id, message)
    return "failed"


def _usage(usage: RunUsage) -> dict[str, Any]:
    return {
        "input_tokens": usage.input_tokens,
        "output_tokens": usage.output_tokens,
        "requests": usage.requests,
        "tool_calls": usage.tool_calls,
        # A best-effort estimate from public price lists; None when the model is not priced.
        "cost_usd": float(usage.cost) if usage.cost is not None else None,
    }


# Tried in order until the result fits: (list items kept, characters kept per string). Strings
# shrink faster than lists, because a reader of the trace wants to see which items came back (every
# regulation `list_regulations` gave the agent) before the full text of any one of them.
_CLIP_STEPS = ((200, 2000), (200, 400), (100, 160), (60, 80), (30, 60), (10, 40))


def _clip(value: Any) -> Any:
    # Cutting the serialised text would leave a fragment of escaped JSON that the trace can only
    # show as one long string, so the value is shrunk in place and stays JSON a person can read.
    plain = to_jsonable_python(value, fallback=str)
    if _length(plain) <= _MAX_EVENT_RESULT_CHARS:
        return plain
    for items, chars in _CLIP_STEPS:
        clipped = _shrink(plain, items, chars)
        if _length(clipped) <= _MAX_EVENT_RESULT_CHARS:
            return clipped
    # Only a deeply nested result gets here; a plain cut keeps the event row small regardless.
    text = json.dumps(plain, ensure_ascii=False)
    return {"truncated": True, "preview": text[:_MAX_EVENT_RESULT_CHARS]}


def _length(value: Any) -> int:
    return len(json.dumps(value, ensure_ascii=False))


def _shrink(value: Any, items: int, chars: int) -> Any:
    if isinstance(value, str):
        return value if len(value) <= chars else f"{value[: chars - 1].rstrip()}…"
    if isinstance(value, list):
        kept: list[Any] = [_shrink(v, items, chars) for v in value[:items]]
        if len(value) > items:
            kept.append(f"… {len(value) - items} more not shown here ({len(value)} in all)")
        return kept
    if isinstance(value, dict):
        return {k: _shrink(v, items, chars) for k, v in value.items()}
    return value
