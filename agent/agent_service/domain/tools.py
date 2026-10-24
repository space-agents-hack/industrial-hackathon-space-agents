"""The orchestrator's tools (#4; docs/se SYS-25, SYS-28, SYS-29). A tool's docstring is what the
model reads to decide when to call it.

Coarse on purpose: "write the requirements of these regulations" is one call that fans out to
parallel writers (domain/writer.py), not 25 calls the orchestrator would have to sequence inside
its 30-request limit. Every requirement is stored the moment its window is written, so a run that
runs out of time still leaves what it wrote in the database.

`requires_approval=True` is the human-in-the-loop switch: the run stops before that tool executes
and waits for a person to approve or deny it in the web UI. It is on `export_requirements`, the
step that turns drafts into the organisation's approved requirements. Drafts are the run's own
working output, like its trace; nobody else's record changes until a person says so.
"""

import asyncio
import json
from copy import copy
from dataclasses import dataclass, field
from typing import Any, cast
from uuid import UUID

import httpx
from pydantic_ai import CachePoint, FunctionToolset, ModelRetry, RunContext, UsageLimits
from pydantic_ai.models import Model
from pydantic_ai.usage import RunUsage

from agent_service.domain import certivity, ingest, regulation_search, writer
from agent_service.domain.writer import UnknownRegulation, Window
from agent_service.records import LibraryVersion, Paragraph, Requirement, Run
from agent_service.settings import Settings
from agent_service.store import RunStore

# Requirements per check-agent call: about 40 x 400 tokens of requirement and paragraph, plus the
# case. Small enough that a model reads each one, large enough that 200 requirements are 5 calls.
_CHECK_BATCH = 40
# A writer or check call that cannot produce a valid answer in this many requests gives up; its
# window is reported as failed and can be written again with write_for_paragraphs.
_SUB_REQUESTS = 4
# More than this is not read by anyone; the count still says how many there are.
_MAX_LISTED = 150


@dataclass
class Deps:
    store: RunStore
    run: Run
    # What a submission names as `case_id` (Certivity's id, "dev-rear-lamp"): the case's name.
    case_name: str
    # The case as every writer reads it: the engineer's note, then the parsed case files.
    case_parts: list[ingest.Part]
    settings: Settings
    reference: certivity.Reference = field(default_factory=lambda: certivity.EMPTY)
    concurrency: int = 6
    # The versions of the regulations the case's project chose (SYS-32), or None for the whole
    # library. Everything the orchestrator sees, searches and writes is limited to them.
    chosen: set[UUID] | None = None
    # The organisation's model for checking (organization_models, process "check"), or None for
    # the run's own model. A second model family catches what the writer's family misses.
    check_model: Model | str | None = None
    # Its key, which no error message from a check call may carry (the run's own key is scrubbed
    # by the runner).
    check_secret: str | None = None
    # Read once per request, on first use.
    library: list[LibraryVersion] | None = None
    paragraphs: dict[UUID, list[Paragraph]] = field(default_factory=dict[UUID, list[Paragraph]])
    # Versions the writers read in full during this run (for the uncovered-paragraph list).
    read: set[UUID] = field(default_factory=set[UUID])
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    next_number: int | None = None


toolset = FunctionToolset[Deps]()


@toolset.tool
async def list_regulations(ctx: RunContext[Deps]) -> list[dict[str, Any]]:
    """List every regulation in the organisation's library: its code, title, versions (with the
    role `base` or `latest`), pages, how many paragraphs were extracted, and what it applies to
    (`scope`, when the library was indexed). Call this first."""
    return [
        {
            "regulation": v.regulation,
            "title": v.title,
            "version": v.version_label,
            "role": v.role,
            "pages": v.page_count,
            "paragraphs": v.paragraph_count,
            "scope": v.scope_summary,
        }
        for v in await _library(ctx.deps)
    ]


