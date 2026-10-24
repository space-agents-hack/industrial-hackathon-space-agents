"""A run on a sub-goal case: Certivity's sub-goal folder in, one changes file out (#42, SYS-45,
SYS-19). The main goal's workflow, with a different engine inside the run.

The case holds the folder as Certivity ships it, uploaded like any case's files:
`requirements_old.json` (requirements written from the old version), `files.json` (links to
old.pdf and new.pdf with their sha256), and optionally the two PDFs themselves. What each file is
comes from its content, not its name, so a renamed file still works.

A run, step by step, each step a `tool_call` and `tool_result` pair in the trace:
1. `read_case`: the requirements and the two versions. PDFs missing from the case are fetched
   from files.json, checked against its sha256 and stored in the case, so the case still runs
   after Certivity's links expire (they do, after the event) and the data is in Supabase (SYS-16).
2. `extract_versions`: both PDFs into numbered paragraphs, with the store's extractor (#3).
3. `compare_versions`: the rules diff (`regdiff`), no model. Measured: 7/7 flagged, 0 extra,
   16/17 added on the dev pair, and robust on 14 other version pairs (subgoal-gaps.md).
4. `review_changes`: reviewer agents re-read the requirements whose cited paragraph changed in any
   way (`subgoal_review.py`). Only what code can verify in the PDFs' text changes the answer.
5. `write_changes`: a writer step writes each change's text as a requirement, one per obligation
   for added text (`subgoal_write.py`). Code checks each text against the regulation and keeps
   the rules' wording where it fails. Detection does not change here, only the text.
6. The changes file, as the run's output. The run page checks it with Certivity's validate.py
   and scores it where an answer key is loaded, as for any submission.

Why code orchestrates and no model does: every decision between the steps (which requirements to
review, in what batches, what to do with a verdict) has a rule that can be stated and tested. A
model choosing them would make the run slower, costlier and different on each run, and nothing
measured says it would decide better. The model is used where rules are weakest: tracing a
reworded requirement back to the sentence it came from, and writing a change as a requirement.

What this does NOT do: read the answer key. An uploaded `expected.json` is marked as not used at
ingest and skipped here (SYS-42); the checks read Certivity's copy from `certivity_reference`. It
does not pause for approval either: nothing is submitted, a person downloads and uploads the file
(Clemente, 2026-10-24, SYS-13).
"""

import asyncio
import hashlib
import json
import logging
import re
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any
from uuid import UUID

import httpx
from pydantic_ai.models import Model
from pydantic_ai.usage import RunUsage

from agent_service.domain import paragraphs, regdiff, subgoal_review, subgoal_write
from agent_service.records import CaseFile, Run
from agent_service.store import RunStore

log = logging.getLogger(__name__)

KIND = "subgoal"
# Certivity's schema allows 5,000 changes; requirements in are capped the same way.
MAX_REQUIREMENTS = 5000
# The largest regulation PDF in Certivity's index is about 17 MB; this leaves room and still stops
# a wrong link from filling the function's memory.
MAX_PDF_BYTES = 64 * 1024 * 1024
_FETCH_TIMEOUT_S = 60

FileKind = str  # "requirements", "files", "answer_key", "pdf", or "other"


class SubgoalRefused(Exception):
    """The case cannot be run as it is; the message is for the person and fails the run."""


# ------------------------------------------------------------------------------------------
# What a file is
# ------------------------------------------------------------------------------------------


def json_kind(content: Any) -> FileKind:
    """requirements_old.json is a list of {id, text}; files.json a list of {pdf_url}; Certivity's
    answer key an object with a `changes` list. Anything else is not part of the folder."""
    if isinstance(content, list) and content:
        if all(isinstance(r, dict) and "id" in r and "text" in r for r in content):
            return "requirements"
        if all(isinstance(f, dict) and isinstance(f.get("pdf_url"), str) for f in content):
            return "files"
    if isinstance(content, dict) and isinstance(content.get("changes"), list):
        return "answer_key"
    return "other"


ANSWER_KEY_NOTE = (
    "Certivity's answer key: not given to the run, so the result cannot be tuned to it (SYS-42). "
    "The checks read Certivity's own copy."
)


