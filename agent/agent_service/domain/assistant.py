"""The assistant behind the bubble on every page of a project (SYS-39; #28, #31): questions about
the project's regulations, its cases (the parts) and its runs ("why did you add R-012?", "is the
obligation on X captured?", "which regulations does this project use?").

The model gets the project as it stands in the database (the regulations it uses, with their
scope summaries; its cases and their files; its runs) and, when the person is on a run's or a
case's page, that run's requirements and trace or that case's text. Read-only tools reach the
rest: the library search limited to the project's regulations, a paragraph's full text, another
run's details, another case's text. Everything read is checked to belong to the project.

The model is the organisation's chat model (Admin, Models), else CHAT_MODEL (Haiku), the same on
every page, so a conversation does not change model when the person changes page; the panel shows
its name. An organisation that runs on its own Ollama server (SYS-30) and chose no chat model
gets its run model instead, so its data stays there.

Stateless: the browser keeps the conversation and sends it with every question. Nothing is
written but the answer's usage: one `model_usage` row per answer, as process `chat` (its search
vectors as `search`), against the run on the person's page if there is one (SYS-40, IF-7). That
is what Admin, Usage shows and the monthly cap adds up. On a run's page one answer reads the whole
requirement list, about 20-40k tokens on the dev case (an estimate from the list's size, not
measured).

What this does NOT do: stop an answer that crosses the cap. The cap is checked before answering,
so an organisation over it gets no more answers, but the answer that takes it over is finished.
"""

import asyncio
import json
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any, Literal, Protocol
from uuid import UUID

import httpx
from pydantic import BaseModel, Field
from pydantic_ai import Agent, FunctionToolset, RunContext, UsageLimits
from pydantic_ai.messages import ModelMessage, ModelRequest, ModelResponse, TextPart, UserPromptPart

from agent_service import providers, read_only
from agent_service.domain import regulation_search
from agent_service.domain.regulation_search import ProjectScope
from agent_service.metering import Credential, Meter, metered
from agent_service.records import LibraryVersion, Requirement, Run, RunEvent, RunOutcome
from agent_service.settings import Settings, effective
from agent_service.store import RunStore

# A conversation longer than this is cut to its last turns: the project's context is sent with
# every question, so old turns add cost and little else.
MAX_TURNS = 24
MAX_MESSAGE_CHARS = 4000
# Model requests per answer: one to read, a few tool calls, one to answer.
_REQUEST_LIMIT = 8
# What goes into the instructions, in characters (about 4 per token). A run's requirements are
# what most questions are about, so they get most of it; 120,000 characters is about 400 of them.
_REQUIREMENTS_CHARS = 120_000
_TRACE_CHARS = 30_000
_OUTPUT_CHARS = 20_000
_CASE_CHARS = 30_000
_TEXT_EVENT_CHARS = 1500
_ARGS_CHARS = 300
_PARAGRAPH_CHARS = 6000
_SCOPE_CHARS = 240
# Runs listed in the project's context, newest first; older ones are named by count only.
_RUNS_LISTED = 40
# Runs the tools can open by id: one PostgREST page.
_RUNS_OPENED = 1000
_REGULATIONS_LISTED = 150


class Turn(BaseModel):
    role: Literal["user", "assistant"]
    content: str = Field(min_length=1, max_length=MAX_MESSAGE_CHARS)


class Page(BaseModel):
    """Where the person is. The web reads it from the URL; every id is checked against the
    project before anything is read."""

    path: str = Field(default="/", max_length=500)
    run_id: UUID | None = None
    case_id: UUID | None = None
    regulation_id: UUID | None = None


class ProjectInfo(BaseModel):
    id: UUID
    organization_id: UUID
    name: str
    all_regulations: bool = True


class CaseFileSummary(BaseModel):
    filename: str
    format: str
    status: str
    pages: int | None = None


class CaseSummary(BaseModel):
    id: UUID
    name: str
    files: list[CaseFileSummary] = []


class RunSummary(BaseModel):
    id: UUID
    case_id: UUID | None = None
    status: str
    model: str | None = None
    created_at: datetime
    task: str = ""
    error: str | None = None


class ProjectStore(Protocol):
    async def project(self, project_id: UUID) -> ProjectInfo | None: ...
    async def project_cases(self, project_id: UUID) -> list[CaseSummary]: ...
    async def project_runs(self, project_id: UUID, limit: int) -> list[RunSummary]:
        """Newest first."""
        ...

    async def project_scope(self, project_id: UUID) -> ProjectScope: ...
    async def regulation_code(self, org: UUID, regulation_id: UUID) -> str | None: ...
    async def aclose(self) -> None: ...


