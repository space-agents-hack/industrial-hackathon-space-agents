"""Questions about one run's results, asked from the run page (#28, SYS-39): "why did you add
R-012?", "is the obligation on X captured?".

The model gets what the run left in the database (its requirements with their citations and
check findings, its status, a digest of its trace) and two read-only tools over the organisation's
regulation library: the search the orchestrator uses, and the full text of one paragraph. It is
the run's own model with the organisation's key, so an organisation that runs on its own Ollama
server (SYS-30) does not send its run to a hosted model by asking about it.

Stateless: the browser keeps the conversation and sends it with every question. Nothing is
written but the answer's usage: one `model_usage` row per answer, as process `chat` (its search
vectors as `search`), against the run (SYS-40, IF-7). That is what Admin, Usage shows and the
monthly cap adds up. One answer reads the whole requirement list, about 20-40k tokens on the dev
case (an estimate from the list's size, not measured).

What this does NOT do: stop an answer that crosses the cap. The cap is checked before answering,
so an organisation over it gets no more answers, but the answer that takes it over is finished.
"""

import asyncio
import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Literal
from uuid import UUID

import httpx
from pydantic import BaseModel, Field
from pydantic_ai import Agent, FunctionToolset, RunContext, UsageLimits
from pydantic_ai.messages import ModelMessage, ModelRequest, ModelResponse, TextPart, UserPromptPart

from agent_service import providers
from agent_service.domain import regulation_search
from agent_service.metering import Credential, Meter, metered
from agent_service.records import LibraryVersion, Requirement, Run, RunEvent, RunOutcome
from agent_service.settings import Settings, effective
from agent_service.store import RunStore

# A conversation longer than this is cut to its last turns: the run's context is sent with every
# question, so old turns add cost and little else.
MAX_TURNS = 24
MAX_MESSAGE_CHARS = 4000
# Model requests per answer: one to read, a few tool calls, one to answer.
_REQUEST_LIMIT = 8
# What goes into the instructions, in characters (about 4 per token). The requirements are what
# questions are about, so they get most of it; 120,000 characters is about 400 requirements.
_REQUIREMENTS_CHARS = 120_000
_TRACE_CHARS = 30_000
_OUTPUT_CHARS = 20_000
_TEXT_EVENT_CHARS = 1500
_ARGS_CHARS = 300
_PARAGRAPH_CHARS = 6000


class Turn(BaseModel):
    role: Literal["user", "assistant"]
    content: str = Field(min_length=1, max_length=MAX_MESSAGE_CHARS)


class ChatRefused(Exception):
    """The question cannot be answered now; the message says why, for the person."""

    def __init__(self, message: str, status: int) -> None:
        super().__init__(message)
        self.status = status


@dataclass
class ChatDeps:
    store: RunStore
    run: Run
    settings: Settings
    library: list[LibraryVersion] | None = None
    searches: list[str] = field(default_factory=list[str])
    # The answer's usage; the query vectors of its searches go here too.
    meter: Meter | None = None


@dataclass(frozen=True)
class Answer:
    text: str
    model: str
    usage: dict[str, Any]


toolset = FunctionToolset[ChatDeps]()


async def _library(deps: ChatDeps) -> list[LibraryVersion]:
    if deps.library is None:
        deps.library = await deps.store.library_versions(deps.run.organization_id)
    return deps.library


@toolset.tool
async def search_regulations(
    ctx: RunContext[ChatDeps], query: str, limit: int = 10
) -> list[dict[str, Any]]:
    """Search the paragraphs of the regulations this run's project uses (base versions, the ones
    a requirement cites), best match first. Use it to find the paragraph that states an
    obligation the engineer asks about, then compare its citation with the requirements' ones.

    Args:
        query: What to find, in words ("rear position lamp luminous intensity").
        limit: How many paragraphs to return, at most 20.
    """
    deps = ctx.deps
    deps.searches.append(query)
    base = [v.id for v in await _library(deps) if v.role == "base"]
    if not base:
        return []
    k = max(1, min(limit, 20))
    store = deps.store.search_store()
    args: dict[str, Any] = {
        "version_ids": base,
        "k": k,
        "case_id": deps.run.case_id,
        "meter": deps.meter,
    }
    async with httpx.AsyncClient(timeout=30) as http:
        try:
            hits = await regulation_search.search(
                store, http, deps.settings, deps.run.organization_id, query, **args
            )
        except (regulation_search.EmbeddingError, ValueError):
            # No embedding key or model: words alone, as the orchestrator does.
            hits = await regulation_search.search(
                store, http, deps.settings, deps.run.organization_id, query, mode="text", **args
            )
    return [
        {
            "regulation": h.regulation_code,
            "version": h.version_label,
            "paragraph": h.label,
            "page": h.page_start,
            "heading": (h.heading or "")[-160:],
            "text": h.text[:400],
        }
        for h in hits
    ]