async def ingest_case(store: RunStore, case_id: UUID) -> dict[str, int]:
    """Mark every pending file of a sub-goal case parsed or failed, saying what it was taken for.

    No model and no content blocks: a sub-goal run reads the files themselves. This replaces the
    main goal's parsing so the case page shows, file by file, what the run will use, and no
    transcription model is paid to read regulation PDFs."""
    counts = {"parsed": 0, "failed": 0}
    for file in await store.case_files(case_id):
        if file.status != "pending" or not await store.set_case_file(
            file.id, "parsing", only_if="pending"
        ):
            continue
        try:
            status, note, pages = await _describe(store, file)
        except Exception as exc:
            log.exception("sub-goal case file %s failed", file.id)
            status, note, pages = "failed", f"{type(exc).__name__}: {exc}"[:2000], None
        if status == "parsed":
            await store.set_case_file(
                file.id, "parsed", only_if="parsing", notes=[note], pages=pages
            )
        else:
            await store.set_case_file(file.id, "failed", only_if="parsing", error=note)
        counts[status] += 1
    return counts


async def _describe(store: RunStore, file: CaseFile) -> tuple[str, str, int | None]:
    if file.format == "pdf":
        data = await store.download(file.storage_path)
        try:
            x = await asyncio.to_thread(paragraphs.extract, data)
        except paragraphs.ExtractionProblem as exc:
            return "failed", f"This PDF could not be read: {exc}", None
        version = f", version {x.version_label}" if x.version_label else ""
        numbered = sum(1 for p in x.paragraphs if p.label)
        return (
            "parsed",
            f"A version of the regulation{version}: {numbered} paragraphs.",
            x.page_count,
        )
    if file.format != "json":
        return "failed", "Not part of a sub-goal folder: only .json and .pdf files are read.", None
    data = await store.download(file.storage_path)
    try:
        content = json.loads(data)
    except (json.JSONDecodeError, UnicodeDecodeError):
        return "failed", "Not valid JSON.", None
    kind = json_kind(content)
    if kind == "requirements":
        cited = regdiff.cited_regulation(content) or "no regulation"
        return "parsed", f"Requirements from the old version: {len(content)}, citing {cited}.", None
    if kind == "files":
        names = ", ".join(str(f.get("name") or f["pdf_url"].rsplit("/", 1)[-1]) for f in content)
        return "parsed", f"Links to the two versions: {names}.", None
    if kind == "answer_key":
        return "failed", ANSWER_KEY_NOTE, None
    return "failed", "Not part of a sub-goal folder (neither requirements nor files.json).", None


# ------------------------------------------------------------------------------------------
# The run
# ------------------------------------------------------------------------------------------


@dataclass
class Inputs:
    requirements: list[dict[str, Any]]
    old_pdf: bytes
    new_pdf: bytes
    old_name: str
    new_name: str
    notes: list[str] = field(default_factory=list)


Step = Callable[[str, dict[str, Any], Callable[[], Awaitable[dict[str, Any]]]], Awaitable[Any]]


@dataclass
class Outcome:
    output: str
    usage: RunUsage