@toolset.tool
async def search_regulations(
    ctx: RunContext[Deps], query: str, limit: int = 20
) -> list[dict[str, Any]]:
    """Search every paragraph of the library's base versions, best match first: by meaning where
    the library has embeddings, and by words. Use it to find which regulations speak about this
    product: search for the product, its functions, its parts and its vehicle categories, one
    idea per query.

    Args:
        query: What to find, in words ("rear position lamp luminous intensity").
        limit: How many paragraphs to return, at most 50.
    """
    deps = ctx.deps
    base = [v.id for v in await _library(deps) if v.role == "base"]
    if not base:
        return []
    k = max(1, min(limit, 50))
    store = deps.store.search_store()
    async with httpx.AsyncClient(timeout=30) as http:
        try:
            hits = await regulation_search.search(
                store,
                http,
                deps.settings,
                deps.run.organization_id,
                query,
                version_ids=base,
                k=k,
                case_id=deps.run.case_id,
            )
        except (regulation_search.EmbeddingError, ValueError):
            # No embedding key, or no embedding model configured: words alone still find the
            # regulations that name the product, which is what this step needs.
            hits = await regulation_search.search(
                store,
                http,
                deps.settings,
                deps.run.organization_id,
                query,
                version_ids=base,
                k=k,
                mode="text",
                case_id=deps.run.case_id,
            )
    return [
        {
            "regulation": h.regulation_code,
            "paragraph": h.label,
            "page": h.page_start,
            "heading": (h.heading or "")[-160:],
            "text": h.text[:200],
        }
        for h in hits
    ]


@toolset.tool
async def write_requirements(ctx: RunContext[Deps], regulations: list[str]) -> dict[str, Any]:
    """Read the base version of each regulation in full, in parallel windows of about 15 pages,
    and store a draft requirement for every obligation that applies to this product. Each one
    cites the paragraph it comes from. Name every regulation that applies in one call: they are
    read side by side. A regulation already written in this run is not read again.

    Args:
        regulations: Regulation codes exactly as `list_regulations` gives them, e.g. ["UN R148"].
    """
    deps = ctx.deps
    _case_id(deps.run)
    library = await _library(deps)
    done = await _versions_written(deps)
    jobs: list[Window] = []
    refused: list[str] = []
    for code in dict.fromkeys(regulations):
        try:
            version = writer.citable_version(library, code)
        except UnknownRegulation as exc:
            refused.append(str(exc))
            continue
        if version.id in done:
            refused.append(f"{code} was already written in this run; use write_for_paragraphs.")
            continue
        paragraphs = await _paragraphs(deps, version.id)
        if not paragraphs:
            refused.append(f"{code} {version.version_label} has no extracted paragraphs.")
            continue
        deps.read.add(version.id)
        jobs += writer.windows(version, paragraphs)
    if not jobs:
        raise ModelRetry("Nothing to write. " + " ".join(refused))

    await _progress(
        deps,
        f"Reading {len(jobs)} windows of {len(set(w.version.id for w in jobs))} "
        "regulation(s) in parallel.",
    )
    results = await _write_windows(ctx, jobs)

    written: dict[str, dict[str, Any]] = {}
    failed: list[dict[str, str]] = []
    for window, (count, error) in zip(jobs, results, strict=True):
        entry = written.setdefault(
            window.version.regulation,
            {"version": window.version.version_label, "windows": 0, "requirements": 0},
        )
        entry["windows"] += 1
        entry["requirements"] += count
        if error is not None:
            failed.append(
                {"regulation": window.version.regulation, "pages": window.pages, "error": error}
            )
    return {"written": written, "failed_windows": failed, "refused": refused}