@toolset.tool
async def read_paragraph(
    ctx: RunContext[ChatDeps], regulation: str, paragraph: str, version: str | None = None
) -> dict[str, Any]:
    """The full text of one paragraph of the library, with its sub-paragraphs (5.4.2 also returns
    5.4.2.1, 5.4.2.2): what a requirement cites, to quote its obligation.

    Args:
        regulation: As a requirement cites it ("UN R148").
        paragraph: The paragraph label ("5.4.2").
        version: The version label ("00"). Without it, the base version.
    """
    wanted = regulation.strip().casefold()
    versions = [v for v in await _library(ctx.deps) if v.regulation.casefold() == wanted]
    if version is not None:
        versions = [v for v in versions if v.version_label == version.strip()]
    else:
        versions = sorted(versions, key=lambda v: v.role != "base")
    if not versions:
        return {"error": f"No {regulation} {version or ''} in the library.".replace("  ", " ")}
    chosen = versions[0]
    label = paragraph.strip().rstrip(".")
    found = [
        p
        for p in await ctx.deps.store.version_paragraphs(chosen.id)
        if p.label and (p.label.rstrip(".") == label or p.label.startswith(f"{label}."))
    ]
    if not found:
        return {"error": f"{chosen.regulation} {chosen.version_label} has no paragraph {label}."}
    text = "\n".join(p.text for p in found)
    return {
        "regulation": chosen.regulation,
        "version": chosen.version_label,
        "paragraph": label,
        "pages": sorted({p.page_start for p in found}),
        "heading": found[0].heading[-160:],
        "text": text[:_PARAGRAPH_CHARS],
        "truncated": len(text) > _PARAGRAPH_CHARS,
    }


chat_agent = Agent(
    name="run-chat",
    deps_type=ChatDeps,
    output_type=str,
    instructions=(Path(__file__).parent / "run_chat.md").read_text(),
    toolsets=[toolset],
)


def _clip(text: str, limit: int) -> str:
    return text if len(text) <= limit else f"{text[:limit]}… [cut]"


def requirement_lines(rows: list[Requirement]) -> str:
    lines: list[str] = []
    used = 0
    for i, r in enumerate(rows):
        line = (
            f"- {r.ext_id} [{r.status}] {r.regulation} {r.version_label}, "
            f"paragraph {r.paragraph or '(no label)'}, page {r.page}: {r.text}"
        )
        if r.test_case:
            line += f"\n  Test: {r.test_case}"
        for f in r.findings:
            line += f"\n  Check: {_clip(json.dumps(f, ensure_ascii=False), 400)}"
        if used + len(line) > _REQUIREMENTS_CHARS:
            rest = [x.ext_id for x in rows[i:]]
            lines.append(
                f"- ({len(rest)} more not shown, too long to include: {', '.join(rest)}. Say "
                "so if a question is about one of them.)"
            )
            break
        lines.append(line)
        used += len(line)
    return "\n".join(lines)


def trace_digest(events: list[RunEvent]) -> str:
    """What the agent said and did, in order. Tool results are left out except for errors and
    the case files' reports: they are long, and the requirements they produced are listed
    above."""
    lines: list[str] = []
    for e in events:
        p = e.payload
        match e.kind:
            case "text":
                lines.append(f"Agent: {_clip(str(p.get('text', '')), _TEXT_EVENT_CHARS)}")
            case "tool_call":
                args = _clip(json.dumps(p.get("args", {}), ensure_ascii=False), _ARGS_CHARS)
                lines.append(f"Tool call: {p.get('tool_name')} {args}")
            case "tool_result" if p.get("is_error"):
                result = _clip(json.dumps(p.get("result"), ensure_ascii=False), _ARGS_CHARS)
                lines.append(f"Tool error: {p.get('tool_name')} {result}")
            case "case_file":
                lines.append(f"Case file: {_clip(json.dumps(p, ensure_ascii=False), 400)}")
            case "approval_resolved":
                lines.append(
                    f"Approval: {p.get('tool_name')} {p.get('decision')} {p.get('note') or ''}"
                )
            case "error":
                lines.append(f"Error: {_clip(str(p.get('message', '')), _TEXT_EVENT_CHARS)}")
            case _:
                pass
    text = "\n".join(lines)
    if len(text) <= _TRACE_CHARS:
        return text
    # The start says which regulations were chosen and why, the end how the run finished.
    half = _TRACE_CHARS // 2
    return f"{text[:half]}\n… [middle of the trace cut] …\n{text[-half:]}"


