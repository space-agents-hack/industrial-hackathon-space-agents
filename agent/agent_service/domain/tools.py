"""The orchestrator's tools (#4; docs/se SYS-25, SYS-28, SYS-29). A tool's docstring is what the
model reads to decide when to call it.

Coarse on purpose: "write the requirements of these regulations" is one call that fans out to
parallel writers (domain/writer.py), not 25 calls the orchestrator would have to sequence inside
its 30-request limit. Every requirement is stored the moment its writer call answers, so a run that
runs out of time still leaves what it wrote in the database.

`requires_approval=True` is the human-in-the-loop switch: the run stops before that tool executes
and waits for a person to approve or deny it in the web UI. It is on `export_requirements`, the
step that turns drafts into the organisation's approved requirements. Drafts are the run's own
working output, like its trace; nobody else's record changes until a person says so.
"""

import asyncio
import json
import re
from collections import Counter
from copy import copy
from dataclasses import dataclass, field, replace
from typing import Any, cast
from uuid import UUID

import httpx
from pydantic import ValidationError
from pydantic_ai import CachePoint, FunctionToolset, ModelRetry, RunContext, UsageLimits
from pydantic_ai.models import Model
from pydantic_ai.usage import RunUsage

from agent_service.domain import certivity, ingest, regulation_search, screen, writer
from agent_service.domain.writer import UnknownRegulation, Window
from agent_service.metering import Meter, MeteredModel
from agent_service.records import LibraryVersion, Paragraph, Requirement, Run
from agent_service.settings import Settings
from agent_service.store import RunStore

# Requirements per check-agent call: about 15 x 400 tokens of requirement and paragraph, plus the
# case. It was 40, and a call that also reads referenced tables could then run into the 240 s
# sub-agent limit and fail the whole batch unread; the two-stage writer also gives more
# requirements. 15 keeps an answer short; check_concurrency runs the calls side by side.
_CHECK_BATCH = 15
# A writer or check call that cannot produce a valid answer in this many requests gives up; its
# window is reported as failed and can be written again with write_for_paragraphs.
_SUB_REQUESTS = 4
# Translators and the check read other paragraphs with a tool (a table, an annex), and each
# look-up is one more request: at 4, three of the four write_for_paragraphs calls of a production
# run (dev-rear-lamp, Opus, 2026-10-24) lost a batch to "would exceed the request_limit of 4".
_LOOKUP_REQUESTS = _SUB_REQUESTS + 4
# More than this is not read by anyone; the count still says how many there are.
_MAX_LISTED = 150
# Paragraphs per search the screen runs for each profile entry. A regulation is ranked by its best
# paragraph, so 40 paragraphs reach about the 10th to 20th regulation, past rule 3's line (TOP).
_SCREEN_SEARCH_K = 40
# Searches in flight at once. Each is one embedding call and one database query; the database
# cancels a query after 8 s, and a vector search under load came close to that before (#44), so
# not all 20 at once. 6 runs 20 entries in about 4 rounds (an estimate, not measured).
_SCREEN_SEARCHES = 6


@dataclass
class Deps:
    store: RunStore
    run: Run
    # What a submission names as `case_id` (Certivity's id, "dev-rear-lamp"): the case's name.
    case_name: str
    # The case as every writer reads it: the engineer's note, then the parsed case files.
    case_parts: list[ingest.Part]
    # What a submission names as `team_id` ("team-09"): the organisation's name, the way case_id is
    # the case's (Clemente, 2026-10-24: the team renames its organisation to its team id).
    team_id: str
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
    # The run's usage (agent_service/metering.py): the query vector of each search goes here. None
    # in tests that do not look at usage.
    meter: Meter | None = None
    # Read once per request, on first use.
    library: list[LibraryVersion] | None = None
    paragraphs: dict[UUID, list[Paragraph]] = field(default_factory=dict[UUID, list[Paragraph]])
    # Versions the writers read in full during this run (for the uncovered-paragraph list).
    read: set[UUID] = field(default_factory=set[UUID])
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    next_number: int | None = None
    # Recorded by `record_product_profile` (SYS-43), and read back from the trace after a pause.
    profile: writer.ProductProfile | None = None
    # Said once per run in the trace, not after every search (#37).
    words_only_noted: bool = False
    # When the runner stops this request (event-loop time: start + run_timeout_s). Writer and
    # check calls are cut to finish before it, less their reserve (_call_timeout). None, in tests,
    # means only subagent_timeout_s applies.
    deadline: float | None = None
    # Paragraphs whose every clause a writer set aside, by the first clause's reason: not
    # "uncovered" in the check, or the orchestrator writes them again out of context and the
    # set-aside volume comes back. Lost on a pause, like `read`; the check then lists them again.
    set_aside: dict[UUID, str] = field(default_factory=dict[UUID, str])