@toolset.tool
async def write_for_paragraphs(
    ctx: RunContext[Deps], regulation: str, paragraphs: list[str]
) -> dict[str, Any]:
    """Write requirements for specific paragraphs of one regulation: the obligations the check
    found uncovered, or a window that failed. Only those paragraphs are read.

    Args:
        regulation: The regulation code, e.g. "UN R148".
        paragraphs: Paragraph labels exactly as the check listed them, e.g. ["5.4.2"].
    """
    deps = ctx.deps
    _case_id(deps.run)
    try:
        version = writer.citable_version(await _library(deps), regulation)
    except UnknownRegulation as exc:
        raise ModelRetry(str(exc)) from exc
    wanted = set(paragraphs)
    chosen = [p for p in await _paragraphs(deps, version.id) if p.label in wanted]
    missing = sorted(wanted - {p.label for p in chosen if p.label})
    if not chosen:
        raise ModelRetry(f"None of these labels is in {regulation}: {', '.join(missing)}.")
    deps.read.add(version.id)
    jobs = writer.windows(version, chosen)
    results = await _write_windows(ctx, jobs)
    return {
        "requirements": sum(count for count, _ in results),
        "failed": [e for _, e in results if e],
        "labels_not_found": missing,
    }


@toolset.tool
async def check_requirements(ctx: RunContext[Deps]) -> dict[str, Any]:
    """Check every draft requirement of this run. A check agent reads each one next to the
    paragraph it cites and flags what is wrong; code flags duplicates and citations that no longer
    match the library, validates the submission file, and lists the obligation paragraphs ("shall",
    "must") of the regulations read that no requirement cites. Findings are stored with the
    requirements; nothing is removed here."""
    deps = ctx.deps
    rows = [r for r in await deps.store.run_requirements(deps.run.id) if r.status != "rejected"]
    if not rows:
        raise ModelRetry("There are no requirements to check yet. Write them first.")
    versions = {v.id: v for v in await _library(deps)}
    version_ids = {r.version_id for r in rows if r.version_id} | deps.read
    by_id: dict[UUID, Paragraph] = {}
    by_label: dict[tuple[str, str], list[Paragraph]] = {}
    for vid in version_ids:
        for p in await _paragraphs(deps, vid):
            by_id[p.id] = p
            if p.label and vid in versions:
                by_label.setdefault((versions[vid].regulation, p.label), []).append(p)

    from_code = writer.code_findings(rows, by_id)
    stored: dict[str, list[dict[str, Any]]] = {
        ext: [{"by": "code", "problem": problem, "action": _code_action(problem)}]
        for ext, problem in from_code.items()
    }

    batches = [rows[i : i + _CHECK_BATCH] for i in range(0, len(rows), _CHECK_BATCH)]
    await _progress(deps, f"Checking {len(rows)} requirements in {len(batches)} batch(es).")
    semaphore = asyncio.Semaphore(deps.concurrency)

    async def check(batch: list[Requirement]) -> list[writer.Finding] | str:
        async with semaphore:
            try:
                result = await writer.check_agent.run(
                    [*_case(deps), CachePoint(), writer.check_batch(batch, by_id)],
                    model=deps.check_model or cast(Model, ctx.model),
                    deps=writer.CheckDeps(by_label),
                    usage_limits=UsageLimits(request_limit=_SUB_REQUESTS + 4),
                )
            except Exception as exc:
                message = f"{type(exc).__name__}: {exc}"
                if deps.check_secret:
                    message = message.replace(deps.check_secret, "[redacted]")
                return message[:300]
            _add_tokens(ctx.usage, result.usage)
            ids = {r.ext_id for r in batch}
            return [f for f in result.output if f.ext_id in ids]

    model_findings: list[dict[str, str]] = []
    check_errors: list[str] = []
    for outcome in await asyncio.gather(*(check(b) for b in batches)):
        if isinstance(outcome, str):
            check_errors.append(outcome)
            continue
        for f in outcome:
            model_findings.append(f.model_dump())
            stored.setdefault(f.ext_id, []).append(
                {"by": "check-agent", "problem": f.problem, "action": f.action}
            )
    await deps.store.add_findings(deps.run.id, stored)

    missed: list[dict[str, Any]] = []
    for vid in sorted(version_ids, key=str):
        if vid in versions:
            missed += writer.uncovered(await _paragraphs(deps, vid), rows, versions[vid])

    checked = certivity.check(
        json.dumps(await _submission(deps)), await _reference(deps), with_score=False
    )
    return {
        "checked": len(rows),
        "findings": [
            {"ext_id": ext, "problem": problem, "action": _code_action(problem), "by": "code"}
            for ext, problem in from_code.items()
        ]
        + [{**f, "by": "check-agent"} for f in model_findings],
        "check_errors": check_errors,
        "uncovered_obligations": missed[:_MAX_LISTED],
        "uncovered_total": len(missed),
        "submission_valid": checked["valid"],
        "submission_problems": checked["problems"][:20],
    }