class ChatRefused(Exception):
    """The question cannot be answered now; the message says why, for the person."""

    def __init__(self, message: str, status: int) -> None:
        super().__init__(message)
        self.status = status


@dataclass
class ChatDeps:
    store: RunStore
    project: ProjectInfo
    scope: ProjectScope
    cases: dict[UUID, CaseSummary]
    runs: dict[UUID, RunSummary]
    settings: Settings
    library: list[LibraryVersion] | None = None
    searches: list[str] = field(default_factory=list[str])
    # The answer's usage; the query vectors of its searches go here too.
    meter: Meter | None = None
    # Shown under the answer, word for word, whatever the model writes (#37).
    notices: list[str] = field(default_factory=list[str])


@dataclass(frozen=True)
class Answer:
    text: str
    model: str
    usage: dict[str, Any]
    # What the person must know about how the answer was found: a search that matched words only.
    notices: list[str] = field(default_factory=list[str])


def in_scope(versions: list[LibraryVersion], scope: ProjectScope) -> list[LibraryVersion]:
    if scope.all_regulations:
        return versions
    allowed = set(scope.version_ids)
    return [v for v in versions if v.id in allowed]


toolset = FunctionToolset[ChatDeps]()


async def _library(deps: ChatDeps) -> list[LibraryVersion]:
    if deps.library is None:
        everything = await deps.store.library_versions(deps.project.organization_id)
        deps.library = in_scope(everything, deps.scope)
    return deps.library


def _find(ids: dict[UUID, Any], ref: str) -> UUID | None:
    """A run or case by its id, or by the first characters of it as the context shows them."""
    ref = ref.strip().lower()
    if not ref:
        return None
    return next((i for i in ids if str(i) == ref or str(i).startswith(ref)), None)


@toolset.tool
async def search_regulations(
    ctx: RunContext[ChatDeps], query: str, limit: int = 10
) -> list[dict[str, Any]]:
    """Search the paragraphs of the regulations this project uses (base versions, the ones a
    requirement cites), best match first. Use it to find the paragraph that states an obligation
    the engineer asks about, then compare its citation with a run's requirements.

    Args:
        query: What to find, in words: the product, its function and the property asked about.
        limit: How many paragraphs to return, at most 20.
    """
    deps = ctx.deps
    deps.searches.append(query)
    base = [v.id for v in await _library(deps) if v.role == "base"]
    if not base:
        return []
    k = max(1, min(limit, 20))
    store = deps.store.search_store()
    org = deps.project.organization_id
    reason: str | None = None
    async with httpx.AsyncClient(timeout=30) as http:
        try:
            hits = await regulation_search.search(
                store, http, deps.settings, org, query, version_ids=base, k=k, meter=deps.meter
            )
            if regulation_search.words_only(hits):
                reason = regulation_search.NOT_INDEXED
        except (regulation_search.EmbeddingError, ValueError) as exc:
            # No embedding key or model: words alone, as the orchestrator does.
            reason = str(exc).rstrip(".")
            hits = await regulation_search.search(
                store, http, deps.settings, org, query, version_ids=base, k=k, mode="text"
            )
    if reason is not None:
        notice = regulation_search.WORDS_ONLY.format(reason=reason)
        if notice not in deps.notices:
            deps.notices.append(notice)
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
    """The full text of one paragraph of the project's regulations, with its sub-paragraphs
    (a label also returns the labels under it, "<label>.1", "<label>.2"): what a requirement
    cites, to quote its obligation.

    Args:
        regulation: The regulation's code, as a requirement cites it.
        paragraph: The paragraph label, as a requirement cites it.
        version: The version label ("00"). Without it, the base version.
    """
    wanted = regulation.strip().casefold()
    versions = [v for v in await _library(ctx.deps) if v.regulation.casefold() == wanted]
    if version is not None:
        versions = [v for v in versions if v.version_label == version.strip()]
    else:
        versions = sorted(versions, key=lambda v: v.role != "base")
    if not versions:
        named = f"{regulation} {version}" if version else regulation
        return {"error": f"{named} is not among this project's regulations."}
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


@toolset.tool
async def run_details(ctx: RunContext[ChatDeps], run: str) -> str:
    """One run of this project in full: its task, status, every requirement with its citation,
    test and check findings, and a digest of its trace. Call it before answering about a run
    other than the one on the person's page.

    Args:
        run: The run's id, or its first 8 characters as listed under "Runs".
    """
    deps = ctx.deps
    run_id = _find(deps.runs, run)
    if run_id is None:
        return f"No run {run!r} in this project."
    found = await run_block(deps.store, run_id, deps.cases)
    return found or f"No run {run!r} in this project."