class OutOfTime(Exception):
    """A writer or check call not started because the run is too close to its time limit."""


# A call that would get less than this is not started: a window's answer takes longer.
_MIN_CALL_S = 30


def _call_timeout(deps: Deps, reserve_s: float) -> float:
    """How long the next writer or check call may take: subagent_timeout_s, cut so it ends
    `reserve_s` before the run's deadline. Raises OutOfTime when that leaves under _MIN_CALL_S."""
    limit = deps.settings.subagent_timeout_s
    if deps.deadline is None:
        return limit
    left = deps.deadline - reserve_s - asyncio.get_running_loop().time()
    if left < _MIN_CALL_S:
        raise OutOfTime(f"not started: under {reserve_s + _MIN_CALL_S:.0f} s of the run were left")
    return min(limit, left)


def _writing_time_spent(deps: Deps) -> bool:
    """Whether the run is inside its write reserve, where no writer call would start."""
    try:
        _call_timeout(deps, deps.settings.write_reserve_s)
    except OutOfTime:
        return True
    return False


_NO_TIME_TO_WRITE = (
    "No time left in this run to write more; what is stored stays. Go on with "
    "check_requirements, export_requirements and submit."
)


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
async def record_product_profile(
    ctx: RunContext[Deps],
    part: str,
    functions: list[str],
    functions_absent: list[str],
    components: list[writer.Component],
    mounted: list[str],
    vehicles: list[str],
    markets: list[str],
    named_in_case: list[str],
) -> dict[str, Any]:
    """Record what the part is, from the whole case: its text and every drawing, exploded view and
    photo. Every writer and the check judge applicability against this one statement, and the
    screen searches the library once for each function and each component, so state only what
    the case shows, and say where (file and page) when it is not obvious. Call it once, before
    screening; call it again only to correct it.

    Args:
        part: One sentence: what the part is.
        functions: Each function the part performs, in the general term regulations use for
            that kind of device or property, one per entry.
        functions_absent: Functions of the same family of parts that the case shows it does not
            have.
        components: Every component the case shows, including what only a drawing shows (count
            them): electrical and electronic parts, light sources, sensors, actuators, software,
            wiring, glazing, materials, moving parts, the housing and fixings. Each with a unique
            name, the functions it serves, its technology, and how the case shows it is built in.
        mounted: Where it is fitted on the vehicle, and which properties of the vehicle it
            affects (outer shape, impact behaviour, field of view, signalling, ...).
        vehicles: Vehicle categories it is for, as the case gives them.
        markets: Markets or approval systems the case names.
        named_in_case: Each regulation, approval mark or standard the case files name, with
            file and page. Empty if none.
    """
    deps = ctx.deps
    try:
        deps.profile = writer.ProductProfile(
            part=part,
            functions=functions,
            functions_absent=functions_absent,
            components=components,
            mounted=mounted,
            vehicles=vehicles,
            markets=markets,
            named_in_case=named_in_case,
        )
    except ValidationError as exc:
        raise ModelRetry(str(exc)) from exc
    return {"recorded": True, "read_by": "every writer, the screen and the check"}