async def execute(
    store: RunStore,
    run: Run,
    *,
    team_id: str,
    case_name: str,
    reviewer: Model | str | None,
    reviewer_note: str | None,
    review: subgoal_review.Limits,
    writer: Model | str | None = None,
    http: Callable[[], httpx.AsyncClient] | None = None,
) -> Outcome:
    """The changes file of the run's sub-goal case. Raises SubgoalRefused with a message for the
    person when the case's files are not a sub-goal folder."""
    assert run.case_id is not None
    case_id = run.case_id
    counter = 0

    async def step(
        name: str, args: dict[str, Any], work: Callable[[], Awaitable[dict[str, Any]]]
    ) -> dict[str, Any]:
        # One call and its result, as a model's tool call is shown: the run page reads it as a
        # step, and a failed step says so where it happened.
        nonlocal counter
        counter += 1
        call_id = f"subgoal-{counter}"
        await store.add_event(
            run.id, "tool_call", {"tool_call_id": call_id, "tool_name": name, "args": args}
        )
        try:
            result = await work()
        except Exception as exc:
            await store.add_event(
                run.id,
                "tool_result",
                {
                    "tool_call_id": call_id,
                    "tool_name": name,
                    "result": f"{type(exc).__name__}: {exc}"[:2000],
                    "is_error": True,
                },
            )
            raise
        await store.add_event(
            run.id,
            "tool_result",
            {
                "tool_call_id": call_id,
                "tool_name": name,
                "result": _summary(result),
                "is_error": False,
            },
        )
        return result

    holder: dict[str, Any] = {}

    async def read() -> dict[str, Any]:
        inputs = await read_inputs(store, case_id, run.organization_id, http or http_client)
        holder["inputs"] = inputs
        return {
            "requirements": len(inputs.requirements),
            "cited_regulation": regdiff.cited_regulation(inputs.requirements),
            "old": inputs.old_name,
            "new": inputs.new_name,
            "notes": inputs.notes,
        }

    await step("read_case", {"case": case_name}, read)
    inputs: Inputs = holder["inputs"]

    async def extract() -> dict[str, Any]:
        try:
            # One after the other, never in parallel: pdfium is not thread-safe, and two
            # documents read at once in two threads broke the production run (Ramón, 2026-10-24).
            old_x = await asyncio.to_thread(paragraphs.extract, inputs.old_pdf)
            new_x = await asyncio.to_thread(paragraphs.extract, inputs.new_pdf)
        except paragraphs.ExtractionProblem as exc:
            raise SubgoalRefused(f"A PDF could not be read: {exc}") from None
        holder["x"] = (old_x, new_x)
        return {
            "old": _described(old_x),
            "new": _described(new_x),
            "warnings": [*old_x.warnings, *new_x.warnings][:10],
        }

    await step("extract_versions", {"old": inputs.old_name, "new": inputs.new_name}, extract)
    old_x, new_x = holder["x"]

    # The regulation's name in the reasons is the one the requirements cite (the index's
    # spelling); each version's label is the one printed in its PDF, as the CLI does.
    regulation = regdiff.cited_regulation(inputs.requirements) or "the regulation"
    old_v = regdiff.build_version(
        regulation, old_x.version_label or "old", [p for p in old_x.paragraphs if p.label]
    )
    new_v = regdiff.build_version(
        regulation, new_x.version_label or "new", [p for p in new_x.paragraphs if p.label]
    )

    async def compare() -> dict[str, Any]:
        changes = await asyncio.to_thread(regdiff.diff_versions, inputs.requirements, old_v, new_v)
        holder["rules"] = changes
        return {
            "counts": _counts(changes),
            "flagged": [c.requirement_id for c in changes if c.requirement_id][:200],
        }

    await step("compare_versions", {"regulation": regulation}, compare)
    rules: list[regdiff.Change] = holder["rules"]

    async def progress(text: str) -> None:
        await store.add_event(run.id, "text", {"text": text})

    usage = RunUsage()
    final = rules
    candidates = subgoal_review.candidates(inputs.requirements, old_v, new_v)
    if not candidates:
        await store.add_event(
            run.id, "text", {"text": "No cited paragraph changed: nothing for the reviewer."}
        )
    elif reviewer is None:
        await store.add_event(
            run.id,
            "text",
            {"text": f"Not reviewed: {reviewer_note or 'no model'}. The rules' answer stands."},
        )
    else:

        async def reviewing() -> dict[str, Any]:
            report = await subgoal_review.review(
                candidates,
                old_v,
                new_v,
                rules,
                reviewer,
                review,
                progress,
                {str(r["id"]): i for i, r in enumerate(inputs.requirements)},
            )
            holder["review"] = report
            return report.summary()

        await step(
            "review_changes",
            {"requirements": len(candidates), "batch_size": review.batch_size},
            reviewing,
        )
        report: subgoal_review.Report = holder["review"]
        final = report.changes
        usage = report.usage

    texts = sum(1 for c in final if c.change != "removed")
    if writer is not None and texts:

        async def writing() -> dict[str, Any]:
            written = await subgoal_write.write(
                final, inputs.requirements, new_v, writer, review, progress
            )
            holder["write"] = written
            return written.summary()

        await step("write_changes", {"changes": texts, "batch_size": review.batch_size}, writing)
        wrote: subgoal_write.Report = holder["write"]
        final = wrote.changes
        usage.incr(wrote.usage)

    submission = regdiff.submission(team_id, case_name, final)
    await store.add_event(
        run.id,
        "text",
        {"text": f"Changes file for {case_name}: {_counts(final)}."},
    )
    return Outcome(json.dumps(submission, indent=2, ensure_ascii=False), usage)