@toolset.tool
async def read_case(ctx: RunContext[ChatDeps], case: str) -> str:
    """The text of one case of this project as the agent read it from its files (drawings and
    scanned pages appear only as their transcription, if any).

    Args:
        case: The case's name or id, as listed under "Cases".
    """
    deps = ctx.deps
    wanted = case.strip().casefold()
    case_id = next((c.id for c in deps.cases.values() if c.name.casefold() == wanted), None)
    case_id = case_id or _find(deps.cases, case)
    if case_id is None:
        return f"No case {case!r} in this project."
    return await case_block(deps.store, deps.cases[case_id])


assistant = Agent(
    name="assistant",
    deps_type=ChatDeps,
    output_type=str,
    instructions=(Path(__file__).parent / "assistant.md").read_text(),
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
                note = p.get("note") or ""
                lines.append(f"Approval: {p.get('tool_name')} {p.get('decision')} {note}")
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
        f"## Run {run.id}",
        f"Status: {run.status}",
        f"Case: {case_name or '(none)'}",
        f"Model: {outcome.model or '(not started)'}",
        f"Task:\n{_clip(run.task, 4000)}",
    ]
    if outcome.error:
        parts.append(f"Error: {_clip(outcome.error, 2000)}")
    counts = {s: sum(r.status == s for r in rows) for s in ("draft", "approved", "rejected")}
    parts.append(
        f"### Requirements ({len(rows)}: {counts['approved']} approved, {counts['draft']} draft, "
        f"{counts['rejected']} rejected)"
    )
    parts.append(requirement_lines(rows) if rows else "This run wrote no requirements.")
    if not rows and outcome.output:
        parts.append(f"### Output\n{_clip(outcome.output, _OUTPUT_CHARS)}")
    parts.append(f"### Trace\n{trace_digest(events) or 'No events.'}")
    return "\n\n".join(parts)


async def run_block(store: RunStore, run_id: UUID, cases: dict[UUID, CaseSummary]) -> str | None:
    """A run of the project in full, or None if it is not one (a run of another project, or of
    no case, is not read)."""
    run = await store.get_run(run_id)
    outcome = await store.run_outcome(run_id)
    if run is None or outcome is None or run.case_id is None or run.case_id not in cases:
        return None
    rows = await store.run_requirements(run_id)
    events = await store.run_events(run_id)
    return run_context(run, outcome, cases[run.case_id].name, rows, events)


async def case_block(store: RunStore, case: CaseSummary) -> str:
    """A case's text blocks, file by file. Images are not sent: a question about a case does not
    need its drawings, and they cost far more than text."""
    files = await store.case_files(case.id)
    blocks = await store.case_blocks(case.id)
    lines = [f"## Case {case.name}"]
    for f in files:
        status = f"{f.status}, {f.pages} pages" if f.pages else f.status
        lines.append(f"### {f.filename} ({status})")
        for b in blocks:
            if b.file_id == f.id and b.kind == "text" and b.text:
                where = f"[page {b.page}] " if b.page else ""
                lines.append(f"{where}{b.text}")
    return _clip("\n".join(lines), _CASE_CHARS)


def project_context(
    project: ProjectInfo,
    versions: list[LibraryVersion],
    cases: list[CaseSummary],
    runs: list[RunSummary],
    total_runs: int,
) -> str:
    names = {c.id: c.name for c in cases}
    parts = [f"# Project {project.name}"]

    parts.append(
        f"## Regulations ({'all of the library' if project.all_regulations else 'chosen'})"
    )
    if not versions:
        parts.append(
            "None. The organisation's library has no regulation this project uses; import them "
            "on the Regulations page."
        )
    else:
        lines = []
        for v in versions[:_REGULATIONS_LISTED]:
            line = f"- {v.regulation} {v.version_label} ({v.role or 'no role'})"
            if v.title:
                line += f": {_clip(v.title, 120)}"
            line += f", {v.paragraph_count or 0} paragraphs"
            if v.scope_summary:
                line += f". Scope: {_clip(v.scope_summary, _SCOPE_CHARS)}"
            lines.append(line)
        if len(versions) > _REGULATIONS_LISTED:
            lines.append(f"- … and {len(versions) - _REGULATIONS_LISTED} more versions.")
        parts.append("\n".join(lines))

    parts.append("## Cases")
    if not cases:
        parts.append("None yet. A case is created in the project, with its files.")
    else:
        lines = []
        for c in cases:
            files = ", ".join(f"{f.filename} ({f.status})" for f in c.files) or "no files"
            lines.append(f"- {c.name} (id {str(c.id)[:8]}): {files}")
        parts.append("\n".join(lines))

    parts.append("## Runs (newest first)")
    if not runs:
        parts.append("None yet. A run is started from a case's page.")
    else:
        lines = []
        for r in runs:
            case = names.get(r.case_id, "(no case)") if r.case_id else "(no case)"
            line = (
                f"- {str(r.id)[:8]} on {case}, {r.status}, {r.created_at:%Y-%m-%d %H:%M} UTC, "
                f"model {r.model or '(not started)'}"
            )
            if r.error:
                line += f". Error: {_clip(r.error, 200)}"
            lines.append(line)
        if total_runs > len(runs):
            lines.append(f"- … and {total_runs - len(runs)} older runs, not listed.")
        parts.append("\n".join(lines))
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