@toolset.tool
async def screen_regulations(ctx: RunContext[Deps]) -> dict[str, Any]:
    """Choose what to read: every regulation of the library judged against the product profile
    from its scope section, introduction and transitional provisions, next to where a search for
    each function and each component of the profile ranks it. Fixed rules then give `to_read`:
    every regulation the case names, every `applies`, and every `possibly` that some search ranks
    among the first five regulations, each with the sentence it rests on. A `possibly` no search
    ranks there is in `not_read` and `rule3`. Unlike a search, it cannot miss a regulation because
    no query was written for it. Also lists the profile entries that several regulations to read
    cover, and what their own texts say about replacing one another. Call it once, after
    `record_product_profile`."""
    deps = ctx.deps
    profile = await _require_profile(deps)
    versions = _citable(await _library(deps))
    semaphore = asyncio.Semaphore(deps.concurrency)
    entries = profile.search_entries()
    searching = asyncio.Semaphore(_SCREEN_SEARCHES)

    async def read(version: LibraryVersion) -> screen.Candidate:
        async with semaphore:
            return screen.candidate(version, await _paragraphs(deps, version.id))

    failed: list[str] = []

    async def entry_search(http: httpx.AsyncClient, query: str) -> list[regulation_search.Hit]:
        # A failed search is no evidence, not a failed screen: the verdicts still come from the
        # scope text, and rule 3 goes back to logging only (below).
        try:
            async with searching:
                return await _search(deps, http, query, _SCREEN_SEARCH_K)
        except Exception as exc:
            failed.append(query)
            await _progress(deps, f"Search for {query!r} failed: {type(exc).__name__}: {exc}"[:400])
            return []

    # The searches and the reads of the scopes side by side: one search per entry is 10 to 20
    # round trips to the database and the embedding provider, which in sequence would add a
    # minute to a run that is short of time.
    async with httpx.AsyncClient(timeout=30) as http:
        read_all = asyncio.gather(*(read(v) for v in versions))
        search_all = asyncio.gather(*(entry_search(http, query) for _, query in entries))
        candidates, searched = await asyncio.gather(read_all, search_all)
    found = screen.evidence(
        [
            (entry, [h.regulation_code for h in hits])
            for (entry, _), hits in zip(entries, searched, strict=True)
        ]
    )
    candidates = [
        replace(c, evidence=tuple(found.get(c.version.regulation, [])), searched=bool(entries))
        for c in candidates
    ]
    batches = screen.batches(candidates)
    await _progress(
        deps,
        f"Screening the scope of {len(candidates)} regulations in {len(batches)} call(s), "
        f"next to {len(entries)} search(es), one per function and component of the profile.",
    )
    head = ["# The case\n\nThe engineer's note:\n" + deps.run.task, profile.render()]

    async def judge(batch: list[screen.Candidate]) -> list[screen.Verdict] | str:
        async with semaphore:
            try:
                async with asyncio.timeout(deps.settings.subagent_timeout_s):
                    result = await screen.screen_agent.run(
                        [*head, CachePoint(), "\n\n".join(c.render() for c in batch)],
                        model=cast(Model, ctx.model),
                        deps=batch,
                        usage_limits=UsageLimits(request_limit=_SUB_REQUESTS),
                    )
            except Exception as exc:
                codes = ", ".join(c.version.regulation for c in batch)
                return f"{codes}: {_failure(deps, exc)[:300]}"
            _add_tokens(ctx.usage, result.usage)
            return result.output

    verdicts: list[screen.Verdict] = []
    errors: list[str] = []
    for outcome in await asyncio.gather(*(judge(b) for b in batches)):
        if isinstance(outcome, str):
            errors.append(outcome)
        else:
            verdicts += outcome
    titles = {v.regulation: v.title for v in versions}
    by_code = {v.regulation: v for v in verdicts}
    # Rule 3 leaves a `possibly` out only on a full set of ranks. With no entries to search, or a
    # search that failed (the one that would have ranked it, perhaps), it logs instead.
    live = screen.RULE3_LIVE and bool(entries) and not failed
    decisions = screen.decide(
        [v.regulation for v in versions], verdicts, found, profile.named_in_case, live=live
    )

    def row(d: screen.Decision) -> dict[str, Any]:
        out: dict[str, Any] = {
            "regulation": d.regulation,
            "title": titles.get(d.regulation),
            "because": d.because,
            "verdict": d.verdict,
            "search": screen.describe(found.get(d.regulation, []), most=2),
        }
        if v := by_code.get(d.regulation):
            out |= {
                "reason": v.reason,
                "scope_quote": v.scope_quote,
                "profile_entries": v.profile_entries,
            }
            if v.replacement:
                out["replacement"] = v.replacement
        return out

    to_read = [row(d) for d in decisions if d.read]
    marked = [
        {"regulation": d.regulation, "search": screen.describe(found.get(d.regulation, []), 2)}
        for d in decisions
        if d.rule3
    ]
    if marked:
        # For the person reading the trace: what rule 3 left out, or would have (SYS-44, #53).
        await _progress(
            deps,
            f"Rule 3 ({'live, left out' if live else 'shadow, nothing left out'}): "
            f"{len(marked)} `possibly` regulation(s) no search ranks in the first {screen.TOP}: "
            + ", ".join(r["regulation"] for r in marked)
            + ".",
        )
    read_codes = {d.regulation for d in decisions if d.read}
    return {
        "to_read": to_read,
        "not_read": [
            {
                "regulation": d.regulation,
                "because": d.because,
                "reason": by_code[d.regulation].reason,
            }
            for d in decisions
            if not d.read and d.regulation in by_code
        ],
        "shared_profile_entries": screen.shared_entries(
            [v for v in verdicts if v.regulation in read_codes]
        ),
        # Left out by rule 3 when `rule3_live`, else only marked. Add one back only on evidence.
        "rule3": marked,
        "rule3_live": live,
        # A batch that failed is not a verdict of does_not: search those regulations instead.
        "not_screened": errors,
    }


