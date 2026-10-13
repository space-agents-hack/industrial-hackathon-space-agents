"""Advance one run as far as it can go in a single request: to the end, or to the next point
where a person has to approve something.

Two halves, split so the HTTP layer can refuse a request with a proper status code before it
starts streaming:

  prepare()  checks the run can advance and claims it. Raises RunNotFound or CannotAdvance.
  execute()  runs the agent and records everything. Never raises; a failure is a run status.

What this does NOT do: re-run anything after a crash. A run whose function died stays "running"
until its heartbeat goes stale, and is then marked failed. Resuming it automatically could execute
an already-approved write a second time, and only the domain knows whether that is safe.
"""

import asyncio
import json
import logging
from collections.abc import AsyncIterable
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any
from uuid import UUID

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
from pydantic_ai.usage import RunUsage
from pydantic_core import to_jsonable_python

from agent_service import domain
from agent_service.records import Approval, ApprovalRequest, Run, RunStatus
from agent_service.settings import Settings
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
    # None when starting; the saved conversation and the decisions when resuming.
    conversation: Conversation | None = None
    decisions: list[Approval] | None = None


async def prepare(store: RunStore, settings: Settings, run_id: UUID) -> Plan:
    run = await store.get_run(run_id)
    if run is None:
        raise RunNotFound(str(run_id))

    if run.status == "queued":
        if not await store.claim(run_id, "queued", settings.agent_model):
            raise CannotAdvance("Another request started this run first.")
        return Plan(run)

    if run.status == "awaiting_approval":
        approvals = await store.list_approvals(run_id)
        pending = [a for a in approvals if a.status == "pending"]
        if pending:
            raise CannotAdvance(f"{len(pending)} approval(s) still pending.")
        saved = await store.load_conversation(run_id)
        if saved is None:
            raise CannotAdvance("The run is paused but has no saved conversation to resume from.")
        conversation = ConversationTypeAdapter.validate_python(saved)
        if not await store.claim(run_id, "awaiting_approval", settings.agent_model):
            raise CannotAdvance("Another request resumed this run first.")
        return Plan(run, conversation, approvals)

    if run.status == "running":
        idle = (datetime.now(UTC) - run.updated_at).total_seconds()
        if idle <= settings.stale_after_s:
            raise CannotAdvance("The run is already running.")
        message = (
            f"The agent stopped without finishing (no heartbeat for {idle:.0f} s). "
            "Nothing was re-run. Start a new run."
        )
        await _fail(store, run_id, message)
        raise CannotAdvance(message)

    raise CannotAdvance(f"The run is already {run.status}.")


async def execute(store: RunStore, settings: Settings, plan: Plan) -> RunStatus:
    run_id = plan.run.id
    try:
        await store.add_event(run_id, "status", {"status": "running"})
        async with asyncio.timeout(settings.run_timeout_s):
            return await _run_agent(store, settings, plan)
    except TimeoutError:
        return await _fail(
            store, run_id, f"Ran out of time (limit {settings.run_timeout_s:.0f} s)."
        )
    except UsageLimitExceeded as exc:
        return await _fail(store, run_id, f"Stopped at a usage limit: {exc}")
    except Exception as exc:
        log.exception("run %s failed", run_id)
        return await _fail(store, run_id, f"{type(exc).__name__}: {exc}"[:2000])


async def _run_agent(store: RunStore, settings: Settings, plan: Plan) -> RunStatus:
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

    result = await domain.agent.run(
        None if plan.conversation is not None else plan.run.task,
        conversation=plan.conversation,
        deferred_tool_results=deferred_results,
        model=domain.resolve_model(settings.agent_model),
        deps=domain.new_deps(),
        usage_limits=UsageLimits(request_limit=settings.max_model_requests),
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
    await store.set_status(run_id, status, output=output, usage=usage)
    await store.add_event(run_id, "status", {"status": status})
    return status


async def _fail(store: RunStore, run_id: UUID, message: str) -> RunStatus:
    # If recording the failure fails too (database unreachable), there is nowhere left to write
    # it; the log line is the last trace.
    try:
        await store.set_status(run_id, "failed", error=message)
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


def _clip(value: Any) -> Any:
    plain = to_jsonable_python(value, fallback=str)
    text = json.dumps(plain, ensure_ascii=False)
    if len(text) <= _MAX_EVENT_RESULT_CHARS:
        return plain
    return {"truncated": True, "preview": text[:_MAX_EVENT_RESULT_CHARS]}