async def model_name(store: RunStore, settings: Settings, org: UUID) -> str:
    """The organisation's chat model (Admin, Models, process "chat"), or CHAT_MODEL. Not the
    run's model: that one is chosen for writing requirements, and costs accordingly (#37). An
    organisation whose runs stay on its own Ollama server keeps its questions there too: a cloud
    default would send the project's cases to a provider it chose not to use (SYS-30)."""
    if chosen := await store.organization_model(org, "chat"):
        return chosen.strip()
    run_model = effective(settings, await store.organization_settings(org)).model
    # "scripted" too: the deployment's fallback when the venue's network or a provider is down,
    # and a cloud default would fail the same way there.
    if run_model.startswith("ollama:") or run_model == "scripted":
        return run_model
    return settings.chat_model.strip()


async def answer(
    store: RunStore,
    projects: ProjectStore,
    settings: Settings,
    project_id: UUID,
    page: Page,
    turns: list[Turn],
) -> Answer:
    """The model's answer to the last turn, which is the person's question."""
    if not turns or turns[-1].role != "user":
        raise ChatRefused("The last message must be the question.", 422)
    project = await projects.project(project_id)
    if project is None:
        raise ChatRefused("No such project.", 404)
    org = project.organization_id
    # Viewers may ask (SYS-39), but in a read-only organisation nobody makes it spend (SYS-47).
    if await store.organization_read_only(org):
        raise ChatRefused(read_only.REFUSAL, 409)
    if (refusal := await _over_cap(store, settings, org)) is not None:
        raise ChatRefused(refusal, 409)

    scope = await projects.project_scope(project_id)
    versions = in_scope(await store.library_versions(org), scope)
    cases = {c.id: c for c in await projects.project_cases(project_id)}
    # Every run the tools may open; the context lists the newest.
    runs = await projects.project_runs(project_id, _RUNS_OPENED)
    runs_by_id = {r.id: r for r in runs}
    listed = runs[:_RUNS_LISTED]
    context = [project_context(project, versions, list(cases.values()), listed, len(runs))]

    here = f"# The person's page\nPath: {page.path}"
    # The run the usage is recorded against: the one on the page, if it is the project's.
    on_run = page.run_id if page.run_id in {r.id for r in runs} else None
    if page.run_id is not None:
        block = await run_block(store, page.run_id, cases)
        here += "\n\n" + (block or "That run is not one of this project's.")
    elif page.case_id is not None:
        case = cases.get(page.case_id)
        here += "\n\n" + (await case_block(store, case) if case else "Not a case of this project.")
    elif page.regulation_id is not None:
        code = await projects.regulation_code(org, page.regulation_id)
        here += f"\n\nThe regulation on screen: {code or '(not in this organisation)'}."
    context.append(here)

    name = await model_name(store, settings, org)
    key, endpoint = await providers.credentials(store, org, name)
    case_id = (
        runs_by_id[on_run].case_id if on_run else page.case_id if page.case_id in cases else None
    )
    meter = Meter(org, run_id=on_run, case_id=case_id)
    credential = Credential.for_model(name, key, endpoint.root() if endpoint else None)
    model = metered(providers.build_model(name, key, endpoint), meter, "chat", name, credential)
    turns = turns[-MAX_TURNS:]
    deps = ChatDeps(
        store=store,
        project=project,
        scope=scope,
        cases=cases,
        runs=runs_by_id,
        settings=settings,
        library=versions,
        meter=meter,
    )
    try:
        async with asyncio.timeout(settings.chat_timeout_s):
            result = await assistant.run(
                turns[-1].content,
                message_history=history(turns[:-1]),
                instructions="\n\n".join(context),
                model=model,
                deps=deps,
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
        notices=deps.notices,
    )