@toolset.tool
async def search_regulations(
    ctx: RunContext[Deps], query: str, limit: int = 20
) -> list[dict[str, Any]]:
    """Search every paragraph of the versions requirements cite, best match first: by meaning where
    the library has embeddings, and by words. The screen already searched once for each function
    and component of the profile; use this for a question it left open, one idea per query.

    Args:
        query: What to find, in words: one function, component or property of the part.
        limit: How many paragraphs to return, at most 50.
    """
    deps = ctx.deps
    async with httpx.AsyncClient(timeout=30) as http:
        hits = await _search(deps, http, query, max(1, min(limit, 50)))
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


async def _search(
    deps: Deps, http: httpx.AsyncClient, query: str, k: int
) -> list[regulation_search.Hit]:
    """The paragraphs of the citable versions that best match `query`: hybrid, and words alone
    when the query cannot be embedded (the trace says so once per run)."""
    # The versions the writer would cite, not only those marked base: a regulation whose only
    # version has no role was writable but never found (#40).
    base = [v.id for v in _citable(await _library(deps))]
    if not base:
        return []
    store = deps.store.search_store()
    reason: str | None = None
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
            meter=deps.meter,
        )
        if regulation_search.words_only(hits):
            reason = regulation_search.NOT_INDEXED
    except (regulation_search.EmbeddingError, ValueError) as exc:
        reason = str(exc).rstrip(".")
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
    if reason is not None and not deps.words_only_noted:
        # For the person reading the trace, not for the model: its tool result is unchanged.
        deps.words_only_noted = True
        text = regulation_search.WORDS_ONLY.format(reason=reason)
        await deps.store.add_event(deps.run.id, "text", {"text": text, "level": "warning"})
    return hits