def http_client() -> httpx.AsyncClient:
    return httpx.AsyncClient(timeout=_FETCH_TIMEOUT_S)


def _described(x: paragraphs.Extraction) -> dict[str, Any]:
    return {
        "pages": x.page_count,
        "version": x.version_label,
        "paragraphs": sum(1 for p in x.paragraphs if p.label),
    }


def _counts(changes: list[regdiff.Change]) -> dict[str, int]:
    return {k: sum(c.change == k for c in changes) for k in ("modified", "removed", "added")}


def _summary(result: dict[str, Any]) -> str:
    text = json.dumps(result, ensure_ascii=False)
    return text if len(text) <= 8000 else text[:7999] + "…"


# ------------------------------------------------------------------------------------------
# Reading the case
# ------------------------------------------------------------------------------------------


async def read_inputs(
    store: RunStore,
    case_id: UUID,
    organization_id: UUID,
    http: Callable[[], httpx.AsyncClient],
) -> Inputs:
    files = [f for f in await store.case_files(case_id) if f.status != "failed"]
    if any(f.organization_id != organization_id for f in files):
        raise SubgoalRefused("This case is not in the run's organisation.")
    requirements: list[dict[str, Any]] | None = None
    listing: list[dict[str, Any]] | None = None
    pdfs: list[tuple[CaseFile, bytes]] = []
    notes: list[str] = []
    for f in files:
        if f.format == "pdf":
            pdfs.append((f, await store.download(f.storage_path)))
            continue
        if f.format != "json":
            continue
        try:
            content = json.loads(await store.download(f.storage_path))
        except (json.JSONDecodeError, UnicodeDecodeError):
            notes.append(f"{f.filename}: not valid JSON, skipped.")
            continue
        kind = json_kind(content)
        if kind == "requirements":
            if requirements is not None:
                raise SubgoalRefused(
                    f"Two requirements files ({f.filename} and another). Remove one."
                )
            requirements = content
        elif kind == "files":
            listing = content
        elif kind == "answer_key":
            # Never read further: the run must not see the answer (SYS-42).
            notes.append(f"{f.filename}: an answer key, not used.")
    if requirements is None:
        raise SubgoalRefused(
            "No requirements: add requirements_old.json (a list of { id, text, source })."
        )
    if len(requirements) > MAX_REQUIREMENTS:
        raise SubgoalRefused(f"At most {MAX_REQUIREMENTS} requirements.")

    if len(pdfs) == 2:
        (a, a_pdf), (b, b_pdf) = pdfs
        if _is_newer(a.filename, b.filename, a_pdf, b_pdf):
            (a, a_pdf), (b, b_pdf) = (b, b_pdf), (a, a_pdf)
        return Inputs(requirements, a_pdf, b_pdf, a.filename, b.filename, notes)
    if len(pdfs) > 2:
        raise SubgoalRefused(
            f"The case has {len(pdfs)} PDFs; a sub-goal compares two (old and new). "
            "Remove the others."
        )
    if listing is None:
        raise SubgoalRefused(
            "Need the two versions: add old.pdf and new.pdf, or Certivity's files.json."
        )
    old_entry, new_entry = pair(listing)
    have = {f.filename: data for f, data in pdfs}
    position = max((f.position for f in await store.case_files(case_id)), default=-1) + 1
    fetched: list[bytes] = []
    async with http() as client:
        for entry in (old_entry, new_entry):
            name = str(entry.get("name") or entry["pdf_url"].rsplit("/", 1)[-1])
            data = have.get(name)
            if data is None:
                data = await fetch(client, entry)
                await _keep(store, case_id, organization_id, position, name, data)
                position += 1
                notes.append(
                    f"{name}: fetched from files.json, checksum matches, kept in the case."
                )
            fetched.append(data)
    return Inputs(
        requirements,
        fetched[0],
        fetched[1],
        str(old_entry.get("name")),
        str(new_entry.get("name")),
        notes,
    )