@toolset.tool
async def reject_requirements(
    ctx: RunContext[Deps], ext_ids: list[str], reason: str
) -> dict[str, Any]:
    """Take requirements out of the submission, for example the ones the check says to reject.
    They stay stored, marked rejected with your reason, so a person can see what was dropped.

    Args:
        ext_ids: Requirement ids, e.g. ["R-012", "R-040"].
        reason: One sentence a reviewer can check.
    """
    deps = ctx.deps
    moved = await deps.store.set_requirement_status(
        deps.run.id, "rejected", only_if="draft", ext_ids=list(dict.fromkeys(ext_ids))
    )
    await deps.store.add_findings(
        deps.run.id,
        {e: [{"by": "orchestrator", "problem": reason, "action": "reject"}] for e in ext_ids},
    )
    return {"rejected": moved}


@toolset.tool(requires_approval=True)
async def export_requirements(ctx: RunContext[Deps], summary: str) -> dict[str, Any]:
    """Mark this run's draft requirements as the organisation's approved requirements for the
    case. A person must approve this call; call it once, after the check.

    Args:
        summary: For the person approving: how many requirements, from which regulations, what the
            check found and what you rejected.
    """
    deps = ctx.deps
    approved = await deps.store.set_requirement_status(deps.run.id, "approved", only_if="draft")
    return {"approved": approved}


async def submit(ctx: RunContext[Deps], summary: str) -> str:
    """Finish the run. The submission file is built from the stored requirements, so call this
    after `export_requirements`, whether it was approved or denied.

    Args:
        summary: Three to six sentences for the engineer: regulations read, requirements written,
            what the check found, what was rejected, and what is left for them to decide.
    """
    deps = ctx.deps
    data = await _submission(deps)
    text = json.dumps(data, ensure_ascii=False, indent=2)
    checked = certivity.check(text, await _reference(deps), with_score=False)
    rows = await deps.store.run_requirements(deps.run.id)
    counts = {s: sum(r.status == s for r in rows) for s in ("approved", "draft", "rejected")}
    lines = [
        summary.strip(),
        "",
        f"Submission: {len(data['requirements'])} requirements ({counts['approved']} approved, "
        f"{counts['draft']} not approved, {counts['rejected']} rejected and left out).",
    ]
    if not checked["valid"]:
        problems = "; ".join(f"{p['path']}: {p['message']}" for p in checked["problems"][:5])
        lines.append(f"validate.py finds {checked['problem_count']} problem(s): {problems}")
    # case_id is the case's name in the app. Clemente's first dev-case run was named otherwise and
    # the platform would have scored it against nothing; the run is where he looks, not /checks.
    # Only a warning: the held-out case has no answer key and is still named correctly.
    ref = await _reference(deps)
    if ref.answer_keys_loaded and data["case_id"] not in ref.expected:
        known = ", ".join(sorted(ref.expected)) or "none"
        lines.append(
            f"case_id {data['case_id']!r} has no answer key (those with one: {known}). Fine for "
            "the held-out case if it is named after its folder; otherwise rename the case to "
            "Certivity's id and run again."
        )
    await _progress(deps, "\n".join(lines))
    return text


# ------------------------------------------------------------------------------------------