@toolset.tool
async def write_requirements(ctx: RunContext[Deps], regulations: list[str]) -> dict[str, Any]:
    """Read the base version of each regulation in full, in parallel windows of about 15 pages,
    and store a draft requirement for every obligation that applies to this product. Each one
    cites the paragraph it comes from. Name every regulation that applies in one call: they are
    read side by side. A regulation already written in this run is not read again.

    Args:
        regulations: Regulation codes exactly as `list_regulations` gives them, e.g. ["UN R<n>"].
    """
    deps = ctx.deps
    _case_id(deps.run)
    await _require_profile(deps)
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
    jobs = writer.queue_order(jobs)

    await _progress(
        deps,
        f"Reading {len(jobs)} windows of {len(set(w.version.id for w in jobs))} "
        "regulation(s) in parallel, "
        + (
            "in two stages: what applies clause by clause, then translators."
            if deps.settings.writer_stages == "two"
            else "one writer per window."
        ),
    )
    tally: Counter[str] = Counter()
    covers: dict[str, Counter[str]] = {}
    agreement: Counter[str] = Counter()
    results = await _write_windows(ctx, jobs, tally, covers, agreement)
    if agreement:
        await _progress(
            deps,
            f"Disposition vote ({deps.settings.disposition_samples} answers per window, "
            f"{deps.settings.disposition_vote}): "
            + ", ".join(f"{k.removeprefix('vote: ')} {n}" for k, n in sorted(agreement.items()))
            + ".",
        )
    if covers:
        # A line of its own: the tool result below is clipped in the trace when it is long.
        await _progress(
            deps,
            "Obligations kept, and how many cover the part as a whole: "
            + "; ".join(
                f"{reg} {sum(c.values())} ({c[writer.WHOLE_PART]} the part, "
                f"{c[writer.NOT_IN_PROFILE]} not in the profile)"
                for reg, c in covers.items()
            )
            + ".",
        )

    written: dict[str, dict[str, Any]] = {}
    failed: list[dict[str, Any]] = []
    for window, (count, error) in zip(jobs, results, strict=True):
        entry = written.setdefault(
            window.version.regulation,
            {"version": window.version.version_label, "windows": 0, "requirements": 0},
        )
        entry["windows"] += 1
        entry["requirements"] += count
        if error is not None:
            # The labels are what write_for_paragraphs takes: with pages only, the orchestrator had
            # nothing to retry a failed window with (#39). Unnumbered text has no label to pass.
            labels = [p.label for p in window.paragraphs if p.label]
            report: dict[str, Any] = {
                "regulation": window.version.regulation,
                "pages": window.pages,
                "error": error,
                "paragraphs": labels,
            }
            if unlabelled := len(window.paragraphs) - len(labels):
                report["unnumbered_paragraphs"] = unlabelled
            failed.append(report)
    return {
        "written": written,
        "clauses_set_aside": dict(tally),
        **({"disposition_vote": dict(agreement)} if agreement else {}),
        # Kept obligations per regulation by what of the profile they cover: if "the part" holds
        # most of a regulation, the writers may be filing other devices' obligations under it.
        "obligations_by_covers": {reg: dict(c.most_common()) for reg, c in covers.items()},
        "failed_windows": failed,
        "refused": refused,
    }


@toolset.tool
async def write_for_paragraphs(
    ctx: RunContext[Deps], regulation: str, paragraphs: list[str]
) -> dict[str, Any]:
    """Write requirements for specific paragraphs of one regulation: the obligations the check
    found uncovered, or the `paragraphs` of a window that failed. Only those paragraphs are read.

    Args:
        regulation: The regulation code, as `list_regulations` gives it.
        paragraphs: Labels exactly as the check listed them, e.g. ["x.y.z", "Annex n x.y"].
    """
    deps = ctx.deps
    _case_id(deps.run)
    await _require_profile(deps)
    if _writing_time_spent(deps):
        # Answered at once, so the orchestrator moves on: in production it spent 96 s retrying
        # windows after the writers and reached the check with 35 s left (dev-rear-lamp,
        # 2026-10-24). A window not started for lack of time is still listed as failed.
        return {"requirements": 0, "out_of_time": _NO_TIME_TO_WRITE}
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
    await _require_profile(deps)
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
    semaphore = asyncio.Semaphore(deps.settings.check_concurrency)
    model = deps.check_model or ctx.model
    if isinstance(model, MeteredModel):
        # The run's own model doing the checking: counted as checking on the usage page.
        model = model.as_process("check")

    async def check(batch: list[Requirement]) -> list[writer.Finding] | str:
        async with semaphore:
            try:
                async with asyncio.timeout(_call_timeout(deps, deps.settings.check_reserve_s)):
                    result = await writer.check_agent.run(
                        [*_case(deps), CachePoint(), writer.check_batch(batch, by_id)],
                        model=cast(Model, model),
                        deps=writer.CheckDeps(by_label),
                        usage_limits=UsageLimits(request_limit=_LOOKUP_REQUESTS),
                    )
            except Exception as exc:
                message = _failure(deps, exc)
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
            missed += writer.uncovered(
                await _paragraphs(deps, vid), rows, versions[vid], deps.set_aside
            )

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
        # Obligation paragraphs left uncited because the writers set every clause aside: counted
        # by reason so none is silent, and not to be written again.
        "set_aside_paragraphs": dict(
            Counter(
                r for pid, r in deps.set_aside.items() if pid not in {x.paragraph_id for x in rows}
            )
        ),
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
    # team_id is the organisation's name. Only a warning: the platform's ids look like team-07, but
    # nothing here knows the list.
    if not re.fullmatch(r"team-\d+", deps.team_id):
        lines.append(
            f"team_id {deps.team_id!r} is the organisation's name and does not look like a "
            "platform team id (team-07): rename it in Settings, Models and limits, and run again "
            "before uploading."
        )
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