async def _keep(
    store: RunStore, case_id: UUID, org: UUID, position: int, name: str, data: bytes
) -> None:
    # The web's naming ({org}/{case}/{n}-{name}, web/lib/case-files.ts), so the case page lists
    # it and deleting the case deletes it.
    safe = re.sub(r"[^A-Za-z0-9._-]+", "_", name)[:200] or "version.pdf"
    path = f"{org}/{case_id}/{position + 1}-{safe}"
    await store.upload(path, data, "application/pdf")
    await store.store_case_file(
        {
            "case_id": str(case_id),
            "organization_id": str(org),
            "position": position,
            "storage_path": path,
            "filename": name[:255],
            "format": "pdf",
            "media_type": "application/pdf",
            "bytes": len(data),
            "sha256": hashlib.sha256(data).hexdigest(),
            "notes": ["Fetched by the run from files.json; checksum matches."],
        }
    )


def pair(files: list[dict[str, Any]]) -> tuple[dict[str, Any], dict[str, Any]]:
    """old.pdf and new.pdf, by the names Certivity's README gives them; a listing of exactly two
    other files is taken in its order, old first, as files.json lists them."""
    entries = [f for f in files if isinstance(f, dict) and isinstance(f.get("pdf_url"), str)]
    by_name = {f.get("name"): f for f in entries}
    if "old.pdf" in by_name and "new.pdf" in by_name:
        return by_name["old.pdf"], by_name["new.pdf"]
    if len(entries) == 2:
        return entries[0], entries[1]
    raise SubgoalRefused("files.json does not name an old.pdf and a new.pdf.")


async def fetch(http: httpx.AsyncClient, entry: dict[str, Any]) -> bytes:
    url = entry["pdf_url"]
    name = entry.get("name") or url
    # The links come from a file a member uploaded; https only, so a crafted file cannot point
    # the agent at something internal over plain http.
    if not url.startswith("https://"):
        raise SubgoalRefused(f"{name}: only https links are fetched.")
    try:
        response = await http.get(url, follow_redirects=True)
    except httpx.HTTPError as exc:
        raise SubgoalRefused(f"{name} could not be downloaded ({type(exc).__name__}).") from None
    if response.status_code != 200:
        # Certivity's links expire after the hackathon (their README).
        raise SubgoalRefused(
            f"{name} could not be downloaded (HTTP {response.status_code}). Certivity's links "
            "expire after the event: add the PDF to the case instead."
        )
    pdf = response.content
    if len(pdf) > MAX_PDF_BYTES:
        raise SubgoalRefused(f"{name} is larger than 64 MB.")
    expected = entry.get("sha256")
    # The check fetch_regulations.py makes: a file that is not the one listed would give a diff of
    # the wrong document.
    if isinstance(expected, str) and hashlib.sha256(pdf).hexdigest() != expected.lower():
        raise SubgoalRefused(f"{name} does not match the checksum in files.json.")
    return pdf


_OLD_NAME = re.compile(r"(?i)(?:^|[^a-z])(old|base)(?:[^a-z]|$)")
_NEW_NAME = re.compile(r"(?i)(?:^|[^a-z])(new|latest)(?:[^a-z]|$)")


def _version_key(label: str | None) -> tuple[int, ...] | None:
    parts = (label or "").split(".")
    return tuple(int(p) for p in parts) if all(p.isdigit() for p in parts) else None


def _is_newer(first: str, second: str, first_pdf: bytes, second_pdf: bytes) -> bool:
    """Whether the first of two uploaded PDFs is the new version, so the two must swap. Certivity
    names them old.pdf and new.pdf (base and latest in the index); failing that, the version each
    prints in its footer; failing both, upload order, old first."""
    if _OLD_NAME.search(second) and not _OLD_NAME.search(first):
        return True
    if _NEW_NAME.search(first) and not _NEW_NAME.search(second):
        return True
    if _OLD_NAME.search(first) or _NEW_NAME.search(second):
        return False
    a = _version_key(paragraphs.extract(first_pdf).version_label)
    b = _version_key(paragraphs.extract(second_pdf).version_label)
    return a is not None and b is not None and a > b