def run_context(
    run: Run,
    outcome: RunOutcome,
    case_name: str | None,
    rows: list[Requirement],
    events: list[RunEvent],
) -> str:
    parts = [
        "# The run",
        f"Status: {run.status}",
        f"Case: {case_name or '(none)'}",
        f"Model: {outcome.model or '(not started)'}",
        f"Task:\n{_clip(run.task, 4000)}",
    ]
    if outcome.error:
        parts.append(f"Error: {_clip(outcome.error, 2000)}")
    counts = {s: sum(r.status == s for r in rows) for s in ("draft", "approved", "rejected")}
    parts.append(
        f"# Requirements ({len(rows)}: {counts['approved']} approved, {counts['draft']} draft, "
        f"{counts['rejected']} rejected)"
    )
    parts.append(requirement_lines(rows) if rows else "This run wrote no requirements.")
    if not rows and outcome.output:
        parts.append(f"# Output\n{_clip(outcome.output, _OUTPUT_CHARS)}")
    parts.append(f"# Trace\n{trace_digest(events) or 'No events.'}")
    return "\n\n".join(parts)


def history(turns: list[Turn]) -> list[ModelMessage]:
    messages: list[ModelMessage] = []
    for t in turns:
        if t.role == "user":
            messages.append(ModelRequest(parts=[UserPromptPart(t.content)]))
        else:
            messages.append(ModelResponse(parts=[TextPart(t.content)]))
    return messages


async def _over_cap(store: RunStore, settings: Settings, org: UUID) -> str | None:
    # The same rule as a new run's (runner._over_cap): a question is new spending.
    cap = effective(settings, await store.organization_settings(org)).monthly_cost_cap_usd
    if cap is None:
        return None
    spent = await store.month_cost(org)
    if spent < cap:
        return None
    return (
        f"This organisation has reached its monthly cap of ${cap:,.2f} (${spent:,.2f} spent this "
        "month). An admin can raise it in Admin, Models and limits."
    )


async def answer(store: RunStore, settings: Settings, run_id: UUID, turns: list[Turn]) -> Answer:
    """The model's answer to the last turn, which is the person's question."""
    if not turns or turns[-1].role != "user":
        raise ChatRefused("The last message must be the question.", 422)
    run = await store.get_run(run_id)
    outcome = await store.run_outcome(run_id)
    if run is None or outcome is None:
        raise ChatRefused("No such run.", 404)
    if (refusal := await _over_cap(store, settings, run.organization_id)) is not None:
        raise ChatRefused(refusal, 409)

    name = (
        outcome.model
        or run.requested_model
        or effective(settings, await store.organization_settings(run.organization_id)).model
    )
    rows = await store.run_requirements(run_id)
    events = await store.run_events(run_id)
    case_name = await store.case_name(run.case_id) if run.case_id else None
    context = run_context(run, outcome, case_name, rows, events)

    key, endpoint = await providers.credentials(store, run.organization_id, name)
    meter = Meter(run.organization_id, run_id=run.id, case_id=run.case_id)
    credential = Credential.for_model(name, key, endpoint.root() if endpoint else None)
    model = metered(providers.build_model(name, key, endpoint), meter, "chat", name, credential)
    turns = turns[-MAX_TURNS:]
    try:
        async with asyncio.timeout(settings.chat_timeout_s):
            result = await chat_agent.run(
                turns[-1].content,
                message_history=history(turns[:-1]),
                instructions=context,
                model=model,
                deps=ChatDeps(store=store, run=run, settings=settings, meter=meter),
                usage_limits=UsageLimits(request_limit=_REQUEST_LIMIT),
            )
    except TimeoutError:
        raise ChatRefused(
            f"The model did not answer within {settings.chat_timeout_s:.0f} s. Ask again.", 504
        ) from None
    except Exception as exc:
        # The provider's message is shown to the person; it must not carry the key.
        message = providers.scrub(f"{type(exc).__name__}: {exc}", key)[:500]
        raise ChatRefused(f"The model did not answer: {message}", 502) from None
    finally:
        # Also when the answer timed out or failed: what was sent was billed.
        await meter.flush(store)
    usage = result.usage
    return Answer(
        text=result.output,
        model=name,
        usage={
            "input_tokens": usage.input_tokens,
            "output_tokens": usage.output_tokens,
            "requests": usage.requests,
            "cost_usd": float(usage.cost) if usage.cost is not None else None,
        },
    )