def _citable(library: list[LibraryVersion]) -> list[LibraryVersion]:
    """One version per regulation, the one requirements cite (writer.citable_version). A
    regulation it refuses (several versions, none base) is left out: it cannot be cited."""
    out: list[LibraryVersion] = []
    for code in dict.fromkeys(v.regulation for v in library):
        try:
            out.append(writer.citable_version(library, code))
        except UnknownRegulation:
            continue
    return out


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
    """The case as writers and the check read it, with the profile last: one statement of what
    the part is, so 25 writers do not each conclude it differently from the files (SYS-43)."""
    parts: list[ingest.Part] = [
        "# The case\n\nThe engineer's note:\n" + deps.run.task,
        *deps.case_parts,
    ]
    if deps.profile is not None:
        parts.append(deps.profile.render())
    return parts


async def _require_profile(deps: Deps) -> writer.ProductProfile:
    """The run's profile; after a pause for approval, the last one recorded in the trace."""
    if deps.profile is None:
        for event in reversed(await deps.store.run_events(deps.run.id)):
            if event.kind == "tool_call" and event.payload.get("tool_name") == (
                "record_product_profile"
            ):
                try:
                    deps.profile = writer.ProductProfile.model_validate(event.payload["args"])
                except (KeyError, ValueError):
                    continue
                break
    if deps.profile is None:
        raise ModelRetry(
            "Record what the part is with `record_product_profile` first: the writers judge "
            "what applies against it."
        )
    return deps.profile