async def _library(deps: Deps) -> list[LibraryVersion]:
    if deps.library is None:
        versions = await deps.store.library_versions(deps.run.organization_id)
        if deps.chosen is not None:
            versions = [v for v in versions if v.id in deps.chosen]
        deps.library = versions
    return deps.library


async def _paragraphs(deps: Deps, version_id: UUID) -> list[Paragraph]:
    if version_id not in deps.paragraphs:
        deps.paragraphs[version_id] = await deps.store.version_paragraphs(version_id)
    return deps.paragraphs[version_id]


async def _versions_written(deps: Deps) -> set[UUID]:
    rows = await deps.store.run_requirements(deps.run.id)
    return {r.version_id for r in rows if r.version_id} | deps.read


async def _progress(deps: Deps, text: str) -> None:
    await deps.store.add_event(deps.run.id, "text", {"text": text})


def _case(deps: Deps) -> list[ingest.Part]:
    return [
        "# The case\n\nThe engineer's note:\n" + deps.run.task,
        *deps.case_parts,
    ]


async def _write_windows(ctx: RunContext[Deps], jobs: list[Window]) -> list[tuple[int, str | None]]:
    """Every window through a writer, `concurrency` at a time; (stored, error) per window."""
    deps = ctx.deps
    semaphore = asyncio.Semaphore(deps.concurrency)
    case = _case(deps)

    async def one(window: Window) -> tuple[int, str | None]:
        async with semaphore:
            try:
                result = await writer.writer_agent.run(
                    # The case comes first and is the same for every window: a provider that
                    # caches prompts (Anthropic) reads it once per run instead of once per window.
                    [*case, CachePoint(), window.render()],
                    model=cast(Model, ctx.model),
                    deps=window,
                    usage_limits=UsageLimits(request_limit=_SUB_REQUESTS),
                )
            except Exception as exc:
                return 0, f"{type(exc).__name__}: {exc}"[:300]
            _add_tokens(ctx.usage, result.usage)
            drafts = result.output
        if not drafts:
            return 0, None
        async with deps.lock:
            if deps.next_number is None:
                rows = await deps.store.run_requirements(deps.run.id)
                deps.next_number = len(rows) + 1
            first = deps.next_number
            deps.next_number += len(drafts)
            await deps.store.add_requirements(
                [
                    writer.cite(
                        d,
                        window,
                        ext_id=writer.ext_id(first + i),
                        case_id=_case_id(deps.run),
                        organization_id=deps.run.organization_id,
                        run_id=deps.run.id,
                    )
                    for i, d in enumerate(drafts)
                ]
            )
        return len(drafts), None

    return list(await asyncio.gather(*(one(w) for w in jobs)))


class NoCase(Exception):
    """Requirements belong to a case (ADR-0006); a run started without one cannot store any. Not
    a ModelRetry: no model can fix it, and the run should fail saying so."""


def _case_id(run: Run) -> UUID:
    if run.case_id is None:
        raise NoCase(
            "This run has no case. Requirements are stored per case: start the run from one."
        )
    return run.case_id


def _add_tokens(usage: RunUsage, sub: RunUsage) -> None:
    """A sub-agent's tokens and cost into the run's usage, but not its requests: the run's limit
    (max_model_requests) bounds the orchestrator's loop, and 25 writers would exhaust it."""
    tokens = copy(sub)
    tokens.requests = 0
    tokens.tool_calls = 0
    tokens.details = {**sub.details, "subagent_requests": sub.requests}
    usage.incr(tokens)


def _code_action(problem: str) -> str:
    return "reject" if problem.startswith("Duplicate") else "keep"


async def _submission(deps: Deps) -> dict[str, Any]:
    rows = await deps.store.run_requirements(deps.run.id)
    return writer.submission(writer.TEAM_ID, deps.case_name, rows)


async def _reference(deps: Deps) -> certivity.Reference:
    # The index in it is the organisation's library (certivity.load_reference, ADR-0006), read
    # when the request started; this run's citations come from that same library.
    return deps.reference