async def _write_windows(
    ctx: RunContext[Deps],
    jobs: list[Window],
    tally: Counter[str] | None = None,
    covers: dict[str, Counter[str]] | None = None,
    agreement: Counter[str] | None = None,
) -> list[tuple[int, str | None]]:
    """Every window through the writer; (stored, error) per window. `tally` counts the clauses
    set aside, by reason, and those left without an answer: what the trace shows of the
    obligations the writers decided not to write (#48). `covers` counts the kept obligations per
    regulation by the profile entry they cover. `agreement` counts, with disposition_samples above
    1, the units every sample kept, those only some kept, and those the vote dropped.

    Two stages (settings.writer_stages, the default): the disposition agent decides per clause
    what applies, then translators write the obligations ten at a time. One stage: a single writer
    per window does both. Per-window calls run `concurrency` at a time and translators
    translate_concurrency at a time, in separate lanes, so a window's translations start as soon
    as its first stage answers. Drafts are stored as each call answers, and no call runs past the
    run's write reserve (_call_timeout), so a slow run keeps what it wrote and still checks it."""
    deps = ctx.deps
    window_lane = asyncio.Semaphore(deps.concurrency)
    translate_lane = asyncio.Semaphore(deps.settings.translate_concurrency)
    case = _case(deps)
    model = cast(Model, ctx.model)
    two_stages = deps.settings.writer_stages == "two"

    def count(
        window: Window,
        kept: list[writer.Obligation] | list[writer.Draft],
        set_aside: list[writer.SetAside],
    ) -> None:
        if covers is not None and window.covers_from:
            covers.setdefault(window.version.regulation, Counter()).update(
                writer.covered_entry(window, k.covers) for k in kept
            )
        answered = {c for k in kept for c in k.clauses}
        reasons = {a.clause: a.reason for a in set_aside}
        for p in window.paragraphs:
            ids = [cid for cid, _ in window.clauses.get(p.position, [])]
            if ids and all(c in reasons and c not in answered for c in ids):
                deps.set_aside[p.id] = reasons[ids[0]]
        if tally is not None:
            tally.update(a.reason for a in set_aside)
            answered = answered | {a.clause for a in set_aside}
            tally["no answer"] += len(window.clause_ids - answered)

    async def ask(lane: asyncio.Semaphore, agent: Any, prompt: str, job: Any) -> Any:
        async with lane:
            async with asyncio.timeout(_call_timeout(deps, deps.settings.write_reserve_s)):
                result = await agent.run(
                    # The case comes first and is the same for every call: a provider that caches
                    # prompts (Anthropic) reads it once per run, not once per window.
                    [*case, CachePoint(), prompt],
                    model=model,
                    deps=job,
                    usage_limits=UsageLimits(
                        request_limit=_LOOKUP_REQUESTS
                        if agent is writer.translator_agent
                        else _SUB_REQUESTS
                    ),
                )
        _add_tokens(ctx.usage, result.usage)
        return result.output

    async def store(window: Window, drafts: list[writer.Draft]) -> int:
        if not drafts:
            return 0
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
        return len(drafts)

    samples = deps.settings.disposition_samples

    async def dispose(window: Window) -> writer.Disposition:
        prompt = window.render()
        if samples == 1:
            return await ask(window_lane, writer.disposition_agent, prompt, window)
        answers = await asyncio.gather(
            *(ask(window_lane, writer.disposition_agent, prompt, window) for _ in range(samples)),
            return_exceptions=True,
        )
        ok = [a for a in answers if isinstance(a, writer.Disposition)]
        if not ok:
            raise next(a for a in answers if isinstance(a, BaseException))
        # Need is counted on the answers that came back: a sample that failed is no vote.
        need = 1 if deps.settings.disposition_vote == "union" else len(ok) // 2 + 1
        found, votes = writer.vote_dispositions(ok, need=need)
        if agreement is not None:
            agreement.update(votes)
        return found

    async def two_stage(window: Window) -> tuple[int, str | None]:
        found = await dispose(window)
        count(window, found.obligations, found.set_aside)
        version_paragraphs = await _paragraphs(deps, window.version.id)
        batches = writer.translation_jobs(window, found, version_paragraphs)

        async def translate(job: writer.TranslationJob) -> int | str:
            try:
                drafts = await ask(translate_lane, writer.translator_agent, job.render(), job)
            except Exception as exc:
                return _failure(deps, exc)[:300]
            return await store(window, drafts)

        stored = 0
        errors: list[str] = []
        for outcome in await asyncio.gather(*(translate(b) for b in batches)):
            if isinstance(outcome, str):
                errors.append(outcome)
            else:
                stored += outcome
        # A failed batch loses its ten obligations, not the window: the rest is stored, and the
        # window is reported so the orchestrator can write its paragraphs again.
        return stored, ("; ".join(errors)[:300] or None)

    covers_from = writer.coverable(deps.profile)

    async def one(window: Window) -> tuple[int, str | None]:
        window = replace(window, covers_from=covers_from)
        try:
            if two_stages:
                return await two_stage(window)
            answer: writer.WindowAnswer = await ask(
                window_lane, writer.writer_agent, window.render(), window
            )
            count(window, answer.requirements, answer.set_aside)
            return await store(window, answer.requirements), None
        except Exception as exc:
            return 0, _failure(deps, exc)[:300]

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


def _failure(deps: Deps, exc: Exception) -> str:
    # asyncio.timeout raises a bare TimeoutError, whose message is empty: say what it means.
    if isinstance(exc, TimeoutError):
        return (
            f"TimeoutError: no answer within {deps.settings.subagent_timeout_s:g} s, or before "
            "the run's time limit, stopped."
        )
    return f"{type(exc).__name__}: {exc}"


def _code_action(problem: str) -> str:
    return "reject" if problem.startswith("Duplicate") else "keep"


async def _submission(deps: Deps) -> dict[str, Any]:
    rows = await deps.store.run_requirements(deps.run.id)
    return writer.submission(deps.team_id, deps.case_name, rows)


async def _reference(deps: Deps) -> certivity.Reference:
    # The index in it is the organisation's library (certivity.load_reference, ADR-0006), read
    # when the request started; this run's citations come from that same library.
    return deps.reference
